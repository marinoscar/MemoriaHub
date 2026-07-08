/**
 * convert/events.ts — Typed event contract for the ConvertEngine.
 *
 * Mirrors organize/events.ts: the engine emits typed events consumed by
 * renderers (headless CLI or the Ink TUI).  The engine itself never touches the
 * terminal.
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

export const CONVERT_EV = {
  CONVERT_PROGRESS: 'convert:progress',
  CONVERT_FILE:     'convert:file',
  CONVERT_DONE:     'convert:done',
  ERROR:            'convert:error',
} as const;

export type ConvertEventName = typeof CONVERT_EV[keyof typeof CONVERT_EV];

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/** What happened to a single file during a convert run. */
export type ConvertAction = 'convert' | 'skip' | 'error';

/** Which ffmpeg path actually produced the output. */
export type ConvertMode = 'remux' | 'reencode';

/**
 * What to do with each source video once its `.mp4` has been written:
 *   'keep'   — leave the original alongside the new .mp4 (default).
 *   'delete' — remove the original after the .mp4 is verified.
 *   'move'   — relocate the original into a chosen folder after the .mp4 is
 *              verified (requires `originalsDir`).
 */
export type OriginalDisposition = 'keep' | 'delete' | 'move';

/** Roll-up counters for a convert run. */
export interface ConvertTotals {
  total: number;
  converted: number;
  skipped: number;
  errors: number;
  /** Originals removed after a successful conversion (disposition 'delete'). */
  deleted: number;
  /** Originals relocated after a successful conversion (disposition 'move'). */
  moved: number;
  /** Split of `converted`: lossless stream-copy remuxes. */
  remuxed: number;
  /** Split of `converted`: full H.264 re-encodes. */
  reencoded: number;
  /** Total source bytes converted (for a space-delta stat). */
  bytesIn: number;
  /** Total output bytes produced. */
  bytesOut: number;
}

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface ConvertProgressPayload {
  processed: number;
  total: number;
}

export interface ConvertFilePayload {
  filePath: string;
  action: ConvertAction;
  /** Output `.mp4` path (present for convert / skip). */
  target?: string;
  /** Which ffmpeg strategy ran (present for a successful convert). */
  mode?: ConvertMode;
  /** True when the original was deleted after a successful convert. */
  deletedOriginal?: boolean;
  /** True when the original was moved after a successful convert. */
  movedOriginal?: boolean;
  /** Destination path the original was moved to (present when movedOriginal). */
  originalMovedTo?: string;
  /** Non-null when the file could not be converted. */
  error?: string;
}

export interface ConvertDonePayload {
  totals: ConvertTotals;
}

export interface ConvertErrorPayload {
  message: string;
}

// ---------------------------------------------------------------------------
// Typed EventEmitter wrapper
// ---------------------------------------------------------------------------

export interface ConvertEngineEvents {
  [CONVERT_EV.CONVERT_PROGRESS]: (payload: ConvertProgressPayload) => void;
  [CONVERT_EV.CONVERT_FILE]:     (payload: ConvertFilePayload)     => void;
  [CONVERT_EV.CONVERT_DONE]:     (payload: ConvertDonePayload)     => void;
  [CONVERT_EV.ERROR]:            (payload: ConvertErrorPayload)    => void;
}

/**
 * ConvertTypedEmitter — a thin typed wrapper over Node's EventEmitter for the
 * convert event set.  Provides type-safe on/off/once/emit.
 */
export class ConvertTypedEmitter extends EventEmitter {
  on<K extends ConvertEventName>(event: K, listener: ConvertEngineEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends ConvertEventName>(event: K, listener: ConvertEngineEvents[K]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  once<K extends ConvertEventName>(event: K, listener: ConvertEngineEvents[K]): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends ConvertEventName>(
    event: K,
    payload: Parameters<ConvertEngineEvents[K]>[0],
  ): boolean {
    return super.emit(event, payload);
  }
}
