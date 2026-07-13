import { z } from 'zod';

/**
 * Parsed geographic bounding box.
 */
export interface Bbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/**
 * Zod schema for a `bbox` query param encoded as `"minLng,minLat,maxLng,maxLat"`.
 *
 * Transforms the comma-separated string into a `Bbox` of four finite numbers.
 * Rejects inputs that do not have exactly four parts or where any part is
 * non-finite (NaN / Infinity). Combine with `.optional()` at the call site.
 */
export const bboxInput = z.string().transform((val, ctx): Bbox => {
  const parts = val.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    ctx.addIssue({
      code: 'custom',
      message: 'bbox must be "minLng,minLat,maxLng,maxLat" of four finite numbers',
    });
    return z.NEVER;
  }
  const [minLng, minLat, maxLng, maxLat] = parts;
  return { minLng, minLat, maxLng, maxLat };
});
