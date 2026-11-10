// =============================================================================
// The upload enrichment fan-out registry (RETRO-J5, #613)
// =============================================================================
//
// WHY A REGISTRY. A new media item fans out to a set of enrichment jobs (tagging,
// face detection, burst, duplicate, location inference, social-media detection).
// Each belongs to another slice, so `media` must not import them: the cycle would
// run media -> face -> media. Instead each slice REGISTERS its fan-out here at
// start-up, with the gate that decides whether the job is wanted, and `media`
// walks the registrations when an item is registered.
//
// ORDER AND PRIORITY ARE THE REGISTRATION'S. The registrations run in ascending
// `order` (ties in registration order); the priority of the job each enqueues is
// the registration's own (burst runs at 5 so it claims before duplicate detection,
// which runs at 10). The registry decides neither.
//
// A REGISTRATION NEVER THROWS INTO THE UPLOAD. The service that walks them catches
// the first failure, logs it and stops the fan-out of that item; the upload that
// registered the item has already succeeded.
// =============================================================================

import { Injectable } from '@nestjs/common';

import type { MemoriahubSettingsPort } from '../../ports/index.js';

/**
 * The item an upload fan-out is decided for: the few fields the gates and the
 * enqueues need, no extra database read.
 *
 * @stability experimental
 */
export interface UploadEnrichmentItem {
  /** The media item id. */
  id: string;
  /** `photo` or `video` (the database enum value). */
  type: string;
  /** The owner scope (library) id the item belongs to. */
  circleId: string;
  /** Non-null for a trashed item; the fan-out skips it. */
  deletedAt: Date | null;
}

/**
 * What a registration is given.
 *
 * @stability experimental
 */
export interface UploadEnrichmentContext {
  /** The settings port (reads are cached by the host, so a bulk import reads its flags once). */
  settings: MemoriahubSettingsPort;
}

/**
 * One slice's fan-out of a new media item.
 *
 * @stability experimental
 */
export interface UploadEnrichmentGate {
  /** The media types the registration applies to (`photo`, `video`). */
  mediaTypes: readonly string[];
  /** Ascending run order; 1000 when absent. */
  order?: number;

  /**
   * Whether the job is wanted: `null` to enqueue it, or the reason it is skipped
   * (`feature disabled`, `AUTO_TAG_ENABLED=false`), which is logged.
   *
   * @param item - the item.
   * @param ctx - the context.
   */
  skipReason(item: UploadEnrichmentItem, ctx: UploadEnrichmentContext): Promise<string | null> | string | null;

  /**
   * Enqueues the job (and any status bookkeeping the slice keeps).
   *
   * @param item - the item.
   * @param ctx - the context.
   * @returns a short token for the log line (`job=<id>`).
   */
  enqueue(item: UploadEnrichmentItem, ctx: UploadEnrichmentContext): Promise<string>;

  /**
   * Called instead of `enqueue` when `skipReason` answered a reason, before the skip is
   * logged. A slice whose skip has a fallback (video: no social-media detection means
   * face detection runs directly) does its fallback here.
   *
   * @param item - the item.
   * @param ctx - the context.
   * @param reason - the skip reason.
   */
  onSkipped?(item: UploadEnrichmentItem, ctx: UploadEnrichmentContext, reason: string): Promise<void>;
}

/** One registered fan-out. */
interface Registered {
  type: string;
  gate: UploadEnrichmentGate;
  seq: number;
}

/**
 * The registry of upload fan-outs. Provided by `MediaModule`; a slice injects it and
 * calls {@link UploadEnrichmentRegistry.register} when it starts.
 *
 * @extensionPoint registry
 * @stability experimental
 */
@Injectable()
export class UploadEnrichmentRegistry {
  private readonly entries: Registered[] = [];

  /**
   * Registers the fan-out of one job type. Idempotent per `type`: a second call with the
   * same type replaces the first (a test module restarting a slice must not double it).
   *
   * @param type - the job type (`auto_tagging`), used in the log line and as the identity.
   * @param gate - the gate and the enqueue.
   */
  register(type: string, gate: UploadEnrichmentGate): void {
    const existing = this.entries.findIndex((entry) => entry.type === type);
    const seq = existing >= 0 ? this.entries[existing]!.seq : this.entries.length;
    const entry: Registered = { type, gate, seq };
    if (existing >= 0) this.entries[existing] = entry;
    else this.entries.push(entry);
  }

  /**
   * The registrations that apply to a media type, in run order.
   *
   * @param mediaType - `photo` or `video`.
   */
  forMediaType(mediaType: string): Array<{ type: string; gate: UploadEnrichmentGate }> {
    return this.entries
      .filter((entry) => entry.gate.mediaTypes.includes(mediaType))
      .sort((a, b) => (a.gate.order ?? 1000) - (b.gate.order ?? 1000) || a.seq - b.seq)
      .map(({ type, gate }) => ({ type, gate }));
  }

  /** The registered job types, in registration order. */
  types(): string[] {
    return this.entries.map((entry) => entry.type);
  }
}

/**
 * Registers an upload fan-out. The function form of {@link UploadEnrichmentRegistry.register},
 * for a slice that holds the registry in a provider.
 *
 * @param registry - the registry `MediaModule` provides.
 * @param type - the job type.
 * @param gate - the gate and the enqueue.
 * @stability experimental
 */
export function registerUploadEnrichment(
  registry: UploadEnrichmentRegistry,
  type: string,
  gate: UploadEnrichmentGate,
): void {
  registry.register(type, gate);
}
