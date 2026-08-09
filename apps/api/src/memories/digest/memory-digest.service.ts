// =============================================================================
// Memory Digest Service (epic #300, issue #311)
// =============================================================================
//
// Owns BOTH halves of the digest: deciding which circles are due (driven by the
// hourly `MemoryDigestTask` cron) and actually rendering + sending one circle's
// digest (driven by the `memory_digest` enrichment handler). They live together
// because they share the same gate stack and the same "is there new content?"
// watermark query, and two copies of that logic would drift the moment one of
// them gained a condition.
//
// -----------------------------------------------------------------------------
// THE GATE STACK — evaluated in this order, cheapest first
// -----------------------------------------------------------------------------
//   1. `MEMORIES_ENABLED=false`               env kill-switch (task only)
//   2. `features.memories`                    global feature flag
//   3. `memories.digest.enabled`              admin global kill for the digest
//   4. `memories.digest.frequency !== 'off'`  per-deployment cadence
//   5. email configured AND `email.enabled`   nothing to send through
//   6. current UTC hour >= `sendHourUtc`      don't mail people at 03:00
//   7. frequency window elapsed since the last SUCCEEDED `memory_digest` job
//   8. >= 1 memory created or refreshed since that watermark
//
// Gates 1–5 are deployment-wide and are read ONCE per sweep through the cached
// `getSettings()`, so a 500-circle deployment with the digest off pays one
// settings read and returns. Gates 6–8 are per circle.
//
// GATE 8 IS THE HARD ONE, and the epic states it as an absolute: **no new
// content ⇒ no email, ever**. A weekly digest that arrives every week saying
// nothing new happened is the single fastest way to train a family to filter
// the sender. It is enforced TWICE — once here when choosing due circles, and
// again inside the handler at send time — because the two happen minutes apart
// and a memory can be deleted (tombstoned) in between, and because a job can be
// retried by hand from /admin/settings/jobs long after the cron's check.
//
// -----------------------------------------------------------------------------
// WHY PER-RECIPIENT RENDERING
// -----------------------------------------------------------------------------
// One broadcast email per circle would be cheaper and is wrong: each member has
// their OWN `user_settings.memories` preferences (hidden people, sensitive date
// ranges) and their OWN `emailDigestOptOut`. Those are read-time filters (see
// api/memory-preferences.ts — the same helper the HTTP surface uses, reused here
// rather than reimplemented), so the only way to honour them is to build the
// list per recipient. A recipient whose filtered list comes back EMPTY is
// skipped entirely: an email that shows them nothing is worse than no email.
//
// -----------------------------------------------------------------------------
// FIRE-AND-FORGET SENDS
// -----------------------------------------------------------------------------
// `EmailService.sendEmail` never throws — it returns a result — and a failed
// send is counted and logged, never rethrown. A provider outage must not fail
// the job, because a retry would re-send to everyone the first pass already
// reached. Same contract as the circle-invitation / membership-confirmation
// sends.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { JobStatus, MemoryType, Prisma } from '@prisma/client';

import { EmailService } from '../../email/email.service';
import { MediaThumbnailService } from '../../media/media-thumbnail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import {
  MemoriesPreferencesValue,
  MemoriesSettingsValue,
  SystemSettingsValue,
  UserSettingsValue,
  isMemoriesEnabled,
} from '../../common/types/settings.types';
import { MemoryDigestItemData } from '../../email/types/email.types';
import {
  isMemoryHiddenByPreferences,
  resolveMemoryPreferences,
} from '../api/memory-preferences';
import { resolveMemoriesSettings } from '../memories-settings.util';
import {
  signDigestImageToken,
  signDigestUnsubscribeToken,
} from './digest-token.util';

/** The enrichment job type this feature schedules. */
export const MEMORY_DIGEST_JOB_TYPE = 'memory_digest';

/** Background priority — never starve upload enrichment (rerun=0, upload=10). */
export const MEMORY_DIGEST_PRIORITY = 100;

/**
 * Memories rendered per email: one hero + up to four cards. Matches the
 * template's layout exactly — a sixth would silently vanish.
 */
export const DIGEST_MEMORY_LIMIT = 5;

/**
 * Candidates loaded before per-recipient filtering. Larger than
 * DIGEST_MEMORY_LIMIT so a member with several hidden people still gets a full
 * email instead of a short one, and bounded so a backfill that created hundreds
 * of memories does not pull them all into memory. One read for the whole circle.
 */
const DIGEST_CANDIDATE_LIMIT = 25;

