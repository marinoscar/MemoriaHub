/**
 * Process-wide counters behind the node vitals that are not the CLIP session's (`clip-state.ts`).
 * Kept apart from the compute modules so reading them loads no native library. Vitals are
 * `^[a-z][a-z0-9_.]{1,47}$` keys with finite numbers; a vital with no reading yet is omitted.
 */

/** Weight of the newest CompreFace call in the latency average. */
const EWMA_ALPHA = 0.2;

export const nodeTelemetry: {
  comprefaceLatencyMs: number | undefined;
  ocrFramesTotal: number;
  sharpConcurrency: number | undefined;
} = { comprefaceLatencyMs: undefined, ocrFramesTotal: 0, sharpConcurrency: undefined };

/** Times one CompreFace call and folds it into the latency average (also when it throws). */
export async function timedCompreface<T>(call: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await call();
  } finally {
    const elapsed = Date.now() - started;
    const previous = nodeTelemetry.comprefaceLatencyMs;
    nodeTelemetry.comprefaceLatencyMs =
      previous === undefined ? elapsed : previous + EWMA_ALPHA * (elapsed - previous);
  }
}

/** `compreface.latency_ms` (EWMA, once a call ran). */
export function comprefaceVitals(): Record<string, number> {
  const latency = nodeTelemetry.comprefaceLatencyMs;
  return latency === undefined ? {} : { 'compreface.latency_ms': Math.round(latency * 10) / 10 };
}

/** `ocr.frames_total`: frames OCR'd since the node started. */
export function ocrVitals(): Record<string, number> {
  return { 'ocr.frames_total': nodeTelemetry.ocrFramesTotal };
}

/** `sharp.concurrency`: the libvips thread cap the node applied, once known. */
export function sharpVitals(): Record<string, number> {
  const threads = nodeTelemetry.sharpConcurrency;
  return threads === undefined ? {} : { 'sharp.concurrency': threads };
}
