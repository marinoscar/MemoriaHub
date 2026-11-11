// =============================================================================
// Real image tools for the enhancement specs (sharp), with a scripted metadata carry-over
// =============================================================================
//
// The host owns the native image libraries; the specs that exercise the real pixel paths (the real
// dimensions of the returned image, the thumbnail derivative) bring the same sharp calls the web app's
// `EnhancementImageToolsAdapter` makes, and script the carry-over (ExifTool stays in the web app).
// =============================================================================

import sharp from 'sharp';

import type { EnhancementImageTools } from '../../src/enhancement/index.js';

/**
 * Builds the tools over sharp. `carryOver` stands in for the host's ExifTool step.
 *
 * @param carryOver - the scripted carry-over (default: returns the enhanced bytes unchanged).
 */
export function realImageTools(
  carryOver: jest.Mock = jest.fn(async (_original: Buffer, enhanced: Buffer) => enhanced),
): EnhancementImageTools & { carryOverMetadata: jest.Mock } {
  return {
    renderThumbnail: (bytes: Buffer) =>
      sharp(bytes)
        .rotate()
        .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer(),
    readDimensions: async (bytes: Buffer) => {
      try {
        const meta = await sharp(bytes).metadata();
        if (meta.width && meta.height) return [meta.width, meta.height] as [number, number];
      } catch {
        // Not decodable (a stub buffer): the caller falls back.
      }
      return null;
    },
    carryOverMetadata: carryOver,
  };
}
