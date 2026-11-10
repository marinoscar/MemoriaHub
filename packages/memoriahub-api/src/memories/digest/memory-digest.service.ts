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
// `NotificationsService.notifyNow` never throws — it returns a result — and a failed
// send is counted and logged, never rethrown. A provider outage must not fail
// the job, because a retry would re-send to everyone the first pass already
// reached. Same contract as the circle-invitation / membership-confirmation
// sends.
// =============================================================================

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { MediaThumbnailService } from '../../media/index.js';
import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_NOTIFY,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubAccessPort,
  type MemoriahubNotifyPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';
import {
  isMemoryHiddenByPreferences,
  resolveMemoryPreferences,
  type MemoriesPreferencesValue,
} from '../api/memory-preferences.js';
import type { MemoriesDb } from '../data/memories-db.js';
import { MemoryType } from '../data/memories-enums.js';
import {
  MEMORIES_EMAIL_READINESS,
  MEMORIES_OPTIONS,
  type MemoriesEmailReadiness,
  type MemoriesHostOptions,
} from '../host/memories-options.js';
import { MemoriesSettingsService, type MemoriesSettingsValue } from '../memories-settings.util.js';
import { DigestTokenService } from './digest-token.util.js';

/**
 * The job type this feature schedules. Permanent: a queued row names its handler by this string.
 *
 * @stability experimental
 */
export const MEMORY_DIGEST_JOB_TYPE = 'memory_digest';

/**
 * The notification event key of the digest e-mail. Persisted on every delivery: never rename it. The
 * host declares the event and its e-mail template (`memory-digest`).
 *
 * @stability experimental
 */
export const MEMORIES_DIGEST_EVENT_KEY = 'memories.digest';

/**
 * One curated memory as rendered in the digest e-mail (epic #300, issue #311). `imageUrl` is an
 * absolute, HMAC-signed public URL rather than a signed storage URL (those expire in 24 hours), or
 * `null` when the memory has no usable cover.
 *
 * @stability experimental
 */
export interface MemoryDigestItemData {
  id: string;
  /** `MemoryType` value, used for the coloured type chip. */
  type: string;
  /** Human label for the chip, e.g. "On this day". */
  typeLabel: string;
  title: string;
  subtitle?: string | null;
  /** AI-written blurb, hero card only. */
  narrative?: string | null;
  itemCount: number;
  imageUrl?: string | null;
  /** Absolute `${APP_URL}/memories/{id}` link. */
  url: string;
}

/**
 * Background priority — never starve upload enrichment (rerun=0, upload=10).
 *
 * @stability experimental
 */
export const MEMORY_DIGEST_PRIORITY = 100;

/**
 * Memories rendered per email: one hero + up to four cards. Matches the
 * template's layout exactly — a sixth would silently vanish.
 *
 * @stability experimental
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

/**
 * Why a deployment-wide gate closed — logged, and asserted in tests.
 *
 * @stability experimental
 */
export type DigestGateReason =
  | 'feature_disabled'
  | 'digest_disabled'
  | 'frequency_off'
  | 'email_unconfigured'
  | 'ok';

/**
 * Deployment-wide gate result, computed once per sweep.
 *
 * @stability experimental
 */
export interface DigestGlobalGate {
  ok: boolean;
  reason: DigestGateReason;
  settings: MemoriesSettingsValue;
}

/**
 * Per-recipient outcome tally for one circle's digest.
 *
 * @stability experimental
 */
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
};

/**
 * The columns {@link MemoryDigestService.loadCandidates} reads of one memory.
 *
 * @stability experimental
 */
export interface DigestCandidateRow {
  id: string;
  type: MemoryType;
  title: string;
  subtitle: string | null;
  narrative: string | null;
  itemCount: number;
  personId: string | null;
  periodStart: Date;
  periodEnd: Date;
  generatedAt: Date;
  coverMediaItem: { id: string; metadata: unknown } | null;
}

type CandidateRow = DigestCandidateRow;

/** A candidate plus the pre-resolved absolute image URL for its cover. */
interface PreparedCandidate {
  row: CandidateRow;
  imageUrl: string | null;
}

