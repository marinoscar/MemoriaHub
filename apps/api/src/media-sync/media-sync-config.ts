import { isDeepStrictEqual } from 'node:util';

import { Logger } from '@nestjs/common';

import { mediaSyncConfigSchema, type MediaSyncConfig, type UpdateConfigInput } from './dto/media-sync.dto';
import type { MediaSyncCommand } from './media-sync.constants';

// =============================================================================
// Media Sync desired config (epic #498, issue #505): defaults, reading the
// stored JSON, and the pure transitions PATCH /config and /commands apply.
// =============================================================================

const logger = new Logger('MediaSyncConfig');
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The config a newly registered phone starts with. `folders: []` means
 * NOTHING syncs until the user chooses folders, so pairing never triggers a
 * surprise upload of the whole phone.
 */
export function defaultConfig(targetCircleId: string): MediaSyncConfig {
  return {
    targetCircleId,
    folders: [],
    includePhotos: true,
    includeVideos: true,
    network: 'wifi',
    requireCharging: false,
    paused: false,
    uploadExisting: 'all',
    retryFailedGeneration: 0,
    syncNowGeneration: 0,
  };
}

/**
 * Reads `MediaSyncDevice.config`. The column is written only through this
 * module, so it normally parses; a row that does not (hand-edited, or written
 * by a future version with a field this one does not know) degrades to the
 * defaults overlaid with whatever valid fields it carries, never to a 500.
 */
export function readConfig(stored: unknown): MediaSyncConfig {
  const parsed = mediaSyncConfigSchema.safeParse(stored);
  if (parsed.success) return parsed.data;

  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const base = defaultConfig(NIL_UUID);
  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base) as Array<keyof MediaSyncConfig>) {
    const candidate = { ...base, [key]: raw[key] };
    if (raw[key] !== undefined && mediaSyncConfigSchema.safeParse(candidate).success) merged[key] = raw[key];
  }
  logger.warn('A stored media sync config did not parse; fell back to defaults for its invalid fields');
  return mediaSyncConfigSchema.parse(merged);
}

/** The config fields a PATCH may set (everything but `paused` and the generations, which are commands). */
const PATCHABLE_KEYS = [
  'targetCircleId',
  'folders',
  'includePhotos',
  'includeVideos',
  'network',
  'requireCharging',
  'uploadExisting',
] as const satisfies ReadonlyArray<keyof MediaSyncConfig & keyof UpdateConfigInput>;

/** Applies a PATCH; returns the new config and the keys whose value changed. */
export function applyPatch(
  current: MediaSyncConfig,
  patch: UpdateConfigInput,
): { config: MediaSyncConfig; changedKeys: string[] } {
  const next: MediaSyncConfig = { ...current };
  const changedKeys: string[] = [];
  for (const key of PATCHABLE_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!isDeepStrictEqual(current[key], value)) changedKeys.push(key);
    (next as Record<string, unknown>)[key] = value;
  }
  return { config: next, changedKeys };
}

/** Applies a command. Every command produces a new config (and a version bump). */
export function applyCommand(current: MediaSyncConfig, action: MediaSyncCommand): MediaSyncConfig {
  switch (action) {
    case 'pause':
      return { ...current, paused: true };
    case 'resume':
      return { ...current, paused: false };
    case 'retry_failed':
      return { ...current, retryFailedGeneration: current.retryFailedGeneration + 1 };
    case 'sync_now':
      return { ...current, syncNowGeneration: current.syncNowGeneration + 1 };
  }
}
