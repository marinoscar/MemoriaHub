/**
 * screenshots/events.ts — Typed event contract for the ScreenshotEngine.
 *
 * Mirrors organize/events.ts: the engine emits typed events consumed by
 * renderers (headless CLI or the Ink TUI). The engine itself never touches
 * the terminal.
 */

import { EventEmitter } from 'node:events';
import type { ScreenshotMatch } from './plan.js';

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

export const SCREENSHOTS_EV = {
  PROGRESS: 'screenshots:progress',
  FILE:     'screenshots:file',
  DONE:     'screenshots:done',
  ERROR:    'screenshots:error',
} as const;

export type ScreenshotsEventName = typeof SCREENSHOTS_EV[keyof typeof SCREENSHOTS_EV];

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/** What happened to a single matched file during a screenshots run. */
export type ScreenshotFileAction = 'moved' | 'deleted' | 'skipped' | 'error';

/**
 * Roll-up counters for a screenshots run.
 *
 * `matched`/`bytes` describe every file found (regardless of mode or
 * dry-run). `moved`/`deleted`/`skipped`/`errors` describe the OUTCOME of a
 * real (non-dry-run) `move`/`delete` action pass; they stay at 0 for `find`
 * mode and for any dry-run pass.
 */
export interface ScreenshotTotals {
  matched: number;
  bytes: number;
  moved: number;
  deleted: number;
  skipped: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface ScreenshotsProgressPayload {
  phase: 'scanning' | 'acting';
  processed: number;
  total: number;
}

export interface ScreenshotsFilePayload {
  filePath: string;
  size: number;
  action: ScreenshotFileAction;
  /** Absolute destination path (present for move). */
  target?: string;
  /** Non-null when the file could not be moved/deleted. */
  error?: string;
}

export interface ScreenshotsDonePayload {
  totals: ScreenshotTotals;
  /** Every matched file (not capped — callers decide how much to display). */
  matches: ScreenshotMatch[];
}

export interface ScreenshotsErrorPayload {
  message: string;
}

// ---------------------------------------------------------------------------
// Typed EventEmitter wrapper
// ---------------------------------------------------------------------------

export interface ScreenshotsEngineEvents {
  [SCREENSHOTS_EV.PROGRESS]: (payload: ScreenshotsProgressPayload) => void;
  [SCREENSHOTS_EV.FILE]:     (payload: ScreenshotsFilePayload)     => void;
  [SCREENSHOTS_EV.DONE]:     (payload: ScreenshotsDonePayload)     => void;
  [SCREENSHOTS_EV.ERROR]:    (payload: ScreenshotsErrorPayload)    => void;
}

/**
 * ScreenshotsTypedEmitter — a thin typed wrapper over Node's EventEmitter for
 * the screenshots event set. Provides type-safe on/off/once/emit.
 */
export class ScreenshotsTypedEmitter extends EventEmitter {
  on<K extends ScreenshotsEventName>(event: K, listener: ScreenshotsEngineEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends ScreenshotsEventName>(event: K, listener: ScreenshotsEngineEvents[K]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  once<K extends ScreenshotsEventName>(event: K, listener: ScreenshotsEngineEvents[K]): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends ScreenshotsEventName>(
    event: K,
    payload: Parameters<ScreenshotsEngineEvents[K]>[0],
  ): boolean {
    return super.emit(event, payload);
  }
}
