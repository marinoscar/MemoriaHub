import { Inject, Injectable, Logger } from '@nestjs/common';

import { MEMORIAHUB_SETTINGS, type MemoriahubSettingsPort } from '../../ports/index.js';
import {
  UploadEnrichmentRegistry,
  type UploadEnrichmentContext,
  type UploadEnrichmentItem,
} from './upload-enrichment.registry.js';

/**
 * Walks the registered fan-outs for a newly registered media item.
 *
 * Called synchronously from the upload path (awaited), so every enrichment job row
 * exists before the upload's response, whichever client (CLI, web, Android) and
 * whatever timing performed the upload. Soft-deleted items are skipped, other media
 * types are silently skipped, and a failure is logged and never rethrown: enrichment
 * must not fail the parent create.
 *
 * @stability experimental
 */
@Injectable()
export class UploadEnrichmentService {
  private readonly logger = new Logger(UploadEnrichmentService.name);

  constructor(
    private readonly registry: UploadEnrichmentRegistry,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
  ) {}

  /**
   * Enqueues every upload-time enrichment job the registered slices want for the item.
   *
   * @param item - the item's own fields.
   */
  async enqueueUploadEnrichment(item: UploadEnrichmentItem): Promise<void> {
    try {
      if (item.deletedAt) {
        this.logger.debug(`MediaItem ${item.id} is deleted; skipping upload enrichment`);
        return;
      }

      const ctx: UploadEnrichmentContext = { settings: memoizedForOneUpload(this.settings) };
      const enqueued: string[] = [];
      const skipped: string[] = [];

      for (const { type, gate } of this.registry.forMediaType(item.type)) {
        const reason = await gate.skipReason(item, ctx);
        if (reason === null) {
          const token = await gate.enqueue(item, ctx);
          enqueued.push(`${type}(${token})`);
        } else {
          if (gate.onSkipped) await gate.onSkipped(item, ctx, reason);
          skipped.push(`${type}(${reason})`);
        }
      }

      this.logger.log(
        `MediaItem ${item.id} (${item.type}) upload enrichment: enqueued=[${enqueued.join(', ') || 'none'}] skipped=[${skipped.join(', ') || 'none'}]`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`UploadEnrichmentService.enqueueUploadEnrichment failed for MediaItem ${item.id}: ${message}`);
      // Never rethrow — enrichment failure must not fail the parent create.
    }
  }
}

/**
 * The settings port with `readSystem` memoised for ONE upload: six gates reading the same
 * `features` namespace read it once, so a bulk import costs one settings read per file (and the
 * host's few-seconds cache makes it one per few seconds).
 */
function memoizedForOneUpload(port: MemoriahubSettingsPort): MemoriahubSettingsPort {
  const reads = new Map<string, Promise<unknown>>();
  return {
    registerNamespace: (def) => port.registerNamespace(def),
    readSystem: <T>(name: string) => {
      let read = reads.get(name);
      if (!read) {
        read = port.readSystem<T>(name);
        reads.set(name, read);
      }
      return read as Promise<{ value: T; version: number }>;
    },
    patchSystem: (name, patch, ctx) => port.patchSystem(name, patch, ctx),
    readUser: (userId, name) => port.readUser(userId, name),
    patchUser: (userId, name, patch) => port.patchUser(userId, name, patch),
    readUserTimeZone: (userId) => port.readUserTimeZone(userId),
  };
}
