import { Injectable } from '@nestjs/common';
import type { EnhancementImageTools, EnhancementKeyStatus, ExifCarryoverOptions } from '@marinoscar/memoriahub-api/enhancement';
import { ExifCarryoverService } from '@marinoscar/memoriahub-api/enhancement';
import sharp from 'sharp';

import { AiDeploymentKeySource } from '../ai-port/ai-deployment-key-source';
import { renderThumbnailBuffer } from '../media-processing/thumbnail-render.util';

/**
 * The web app's binding of the enhancement slice's `ENHANCEMENT_IMAGE_TOOLS` hook: the native image libraries
 * (sharp for the thumbnail and the real pixel size stay with the host; the packaged `ExifCarryoverService` (ExifTool, an optional peer of the package) for the metadata carry-over).
 */
@Injectable()
export class EnhancementImageToolsAdapter implements EnhancementImageTools {
  constructor(private readonly exif: ExifCarryoverService) {}

  /** Renders the thumbnail of the staged bytes with the shared thumbnail renderer. */
  renderThumbnail(bytes: Buffer, options: { sourceFilename: string }): Promise<Buffer> {
    return renderThumbnailBuffer(bytes, { sourceFilename: options.sourceFilename });
  }

  /** Reads the real pixel dimensions, or `null` when the bytes cannot be decoded. Never throws. */
  async readDimensions(bytes: Buffer): Promise<[number, number] | null> {
    try {
      const meta = await sharp(bytes).metadata();
      if (meta.width && meta.height) return [meta.width, meta.height];
    } catch {
      // Not decodable here (e.g. a stub buffer in tests) — the caller falls back.
    }
    return null;
  }

  /** Copies the original's metadata onto the enhanced bytes and stamps the AI marker. Best-effort. */
  carryOverMetadata(original: Buffer, enhanced: Buffer, options: ExifCarryoverOptions): Promise<Buffer> {
    return this.exif.applyCarryover(original, enhanced, options);
  }
}

/**
 * The web app's binding of the enhancement slice's `ENHANCEMENT_KEY_STATUS` hook: the deployment key's status
 * (the platform credential first, then the legacy row), which carries no key material.
 */
@Injectable()
export class EnhancementKeyStatusAdapter implements EnhancementKeyStatus {
  constructor(private readonly keys: AiDeploymentKeySource) {}

  /** The deployment key's status for one provider. */
  async status(provider: string): Promise<{ configured: boolean; enabled: boolean }> {
    const status = await this.keys.status(provider);
    return { configured: status.configured, enabled: status.enabled };
  }
}
