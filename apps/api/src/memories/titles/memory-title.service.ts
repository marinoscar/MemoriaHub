// =============================================================================
// Memories — AI titles, subtitles & narratives (epic #300, issue #306)
// =============================================================================
//
// Turns a memory the curation engine is about to write into a warm, human
// title + subtitle + narrative, using the admin-selected `ai.features.memories`
// provider and model. Called from `MemoryCurationService.upsertMemory` for new
// memories and for memories whose membership moved materially (>= 30% Jaccard
// distance) — never for a minor refresh, which is what stops every generation
// run from re-paying for a title that is still accurate.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE
// ----------------------------------------
// `generate()` NEVER throws and never blocks generation. It returns
// `MemoryAiTitle` or `null`, and `null` means "write the deterministic
// template". EVERY failure mode resolves to `null`:
//
//   • `memories.aiTitles.enabled` is off        → null, and no provider call
//   • `ai.features.memories` is unset           → null, and no provider call
//   • the provider has no enabled credential    → null
//   • the provider key is not in the registry   → null
//   • the run's backfill budget is spent        → null, and no provider call
//   • an earlier call in this run was throttled → null, and no provider call
//   • HTTP error / network failure              → null
//   • the call exceeds the 10s hard timeout     → null
//   • the response is not JSON, or is JSON of
//     the wrong shape, or has an empty title    → null
//
// Logged at DEBUG, not ERROR: on a deployment with no AI provider configured —
// a supported, documented configuration — falling back is the NORMAL path, and
// logging it as an error would train operators to ignore the log. Templates are
// the permanent floor of the feature, not a broken state (see
// curation/memory-title-templates.ts).
//
// WHY THE PROVIDER IS CALLED OUTSIDE THE WRITE TRANSACTION. A 10-second model
// call inside `upsertMemory`'s `$transaction` would hold row locks and a pool
// connection for the whole call. The facts a prompt needs come from the
// selection the curator already computed, so titling runs entirely BEFORE the
// transaction opens — see MemoryCurationService.
//
// RATE LIMITS STOP THE RUN, THEY DO NOT FAIL THE JOB. A 429/529 sets
// `run.stopped` and every remaining memory in that job is templated. Routing it
// through the enrichment rate-limit-deferral path was explicitly rejected in
// #306: that would defer a whole `memory_generation` job — whose real output is
// the memories — over a cosmetic field.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { MediaTagSource, MemoryType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AiSettingsService } from '../../ai/ai-settings.service';
import { AiProviderRegistry } from '../../ai/providers/ai-provider.registry';
import type { ChatStreamEvent } from '../../ai/providers/ai-provider.interface';
import { classifyRateLimit } from '../../enrichment/rate-limit.error';
import { parseMemoryTitleResponse } from './memory-title.parse';
import {
  MAX_PROMPT_DESCRIPTIONS,
  MAX_PROMPT_PERSON_NAMES,
  MAX_PROMPT_TAGS,
  MEMORY_TITLE_SYSTEM_PROMPT,
  MemoryTitleFacts,
  buildMemoryTitleUserPrompt,
} from './memory-title.prompts';
import { MemoryAiTitle, MemoryTitleRequest, MemoryTitleRun } from './memory-title.types';

/**
 * Hard wall-clock budget for one titling call, per #306.
 *
 * Bounds the WHOLE stream, not each chunk: a provider that dribbles one token
 * every nine seconds is just as effective a stall as one that never answers,
 * and `memory_generation` shares the enrichment worker's slots with real work.
 */
export const MEMORY_TITLE_TIMEOUT_MS = 10_000;

/** Moderate creativity — these are warm titles, not deterministic extraction. */
export const MEMORY_TITLE_TEMPERATURE = 0.7;

/**
 * Ceiling on provider calls during ONE admin backfill job (#306 cost control).
 *
 * A 70k-item library backfill can create thousands of memories in a single job;
 * without this it would fire thousands of model calls in one unattended run.
 * Beyond the cap everything is templated, and the next scheduled run titles
 * more (each run gets a fresh budget), so the library converges instead of
 * billing for itself all at once.
 */
export const BACKFILL_AI_TITLE_CAP = 100;

/**
 * Defensive ceiling on accumulated response text. A well-behaved answer is a
 * few hundred bytes; a model stuck in a repetition loop would otherwise grow an
 * unbounded string inside a worker that is already memory-sensitive.
 */
const MAX_RESPONSE_CHARS = 8_000;

/** Distinguishable from a provider error so the log line can say which. */
class MemoryTitleTimeoutError extends Error {
  constructor(ms: number) {
    super(`Memory title generation exceeded ${ms}ms`);
    this.name = 'MemoryTitleTimeoutError';
  }
}

/**
 * Read a chat stream to completion, bounded by an absolute deadline.
 *
 * Each `next()` is raced against the REMAINING budget rather than a fresh
 * timeout, so the total is bounded even when every individual chunk arrives
 * promptly. On timeout the iterator's `return()` is invoked (fire-and-forget —
 * awaiting it would re-block on the very network call that just stalled) so the
 * underlying generator can release its HTTP connection.
 */