/**
 * Loads the new memories of a circle and sends one e-mail per eligible member.
 *
 * @stability experimental
 */
@Injectable()
export class MemoryDigestService {
  private readonly logger = new Logger(MemoryDigestService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: MemoriesDb,
    private readonly memories: MemoriesSettingsService,
    @Inject(MEMORIAHUB_NOTIFY) private readonly notifications: MemoriahubNotifyPort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly userSettings: MemoriahubSettingsPort,
    private readonly thumbnails: MediaThumbnailService,
    @Inject(MEMORIAHUB_ACCESS) private readonly scopes: MemoriahubAccessPort,
    private readonly tokens: DigestTokenService,
    @Inject(MEMORIES_OPTIONS) private readonly options: MemoriesHostOptions,
    @Optional() @Inject(MEMORIES_EMAIL_READINESS) private readonly readiness?: MemoriesEmailReadiness,
  ) {}

  // ===========================================================================
  // Gates
  // ===========================================================================

  /**
   * Evaluate every deployment-wide gate (2–5) against the settings (read here, through the host's
   * cache) and the already-read email readiness ({@link emailReady}). Both the task and the handler
   * call it, so neither can disagree with the other about whether the digest is live.
   *
   * @param emailReady - whether the deployment can deliver mail.
   */
  async evaluateGlobalGate(emailReady: boolean): Promise<DigestGlobalGate> {
    const [enabled, memories] = await Promise.all([this.memories.enabled(), this.memories.resolve()]);

    if (!enabled) {
      return { ok: false, reason: 'feature_disabled', settings: memories };
    }
    if (!memories.digest.enabled) {
      return { ok: false, reason: 'digest_disabled', settings: memories };
    }
    if (memories.digest.frequency === 'off') {
      return { ok: false, reason: 'frequency_off', settings: memories };
    }
    if (!emailReady) {
      return { ok: false, reason: 'email_unconfigured', settings: memories };
    }
    return { ok: true, reason: 'ok', settings: memories };
  }

  /**
   * True when the deployment can actually deliver mail.
   *
   * The host answers (`MEMORIES_EMAIL_READINESS`): in the web edition the email settings are enabled with a
   * provider and a from address, which is exactly the precondition the email
   * channel applies before it sends. A host that gives no answer is taken as ready,
   * and the send itself reports the failure. Checking it up front is what makes "email not
   * configured ⇒ the digest task no-ops and in-app memories are unaffected"
   * (epic failure matrix) true at the CRON level rather than only at the send:
   * without it, a deployment with the feature on but no transport configured
   * would queue a job per circle per period forever, each one doing real query
   * work before discovering it has nowhere to send. Never throws.
   */
  async emailReady(): Promise<boolean> {
    if (!this.readiness) return true;
    try {
      return Boolean(await this.readiness.isReady());
    } catch {
      return false;
    }
  }

