/**
 * organize/events.ts — Typed event contract for the OrganizeEngine.
 *
 * Mirrors scan/events.ts: the engine emits typed events consumed by renderers
 * (headless CLI or, elsewhere, an Ink TUI).  The engine itself never touches
 * the terminal.
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

export const ORGANIZE_EV = {
  ORGANIZE_PROGRESS: 'organize:progress',
  ORGANIZE_FILE:     'organize:file',
  ORGANIZE_DONE:     'organize:done',
  ERROR:             'organize:error',
} as const;

export type OrganizeEventName = typeof ORGANIZE_EV[keyof typeof ORGANIZE_EV];

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/** What happened to a single file during an organize run. */
export type OrganizeAction = 'move' | 'skip' | 'conflict-rename' | 'error';

/**
 * Roll-up counters for an organize run.
 *
 * `byBucket` is keyed by the joined bucket path (e.g. `2023/07 - July` or
 * `NODATE`) → number of files routed there.
 */
export interface OrganizeTotals {
  total: number;
  moved: number;
  skipped: number;
  conflicts: number;
  errors: number;
  nodate: number;
  /** Files routed into any `NO-GPS/` folder (missing EXIF GPS location). */
  noGps: number;
  byBucket: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface OrganizeProgressPayload {
  processed: number;
  total: number;
}

export interface OrganizeFilePayload {
  filePath: string;
  bucket: string[];
  action: OrganizeAction;
  /** Absolute destination path (present for move / conflict-rename / skip). */
  target?: string;
  /** Non-null when the file could not be organized. */
  error?: string;
}

export interface OrganizeDonePayload {
  totals: OrganizeTotals;
}

export interface OrganizeErrorPayload {
  message: string;
}

// ---------------------------------------------------------------------------
// Typed EventEmitter wrapper
// ---------------------------------------------------------------------------

export interface OrganizeEngineEvents {
  [ORGANIZE_EV.ORGANIZE_PROGRESS]: (payload: OrganizeProgressPayload) => void;
  [ORGANIZE_EV.ORGANIZE_FILE]:     (payload: OrganizeFilePayload)     => void;
  [ORGANIZE_EV.ORGANIZE_DONE]:     (payload: OrganizeDonePayload)     => void;
  [ORGANIZE_EV.ERROR]:             (payload: OrganizeErrorPayload)    => void;
}

/**
 * OrganizeTypedEmitter — a thin typed wrapper over Node's EventEmitter for the
 * organize event set.  Provides type-safe on/off/once/emit.
 */
export class OrganizeTypedEmitter extends EventEmitter {
  on<K extends OrganizeEventName>(event: K, listener: OrganizeEngineEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends OrganizeEventName>(event: K, listener: OrganizeEngineEvents[K]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  once<K extends OrganizeEventName>(event: K, listener: OrganizeEngineEvents[K]): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends OrganizeEventName>(
    event: K,
    payload: Parameters<OrganizeEngineEvents[K]>[0],
  ): boolean {
    return super.emit(event, payload);
  }
}
