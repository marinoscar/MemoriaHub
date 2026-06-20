/**
 * sync/events.ts — Typed event contract for the SyncEngine.
 *
 * All events are emitted by SyncEngine and consumed by renderers / callers.
 * The engine itself never touches the terminal — only event consumers do.
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

export const EV = {
  RUN_START:      'run:start',
  FOLDER_START:   'folder:start',
  FILE_QUEUED:    'file:queued',
  FILE_START:     'file:start',
  FILE_PROGRESS:  'file:progress',
  FILE_SKIPPED:   'file:skipped',
  FILE_DONE:      'file:done',
  FILE_FAILED:    'file:failed',
  FOLDER_DONE:    'folder:done',
  RUN_PROGRESS:   'run:progress',
  RUN_DONE:       'run:done',
  RATE_LIMITED:   'rate:limited',
  ERROR:          'error',
} as const;

export type EventName = typeof EV[keyof typeof EV];

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface RunStartPayload {
  runId: number;
  folderIds: number[];
  total: number;
  dryRun: boolean;
}

export interface FolderStartPayload {
  folderId: number;
  path: string;
  fileCount: number;
}

export interface FileQueuedPayload {
  fileId: number;
  path: string;
}

export interface FileStartPayload {
  fileId: number;
  path: string;
  sizeBytes: number | null;
}

export interface FileProgressPayload {
  fileId: number;
  fraction: number;
}

export interface FileSkippedPayload {
  fileId: number;
  path: string;
  reason: 'dedup' | 'unchanged';
}

export interface FileDonePayload {
  fileId: number;
  path: string;
  mediaItemId: string;
  storageObjectId: string;
  /** true when this is a dry-run "would-upload" synthetic event */
  dryRun?: boolean;
}

export interface FileFailedPayload {
  fileId: number;
  path: string;
  error: string;
  attempt: number;
  willRetry: boolean;
}

export interface FolderStats {
  uploaded: number;
  skipped: number;
  failed: number;
}

export interface FolderDonePayload {
  folderId: number;
  stats: FolderStats;
}

export interface RunProgressCounts {
  queued: number;
  uploading: number;
  uploaded: number;
  skipped: number;
  failed: number;
}

export interface RunProgressPayload {
  counts: RunProgressCounts;
  total: number;
}

export interface RunStats {
  uploaded: number;
  skipped: number;
  failed: number;
}

export interface RunDonePayload {
  runId: number;
  stats: RunStats;
  durationMs: number;
}

export interface RateLimitedPayload {
  /** Length (ms) of the global cooldown window the gate just opened. */
  delayMs: number;
}

export interface ErrorPayload {
  message: string;
}

// ---------------------------------------------------------------------------
// Typed EventEmitter wrapper
// ---------------------------------------------------------------------------

export interface SyncEngineEvents {
  [EV.RUN_START]:     (payload: RunStartPayload)     => void;
  [EV.FOLDER_START]:  (payload: FolderStartPayload)  => void;
  [EV.FILE_QUEUED]:   (payload: FileQueuedPayload)   => void;
  [EV.FILE_START]:    (payload: FileStartPayload)    => void;
  [EV.FILE_PROGRESS]: (payload: FileProgressPayload) => void;
  [EV.FILE_SKIPPED]:  (payload: FileSkippedPayload)  => void;
  [EV.FILE_DONE]:     (payload: FileDonePayload)     => void;
  [EV.FILE_FAILED]:   (payload: FileFailedPayload)   => void;
  [EV.FOLDER_DONE]:   (payload: FolderDonePayload)   => void;
  [EV.RUN_PROGRESS]:  (payload: RunProgressPayload)  => void;
  [EV.RUN_DONE]:      (payload: RunDonePayload)      => void;
  [EV.RATE_LIMITED]:  (payload: RateLimitedPayload)  => void;
  [EV.ERROR]:         (payload: ErrorPayload)        => void;
}

/**
 * TypedEmitter — a thin typed wrapper over Node's EventEmitter.
 * Provides type-safe `on`, `off`, and `emit` for all engine events.
 */
export class TypedEmitter extends EventEmitter {
  on<K extends EventName>(event: K, listener: SyncEngineEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends EventName>(event: K, listener: SyncEngineEvents[K]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  once<K extends EventName>(event: K, listener: SyncEngineEvents[K]): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends EventName>(event: K, payload: Parameters<SyncEngineEvents[K]>[0]): boolean {
    return super.emit(event, payload);
  }
}