/** Frequency → rolling window, in hours. `off` never reaches here. */
const FREQUENCY_HOURS: Record<'daily' | 'weekly' | 'monthly', number> = {
  daily: 24,
  weekly: 24 * 7,
  monthly: 24 * 30,
};

/**
 * Slack subtracted from the frequency window, in hours.
 *
 * Without it the digest drifts an hour later every period: a run that finished
 * at 08:00:30 is not yet 24h old when the next day's 08:00:10 tick evaluates it,
 * so it slips to 09:00, then 10:00. One cron period of tolerance pins the send
 * to its intended hour. It can never cause a double-send, because the send-hour
 * gate already allows at most one qualifying window per day and gate 8 requires
 * new content that the previous send consumed.
 */
const WINDOW_TOLERANCE_HOURS = 1;

/** Human labels for the coloured type chip. Mirrors the web's typeMeta map. */
const TYPE_LABELS: Record<MemoryType, string> = {
  on_this_day: 'On this day',
  trip: 'Trip',
  person_highlights: 'People',
  person_over_years: 'Through the years',
  theme: 'Theme',
  seasonal: 'Season',
  year_in_review: 'Year in review',
};

/** Why a deployment-wide gate closed — logged, and asserted in tests. */
export type DigestGateReason =
  | 'feature_disabled'
  | 'digest_disabled'
  | 'frequency_off'
  | 'email_unconfigured'
  | 'ok';

/** Deployment-wide gate result, computed once per sweep. */
export interface DigestGlobalGate {
  ok: boolean;
  reason: DigestGateReason;
  settings: MemoriesSettingsValue;
}

/** Per-recipient outcome tally for one circle's digest. */
export interface DigestSendResult {
  candidates: number;
  recipients: number;
  sent: number;
  skippedOptOut: number;
  skippedEmpty: number;
  skippedNoEmail: number;
  failed: number;
  /** Set when the run stopped before looking at recipients. */
  skippedReason?: 'gate' | 'no_new_content' | 'no_circle';
}

const CANDIDATE_SELECT = {
  id: true,
  type: true,
  title: true,
  subtitle: true,
  narrative: true,
  itemCount: true,
  personId: true,
  periodStart: true,
  periodEnd: true,
  generatedAt: true,
  coverMediaItem: { select: { id: true, metadata: true } },
} satisfies Prisma.MemorySelect;

type CandidateRow = Prisma.MemoryGetPayload<{ select: typeof CANDIDATE_SELECT }>;

/** A candidate plus the pre-resolved absolute image URL for its cover. */
interface PreparedCandidate {
  row: CandidateRow;
  imageUrl: string | null;
}

@Injectable()
export class MemoryDigestService {
  private readonly logger = new Logger(MemoryDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly email: EmailService,
    private readonly thumbnails: MediaThumbnailService,
  ) {}

  // ===========================================================================
  // Gates
  // ===========================================================================

  /**
   * Evaluate every deployment-wide gate (2–5) against an already-read settings
   * blob. Pure, so both the task and the handler can call it and neither can
   * disagree with the other about whether the digest is live.
   */
  evaluateGlobalGate(settings: SystemSettingsValue): DigestGlobalGate {
    const memories = resolveMemoriesSettings(settings.memories);

    if (!isMemoriesEnabled(settings)) {
      return { ok: false, reason: 'feature_disabled', settings: memories };
    }
    if (!memories.digest.enabled) {
      return { ok: false, reason: 'digest_disabled', settings: memories };
    }
    if (memories.digest.frequency === 'off') {
      return { ok: false, reason: 'frequency_off', settings: memories };
    }
    if (!this.emailConfigured(settings)) {
      return { ok: false, reason: 'email_unconfigured', settings: memories };
    }
    return { ok: true, reason: 'ok', settings: memories };
  }

  /**
   * True when the deployment can actually deliver mail.
   *
   * Mirrors `EmailService.sendEmail`'s own precondition exactly. Checking it up
   * front is what makes "email not configured ⇒ the digest task no-ops and
   * in-app memories are unaffected" (epic failure matrix) true at the CRON
   * level rather than only at the send: without it, a deployment with the
   * feature on but no SMTP configured would queue a job per circle per period
   * forever, each one doing real query work before discovering it has nowhere
   * to send.
   */
  private emailConfigured(settings: SystemSettingsValue): boolean {
    const email = settings.email;
    return Boolean(email && email.enabled && email.provider && email.fromAddress);
  }

  /** Rolling window for a frequency, minus the one-tick tolerance. */
  windowMs(frequency: 'daily' | 'weekly' | 'monthly'): number {
    const hours = FREQUENCY_HOURS[frequency] - WINDOW_TOLERANCE_HOURS;
    return hours * 3_600_000;
  }