  /**
   * The rolling window of a frequency, in milliseconds.
   *
   * @param frequency - the digest frequency.
   */
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
   *
   * READS THE PLATFORM `jobs` TABLE (RETRO-C1 migrated the old rows with their
   * ids, so the history survives the cutover; RETRO-C8, #608, confirmed the
   * query): the circle is the job's subject. A FAILED row is never a watermark.
   *
   * ⚠ KNOWN GAP (RETRO-C8): the platform's `job.history.purge` deletes
   * terminal rows older than `jobs.history.retentionDays` (default 30, minimum
   * 1), and a `monthly` digest needs the row to survive ~30 days. When the
   * window is shorter than the digest cadence the watermark can be purged and
   * the next run behaves as a first-ever digest. This was equally true of the
   * old `job_history_purge`; a dedicated watermark table is a migration-lock
   * follow-up (docs/specs/memories.md §7).
   *
   * @param circleId - the owner scope.
   */
  async lastDigestAt(circleId: string): Promise<Date | null> {
    const last = (await this.prisma.job.findFirst({
      where: {
        type: MEMORY_DIGEST_JOB_TYPE,
        subjectType: 'circle',
        subjectId: circleId,
        status: 'succeeded',
      },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    })) as { finishedAt: Date | null } | null;
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
   *
   * @param circleId - the owner scope.
   * @param since - the watermark, or `null` for a first-ever digest.
   */
  async loadCandidates(circleId: string, since: Date | null): Promise<CandidateRow[]> {
    const now = new Date();
    const rows = (await this.prisma.memory.findMany({
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
    })) as CandidateRow[];

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
   *
   * @param circleId - the owner scope.
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

    const gate = await this.evaluateGlobalGate(await this.emailReady());
    if (!gate.ok) {
      result.skippedReason = 'gate';
      this.logger.debug(
        `memory_digest for circle ${circleId} skipped: ${gate.reason}`,
      );
      return result;
    }

    // Every member, every role: reading a digest needs no write access, so a
    // `viewer` is a legitimate recipient (same audience rationale as
    // `upload_completed` / `memories_ready`, unlike the editor-only review-queue
    // notifications). Groups and personal libraries both come through the scope
    // directory (RETRO-K1): no read of `circles` / `circle_members`.
    const summary = await this.scopes.scopeSummary(circleId);
    const scopeMembers = summary ? await this.scopes.membersOf(circleId) : [];
    if (!summary || scopeMembers.length === 0) {
      result.skippedReason = 'no_circle';
      return result;
    }
    const names = await this.scopes.userNames(scopeMembers.map((m) => m.userId));
    const circle = {
      name: summary.name,
      members: scopeMembers
        .filter((m) => names.has(m.userId))
        .map((m) => ({
          user: { id: m.userId, email: names.get(m.userId)!.email, displayName: names.get(m.userId)!.name },
        })),
    };
    if (circle.members.length === 0) {
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

      // The `memories.digest` event (email only, bound to the `memory-digest`
      // template) through the platform dispatcher, awaited so the job's tally is
      // per recipient. The dispatcher applies the user's own preference for the
      // event on top of `emailDigestOptOut` above; it never throws.
      const sendResult = await this.notifications.notifyNow(MEMORIES_DIGEST_EVENT_KEY, user.id, {
        circleName: circle.name,
        recipientName: user.displayName,
        memories: visible.map((c) => this.toItemData(c, appUrl)),
        memoriesUrl,
        // Per-RECIPIENT: the token embeds this user's id, which is exactly why
        // the List-Unsubscribe header is a per-message property rather than
        // provider configuration.
        unsubscribeUrl: this.unsubscribeUrl(appUrl, user.id),
      });

      if (sendResult.rateLimited) {
        result.failed += 1;
      } else {
        result.sent += 1;
      }
    }

    return result;
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** Base URL for absolute links: the host's, else the `APP_URL` variable, else the dev default. */
  private appUrl(): string {
    const configured = this.options.digest.appUrl?.() ?? process.env['APP_URL'];
    return (configured || 'http://localhost:3535').replace(/\/+$/, '');
  }

  /** Absolute, login-free, HMAC-signed unsubscribe URL for one user. */
  private unsubscribeUrl(appUrl: string, userId: string): string {
    return `${appUrl}/api/public/memories/digest-unsubscribe/${this.tokens.signUnsubscribe(userId)}`;
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
            ? `${appUrl}/api/public/memories/digest-image/${this.tokens.signImage(coverId, ttlDays)}`
            : null,
      };
    });
  }

  /**
   * Read every recipient's `user_settings.memories` namespace through the settings port.
   *
   * A user whose read fails (or has no preference stored) resolves to "no preference", which
   * over-shows rather than failing the send; the failure is logged once for the whole circle.
   */
  private async loadPreferences(userIds: string[]) {
    const map = new Map<string, ReturnType<typeof resolveMemoryPreferences>>();
    if (userIds.length === 0) return map;

    let failed = 0;
    await Promise.all(
      userIds.map(async (userId) => {
        try {
          const stored = await this.userSettings.readUser<MemoriesPreferencesValue | undefined>(userId, 'memories');
          map.set(userId, resolveMemoryPreferences(stored));
        } catch {
          failed += 1;
        }
      }),
    );
    if (failed > 0) {
      this.logger.warn(
        `Failed to read the memory preferences of ${failed} digest recipient(s); sending them unfiltered`,
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
