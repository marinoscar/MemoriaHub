/**
 * date-inference/events.ts — Typed event contract for the DateInferenceEngine.
 *
 * Mirrors organize/events.ts: the engine emits typed events consumed by
 * renderers (headless CLI or an Ink TUI). The engine itself never touches the
 * terminal.
 */

import { EventEmitter } from 'node:events';
import type { FilenameDatePattern } from './filename-date.js';

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

export const DATE_INFERENCE_EV = {
  PROGRESS: 'date-inference:progress',
  FILE:     'date-inference:file',
  DONE:     'date-inference:done',
  ERROR:    'date-inference:error',
} as const;

export type DateInferenceEventName = typeof DATE_INFERENCE_EV[keyof typeof DATE_INFERENCE_EV];

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/** What was determined/done for a single file during a run. */
export type DateInferenceStatus =
  | 'has_date'      // already has an EXIF/container capture date — nothing to do
  | 'inferred'      // no existing date, but the filename yielded a valid candidate
  | 'no_pattern'    // no existing date and no recognizable date in the filename
  | 'written'       // apply mode: the candidate was written successfully
  | 'write_failed'  // apply mode: the candidate failed to write
  | 'error';        // unexpected per-file failure (I/O, etc.)

/** Roll-up counters for a date-inference run. */
export interface DateInferenceTotals {
  total: number;
  hasDate: number;
  inferred: number;
  noPattern: number;
  written: number;
  writeFailed: number;
  errors: number;
  /** Breakdown of `inferred`+`written`+`writeFailed` files by matched pattern id. */
  byPattern: Record<FilenameDatePattern, number>;
}

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface DateInferenceProgressPayload {
  processed: number;
  total: number;
}

export interface DateInferenceFilePayload {
  filePath: string;
  mediaKind: 'photo' | 'video';
  status: DateInferenceStatus;
  /** Existing capture date when status is 'has_date'. */
  existingCapturedAt?: string;
  /** Filename match detail when status is inferred/written/write_failed. */
  matchedPattern?: FilenameDatePattern;
  matchedText?: string;
  inferredDate?: string;
  /** Failure detail for 'write_failed' / 'error'. */
  error?: string;
}

export interface DateInferenceDonePayload {
  totals: DateInferenceTotals;
}

export interface DateInferenceErrorPayload {
  message: string;
}

// ---------------------------------------------------------------------------
// Typed EventEmitter wrapper
// ---------------------------------------------------------------------------

export interface DateInferenceEngineEvents {
  [DATE_INFERENCE_EV.PROGRESS]: (payload: DateInferenceProgressPayload) => void;
  [DATE_INFERENCE_EV.FILE]:     (payload: DateInferenceFilePayload)     => void;
  [DATE_INFERENCE_EV.DONE]:     (payload: DateInferenceDonePayload)     => void;
  [DATE_INFERENCE_EV.ERROR]:    (payload: DateInferenceErrorPayload)    => void;
}

/**
 * DateInferenceTypedEmitter — a thin typed wrapper over Node's EventEmitter
 * for the date-inference event set. Provides type-safe on/off/once/emit.
 */
export class DateInferenceTypedEmitter extends EventEmitter {
  on<K extends DateInferenceEventName>(event: K, listener: DateInferenceEngineEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends DateInferenceEventName>(event: K, listener: DateInferenceEngineEvents[K]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  once<K extends DateInferenceEventName>(event: K, listener: DateInferenceEngineEvents[K]): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends DateInferenceEventName>(
    event: K,
    payload: Parameters<DateInferenceEngineEvents[K]>[0],
  ): boolean {
    return super.emit(event, payload);
  }
}