  // ===========================================================================
  // Watermark + candidates
  // ===========================================================================

  /**
   * `finishedAt` of the most recent SUCCEEDED `memory_digest` job for a circle,
   * or `null` when the circle has never had one.
   *
   * The currently-running job is `running`, not `succeeded`, so it can never be
   * its own watermark — which is what lets the handler re-derive the same
   * boundary the task used without any state passed through the payload.
   */
  async lastDigestAt(circleId: string): Promise<Date | null> {
    const last = await this.prisma.enrichmentJob.findFirst({
      where: {
        type: MEMORY_DIGEST_JOB_TYPE,
        circleId,
        status: JobStatus.succeeded,
      },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    });
    return last?.finishedAt ?? null;
  }

  /**
   * The circle's newest memories since the watermark, hero-ordered.
   *
   * "New content" means created OR materially refreshed — a trip that grew from
   * 40 photos to 120 because the user finally uploaded the rest of the holiday
   * is genuinely worth re-surfacing, and `refreshedAt` is the only signal for
   * it. A first-ever digest (no watermark) takes the newest memories outright.
   *
   * `on_this_day` sorts FIRST regardless of `generatedAt`: it is the one type
   * anchored to today, so it is both the most likely thing the reader wants and
   * the strongest subject line (see `memoryDigestSubject`). Ordering happens in
   * memory over an already-bounded page rather than as a SQL CASE, since the
   * index that serves this query orders by `generatedAt`.
   */
  async loadCandidates(circleId: string, since: Date | null): Promise<CandidateRow[]> {
    const now = new Date();
    const rows = await this.prisma.memory.findMany({
      where: {
        circleId,
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        ...(since
          ? {
              AND: [
                {
                  OR: [
                    { generatedAt: { gt: since } },
                    { refreshedAt: { gt: since } },
                  ],
                },
              ],
            }
          : {}),
      },
      select: CANDIDATE_SELECT,
      orderBy: { generatedAt: 'desc' },
      take: DIGEST_CANDIDATE_LIMIT,
    });

    return rows.sort((a, b) => {
      const aAnchor = a.type === MemoryType.on_this_day ? 0 : 1;
      const bAnchor = b.type === MemoryType.on_this_day ? 0 : 1;
      if (aAnchor !== bAnchor) return aAnchor - bAnchor;
      return b.generatedAt.getTime() - a.generatedAt.getTime();
    });
  }

  // ===========================================================================
  // Send
  // ===========================================================================

