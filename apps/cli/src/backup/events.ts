/**
 * backup/events.ts — Typed event contract for the BackupEngine (issue #316,
 * epic #308).
 *
 * Mirrors node/node-events.ts: the engine emits typed events and renderers
 * (headless printer, `--json` NDJSON, a future TUI) consume them. The engine
 * never touches the terminal.
 */

import { EventEmitter } from 'node:events';

export const BACKUP_EV = {
  RUN_STARTED: 'run-started',
  PAGE_FETCHED: 'page-fetched',
  ITEM_STARTED: 'item-started',
  ITEM_DONE: 'item-done',
  PAGE_COMMITTED: 'page-committed',
  THROTTLE: 'throttle',
  RUN_FINISHED: 'run-finished',
  ERROR: 'error',
} as const;

export type BackupEventName = (typeof BACKUP_EV)[keyof typeof BACKUP_EV];

/**
 * BackupHost-level event name: the host re-emits every engine event as one
 * 'backup-event' emission that the daemon frames for IPC (issue #318). Lives
 * HERE (not in backup-host.ts) so node/daemon.ts can subscribe without a
 * runtime import of the backup engine graph — NodeDashboard imports
 * daemon.ts's readPidFile, and dragging ApiClient/ApiError into that module
 * graph would break every consumer that mocks '../api.js' partially.
 */
export const BACKUP_HOST_EVENT = 'backup-event';

/** Payload of the host's 'backup-event' emission (daemon adds kind + ts). */
export interface BackupHostEventFrame {
  ev: BackupEventName;
  payload: unknown;
}

/** Change-feed keyset cursor, as mirrored in the local catalog checkpoint. */
export interface BackupCursor {
  updatedAt: string;
  id: string;
}

/** Per-item processing outcome. */
export type BackupItemOutcome =
  | 'downloaded'
  | 'sidecar-only'
  | 'tombstone'
  | 'moved'
  | 'failed';

/** Engine-side run statistics (numbers; converted to wire shape at ack time). */
export interface BackupEngineStats {
  itemsDownloaded: number;
  itemsSkipped: number;
  sidecarsWritten: number;
  bytesDownloaded: number;
  errors: number;
}

export function emptyStats(): BackupEngineStats {
  return {
    itemsDownloaded: 0,
    itemsSkipped: 0,
    sidecarsWritten: 0,
    bytesDownloaded: 0,
    errors: 0,
  };
}

export function addStats(into: BackupEngineStats, from: BackupEngineStats): void {
  into.itemsDownloaded += from.itemsDownloaded;
  into.itemsSkipped += from.itemsSkipped;
  into.sidecarsWritten += from.sidecarsWritten;
  into.bytesDownloaded += from.bytesDownloaded;
  into.errors += from.errors;
}

export type BackupRunStatus = 'completed' | 'failed' | 'aborted';

export interface RunStartedPayload {
  runId: string;
  kind: string;
  trigger: string;
}

export interface PageFetchedPayload {
  pageIndex: number;
  /** Items on this page. */
  items: number;
  hasMore: boolean;
}

export interface ItemStartedPayload {
  id: string;
}

export interface ItemDonePayload {
  id: string;
  outcome: BackupItemOutcome;
  /** Bytes downloaded for this item (0 unless outcome is 'downloaded'). */
  bytes: number;
  /** Present when outcome is 'failed'. */
  error?: string;
}

export interface PageCommittedPayload {
  cursor: BackupCursor;
  /** Stats for THIS page only. */
  stats: BackupEngineStats;
}

/** Emitted when the shared cooldown gate engages (429/503/Retry-After). */
export interface ThrottlePayload {
  delayMs: number;
}

export interface RunFinishedPayload {
  status: BackupRunStatus;
  /** Cumulative run totals. */
  stats: BackupEngineStats;
  error?: string;
}

export interface BackupErrorPayload {
  message: string;
}

export interface BackupEngineEvents {
  [BACKUP_EV.RUN_STARTED]: (payload: RunStartedPayload) => void;
  [BACKUP_EV.PAGE_FETCHED]: (payload: PageFetchedPayload) => void;
  [BACKUP_EV.ITEM_STARTED]: (payload: ItemStartedPayload) => void;
  [BACKUP_EV.ITEM_DONE]: (payload: ItemDonePayload) => void;
  [BACKUP_EV.PAGE_COMMITTED]: (payload: PageCommittedPayload) => void;
  [BACKUP_EV.THROTTLE]: (payload: ThrottlePayload) => void;
  [BACKUP_EV.RUN_FINISHED]: (payload: RunFinishedPayload) => void;
  [BACKUP_EV.ERROR]: (payload: BackupErrorPayload) => void;
}

/** A thin typed wrapper over Node's EventEmitter for BackupEngine events. */
export class BackupTypedEmitter extends EventEmitter {
  on<K extends BackupEventName>(event: K, listener: BackupEngineEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends BackupEventName>(event: K, listener: BackupEngineEvents[K]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  once<K extends BackupEventName>(event: K, listener: BackupEngineEvents[K]): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends BackupEventName>(
    event: K,
    payload: Parameters<BackupEngineEvents[K]>[0],
  ): boolean {
    return super.emit(event, payload);
  }
}