async function collectChatText(
  stream: AsyncIterable<ChatStreamEvent>,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const iterator = stream[Symbol.asyncIterator]();
  let text = '';
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
  };

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new MemoryTitleTimeoutError(timeoutMs);

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new MemoryTitleTimeoutError(timeoutMs)), remaining);
        // Never hold the process (or a Jest run) open on this timer.
        timer.unref?.();
      });

      let step: IteratorResult<ChatStreamEvent>;
      try {
        step = await Promise.race([iterator.next(), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (step.done) break;
      const event = step.value;
      if (event.type === 'text') {
        text += event.text;
        if (text.length > MAX_RESPONSE_CHARS) {
          throw new Error(`Memory title response exceeded ${MAX_RESPONSE_CHARS} characters`);
        }
      } else if (event.type === 'done') {
        break;
      }
    }
  } finally {
    close();
  }

  return text;
}

/** Read a `meta` key as a number, tolerating the JSONB round-trip. */
function metaNumber(meta: Record<string, unknown> | null, key: string): number | null {
  const value = meta?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read a `meta` key as a non-empty string. */
function metaString(meta: Record<string, unknown> | null, key: string): string | null {
  const value = meta?.[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

@Injectable()
export class MemoryTitleService {
  private readonly logger = new Logger(MemoryTitleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiSettings: AiSettingsService,
    private readonly registry: AiProviderRegistry,
  ) {}

  /**
   * Open a per-job budget. Called ONCE by `MemoryGenerationHandler`, carried on
   * `MemoryCuratorContext.titling`, and handed to `upsertMemory` by curators.
   *
   * `aiTitlesEnabled` comes from the settings the handler already resolved for
   * the run, so a disabled feature costs neither a settings read nor a provider
   * call per memory.
   */
  beginRun(options: {
    backfill: boolean;
    aiTitlesEnabled: boolean;
    /**
     * Override for the backfill ceiling (#315). A sharded library backfill
     * divides `BACKFILL_AI_TITLE_CAP` across its shards, because the cap is
     * per JOB and N shards would otherwise multiply the bill by N. Ignored
     * outside backfill, where the budget is deliberately unbounded, and capped
     * at `BACKFILL_AI_TITLE_CAP` so a payload can only ever lower it.
     */
    maxAiCalls?: number;
  }): MemoryTitleRun {
    return {
      enabled: options.aiTitlesEnabled,
      backfill: options.backfill,
      maxAiCalls: options.backfill
        ? Math.min(options.maxAiCalls ?? BACKFILL_AI_TITLE_CAP, BACKFILL_AI_TITLE_CAP)
        : Number.POSITIVE_INFINITY,
      aiCalls: 0,
      stopped: false,
      stopReason: null,
    };
  }

  /**
   * Produce an AI title for one memory, or `null` to use the template.
   *
   * Total by construction — see this file's header for the complete failure
   * list, every entry of which lands on `null`.
   */
  async generate(request: MemoryTitleRequest, run: MemoryTitleRun): Promise<MemoryAiTitle | null> {
    if (!run.enabled || run.stopped) return null;

    if (run.aiCalls >= run.maxAiCalls) {
      // Announce the cap exactly once per run, at the moment it bites.
      if (!run.stopped) {
        run.stopped = true;
        run.stopReason = 'budget_exhausted';
        this.logger.debug(
          `Memory AI titling budget of ${run.maxAiCalls} calls reached for this backfill run; ` +
            'remaining memories use template titles',
        );
      }
      return null;
    }

    const config = await this.aiSettings.resolveMemoriesConfig();
    if (!config) {
      this.logger.debug('No ai.features.memories provider configured; using template titles');
      return null;
    }

    let creds: { apiKey: string; baseUrl?: string };
    try {
      // Throws (400) when the provider row is absent or disabled — exactly the
      // "credential missing/disabled" degradation path.
      creds = await this.aiSettings.resolveCredentials(config.provider);
    } catch (err) {
      this.logger.debug(
        `Memory AI titling: no usable credential for provider "${config.provider}" ` +
          `(${err instanceof Error ? err.message : String(err)}); using template titles`,
      );
      return null;
    }

    let provider;
    try {
      provider = this.registry.get(config.provider);
    } catch (err) {
      this.logger.debug(
        `Memory AI titling: unknown provider "${config.provider}" ` +
          `(${err instanceof Error ? err.message : String(err)}); using template titles`,
      );
      return null;
    }

    let userPrompt: string;
    try {
      const facts = await this.collectFacts(request);
      userPrompt = buildMemoryTitleUserPrompt(facts);
    } catch (err) {
      // A fact lookup is plain SQL against already-known ids; if it fails, the
      // memory itself is still perfectly writable with its template title.
      this.logger.debug(
        `Memory AI titling: failed to assemble prompt facts ` +
          `(${err instanceof Error ? err.message : String(err)}); using template titles`,
      );
      return null;
    }

    // Charged BEFORE the call: an attempt that times out or 500s has cost the
    // provider work and the run wall-clock, so it must consume budget too —
    // otherwise a persistently failing provider would retry uncapped.
    run.aiCalls += 1;

    let raw: string;
    try {
      raw = await collectChatText(
        provider.chat(creds, {
          model: config.model,
          system: MEMORY_TITLE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
          temperature: MEMORY_TITLE_TEMPERATURE,
        }),
        MEMORY_TITLE_TIMEOUT_MS,
      );
    } catch (err) {
      const rateLimit = classifyRateLimit(err);
      if (rateLimit) {
        run.stopped = true;
        run.stopReason = 'rate_limited';
        this.logger.debug(
          `Memory AI titling rate-limited by "${config.provider}" (${rateLimit.message}); ` +
            'remaining memories in this run use template titles',
        );
      } else {
        this.logger.debug(
          `Memory AI titling call failed (${err instanceof Error ? err.message : String(err)}); ` +
            'using template titles',
        );
      }
      return null;
    }

    const parsed = parseMemoryTitleResponse(raw);
    if (!parsed) {
      this.logger.debug(
        `Memory AI titling: unusable response from "${config.provider}"/"${config.model}" ` +
          `(${raw.length} chars); using template titles`,
      );
      return null;
    }

    return {
      title: parsed.title,
      subtitle: parsed.subtitle,
      narrative: parsed.narrative,
      model: config.model,
    };
  }

  /**
   * Assemble the metadata the prompt describes.
   *
   * Three bounded lookups over the memory's OWN item ids (at most
   * `memories.maxItemsPerMemory`, capped at 100 by the settings schema), so
   * these are small `IN (...)` queries, never a library scan. `meta` supplies
   * everything the curator already knew — place, person name, tag, season,
   * years-ago — with no second query to re-derive it.
   */
  private async collectFacts(request: MemoryTitleRequest): Promise<MemoryTitleFacts> {
    const ids = request.mediaItemIds;
    const meta = request.meta ?? null;

    const [tagRows, descriptionRows, faceRows] = await Promise.all([
      ids.length === 0
        ? Promise.resolve([])
        : this.prisma.mediaTag.findMany({
            where: { mediaItemId: { in: ids }, source: MediaTagSource.ai },
            select: { tag: { select: { name: true } } },
          }),
      ids.length === 0
        ? Promise.resolve([])
        : this.prisma.mediaItem.findMany({
            where: { id: { in: ids }, description: { not: null } },
            select: { description: true },
            orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
            take: MAX_PROMPT_DESCRIPTIONS,
          }),
      ids.length === 0
        ? Promise.resolve([])
        : this.prisma.face.findMany({
            where: {
              mediaItemId: { in: ids },
              personId: { not: null },
              // Hiding or deleting a person is an explicit "stop surfacing
              // this"; naming them in a title would defeat that.
              person: { deletedAt: null, hiddenAt: null, mergedIntoId: null },
            },
            select: { person: { select: { name: true } } },
          }),
    ]);

    const tagCounts = new Map<string, number>();
    for (const row of tagRows) {
      const name = row.tag?.name?.trim();
      if (!name) continue;
      tagCounts.set(name, (tagCounts.get(name) ?? 0) + 1);
    }
    const topTags = [...tagCounts.entries()]
      // Count descending, then name ascending — a deterministic order, so the
      // same memory renders the same prompt on every run.
      .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
      .slice(0, MAX_PROMPT_TAGS)
      .map(([name, count]) => ({ name, count }));

    const personNames = [
      ...new Set(
        faceRows
          .map((f) => f.person?.name?.trim())
          .filter((n): n is string => !!n && n.length > 0),
      ),
    ].slice(0, MAX_PROMPT_PERSON_NAMES);

    // The people curators name their subject in `meta`; put them first so the
    // subject of the memory is never crowded out by an incidental bystander.
    const subject = metaString(meta, 'personName');
    if (subject) {
      const rest = personNames.filter((n) => n !== subject);
      personNames.length = 0;
      personNames.push(subject, ...rest.slice(0, MAX_PROMPT_PERSON_NAMES - 1));
    }

    const place =
      metaString(meta, 'locality') || metaString(meta, 'admin1') || metaString(meta, 'country')
        ? {
            locality: metaString(meta, 'locality'),
            admin1: metaString(meta, 'admin1'),
            country: metaString(meta, 'country'),
          }
        : null;

    return {
      type: request.type,
      itemCount: ids.length,
      periodStart: request.periodStart,
      periodEnd: request.periodEnd,
      templateTitle: request.templateTitle,
      templateSubtitle: request.templateSubtitle,
      place,
      personNames,
      topTags,
      descriptions: descriptionRows
        .map((r) => r.description ?? '')
        .filter((d) => d.trim().length > 0),
      yearsAgo: metaNumber(meta, 'yearsAgo'),
      themeTag: request.type === MemoryType.theme ? metaString(meta, 'tag') : null,
      season: metaString(meta, 'season'),
      year: metaNumber(meta, 'year') ?? metaNumber(meta, 'seasonYear'),
    };
  }
}