  /**
   * Render and send one circle's digest, one email per eligible recipient.
   *
   * Never throws for a per-recipient problem: a missing email address, a
   * malformed preferences blob, or a provider failure is counted and the loop
   * continues. The only exceptions that escape are infrastructure ones (the
   * circle read itself failing), which SHOULD fail the job so it retries.
   */
  async sendForCircle(circleId: string): Promise<DigestSendResult> {
    const result: DigestSendResult = {
      candidates: 0,
      recipients: 0,
      sent: 0,
      skippedOptOut: 0,
      skippedEmpty: 0,
      skippedNoEmail: 0,
      failed: 0,
    };

    const settings = await this.systemSettings.getSettings();
    const gate = this.evaluateGlobalGate(settings);
    if (!gate.ok) {
      result.skippedReason = 'gate';
      this.logger.debug(
        `memory_digest for circle ${circleId} skipped: ${gate.reason}`,
      );
      return result;
    }

    const circle = await this.prisma.circle.findUnique({
      where: { id: circleId },
      select: {
        name: true,
        // Every member, every per-circle role: reading a digest needs no write
        // access, so a `viewer` is a legitimate recipient. Same audience
        // rationale as `upload_completed` / `memories_ready`, and deliberately
        // unlike the collaborator-only review-queue notifications.
        members: {
          select: {
            user: { select: { id: true, email: true, displayName: true } },
          },
        },
      },
    });
    if (!circle || circle.members.length === 0) {
      result.skippedReason = 'no_circle';
      return result;
    }

    const since = await this.lastDigestAt(circleId);
    const candidates = await this.loadCandidates(circleId, since);
    result.candidates = candidates.length;

    // GATE 8, re-checked at send time. See the file header for why it is
    // enforced in both places.
    if (candidates.length === 0) {
      result.skippedReason = 'no_new_content';
      return result;
    }

    const prepared = await this.prepareCandidates(
      candidates,
      gate.settings.digest.imageTokenTtlDays,
    );

    const appUrl = this.appUrl();
    const memoriesUrl = `${appUrl}/memories`;
    const preferences = await this.loadPreferences(
      circle.members.map((m) => m.user.id),
    );

    for (const member of circle.members) {
      const user = member.user;
      result.recipients += 1;

      if (!user.email) {
        result.skippedNoEmail += 1;
        continue;
      }

      const prefs = preferences.get(user.id) ?? resolveMemoryPreferences(null);
      if (prefs.emailDigestOptOut) {
        result.skippedOptOut += 1;
        continue;
      }

      const visible = prepared
        .filter((c) => !isMemoryHiddenByPreferences(c.row, prefs))
        .slice(0, DIGEST_MEMORY_LIMIT);

      // Everything this member could have seen is hidden by their own
      // preferences. Sending an empty shell would be worse than silence.
      if (visible.length === 0) {
        result.skippedEmpty += 1;
        continue;
      }

      const sendResult = await this.email.sendEmail(user.email, 'memory-digest', {
        circleName: circle.name,
        recipientName: user.displayName,
        memories: visible.map((c) => this.toItemData(c, appUrl)),
        memoriesUrl,
        // Per-RECIPIENT: the token embeds this user's id, which is exactly why
        // the List-Unsubscribe header is a per-message property rather than
        // provider configuration.
        unsubscribeUrl: this.unsubscribeUrl(appUrl, user.id),
      });

      if (sendResult.success) {
        result.sent += 1;
      } else {
        result.failed += 1;
      }
    }

    return result;
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** Base URL for absolute links. Same mechanism as the invite emails. */
  private appUrl(): string {
    return (process.env['APP_URL'] || 'http://localhost:3535').replace(/\/+$/, '');
  }

  /** Absolute, login-free, HMAC-signed unsubscribe URL for one user. */
  private unsubscribeUrl(appUrl: string, userId: string): string {
    return `${appUrl}/api/public/memories/digest-unsubscribe/${signDigestUnsubscribeToken(
      userId,
    )}`;
  }

  /**
   * Attach a long-lived signed image URL to each candidate, ONCE for the whole
   * circle rather than per recipient — the token is a capability over the media
   * item, not over the reader, so every recipient gets the same URL and the
   * per-recipient loop stays free of crypto.
   *
   * A cover with no thumbnail yet yields `null` and the template renders its
   * same-size gradient placeholder, so a still-processing cover cannot shuffle
   * the layout.
   */
  private async prepareCandidates(
    rows: CandidateRow[],
    ttlDays: number,
  ): Promise<PreparedCandidate[]> {
    const keys = new Map<string, string>();
    for (const row of rows) {
      const cover = row.coverMediaItem;
      if (!cover) continue;
      const key = this.thumbnails.extractThumbKey(cover.metadata);
      if (key) keys.set(cover.id, key);
    }

    const appUrl = this.appUrl();
    return rows.map((row) => {
      const coverId = row.coverMediaItem?.id;
      const hasThumb = coverId ? keys.has(coverId) : false;
      return {
        row,
        imageUrl:
          coverId && hasThumb
            ? `${appUrl}/api/public/memories/digest-image/${signDigestImageToken(
                coverId,
                ttlDays,
              )}`
            : null,
      };
    });
  }

  /**
   * Batch-read every recipient's `user_settings.memories` namespace.
   *
   * ONE `findMany` for the whole circle rather than one read per member — the
   * same batching #246's reconcile does before fanning out across a membership.
   * A user with no settings row (or an unparseable blob) resolves to "no
   * preference", which over-shows rather than failing the send.
   */
  private async loadPreferences(userIds: string[]) {
    const map = new Map<string, ReturnType<typeof resolveMemoryPreferences>>();
    if (userIds.length === 0) return map;

    try {
      const rows = await this.prisma.userSettings.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, value: true },
      });
      for (const row of rows) {
        const value = row.value as unknown as UserSettingsValue | undefined;
        map.set(
          row.userId,
          resolveMemoryPreferences(
            value?.memories as MemoriesPreferencesValue | undefined,
          ),
        );
      }
    } catch (err) {
      this.logger.warn(
        'Failed to batch-read memory preferences for digest; sending unfiltered: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    return map;
  }

  /** Project one prepared candidate into the template's item payload. */
  private toItemData(candidate: PreparedCandidate, appUrl: string): MemoryDigestItemData {
    const row = candidate.row;
    return {
      id: row.id,
      type: row.type,
      typeLabel: TYPE_LABELS[row.type] ?? 'Memory',
      title: row.title,
      subtitle: row.subtitle,
      narrative: row.narrative,
      itemCount: row.itemCount,
      imageUrl: candidate.imageUrl,
      url: `${appUrl}/memories/${row.id}`,
    };
  }
}
