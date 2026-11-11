import { Module, type DynamicModule, type ModuleMetadata, type Provider } from '@nestjs/common';

import { MediaModule } from '../media/index.js';
import { SOCIAL_MEDIA_OPTIONS, type SocialMediaModuleOptions } from './social-media-host-hooks.js';
import { SocialMediaBackfillService } from './social-media-backfill.service.js';
import { SocialMediaDetectionHandler } from './social-media-detection.handler.js';
import { SocialMediaDetectorService } from './social-media-detector.service.js';
import { SocialMediaOcrService } from './social-media-ocr.service.js';
import { SocialMediaUploadEnrichment } from './social-media-upload-enrichment.js';

/**
 * Options of {@link SocialMediaModule.forRoot}: the host's hook binding and the job budget.
 *
 * @stability experimental
 */
export interface SocialMediaModuleForRootOptions extends SocialMediaModuleOptions {
  /** The host's bindings; must include `SOCIAL_MEDIA_POST_DETECTION`. */
  providers: Provider[];
  /**
   * Host modules the slice needs: the one that provides the face slice's `VideoFrameExtractionService`
   * (the Tier-2 OCR extracts its frames with it).
   */
  imports?: ModuleMetadata['imports'];
}

/**
 * The social-media slice (RETRO-J10, #624): social-media video detection (the Tier-1 metadata and
 * filename rule engine, the Tier-2 OCR fallback), the node-eligible `social_media_detection` job, the
 * upload fan-out registration (it gates the face and tagging jobs behind the verdict), the per-item rerun
 * and status routes and the admin backfill and status routes. It reaches the outside only through the
 * host ports plus the `SOCIAL_MEDIA_POST_DETECTION` hook.
 *
 * The two controllers (`SocialMediaMediaController`, `AdminSocialMediaController`) are exported classes,
 * not mounted by `forRoot()`: the host lists them in the `controllers` of the module where its routes belong.
 *
 * Import it ONCE in the host (the handler and the registration are singletons).
 *
 * @stability experimental
 */
@Module({})
export class SocialMediaModule {
  private static root: DynamicModule | undefined;

  /**
   * Builds the module (cached, so every call names the same instance).
   *
   * @param options - the hook binding, the host imports and the job budget.
   */
  static forRoot(options: SocialMediaModuleForRootOptions): DynamicModule {
    const { providers: hostProviders, imports = [], ...rest } = options;
    SocialMediaModule.root ??= {
      module: SocialMediaModule,
      imports: [MediaModule.forRoot(), ...imports],
      providers: [
        ...hostProviders,
        { provide: SOCIAL_MEDIA_OPTIONS, useValue: rest satisfies SocialMediaModuleOptions },
        SocialMediaUploadEnrichment,
        SocialMediaDetectorService,
        SocialMediaOcrService,
        SocialMediaDetectionHandler,
        SocialMediaBackfillService,
      ],
      exports: [SocialMediaOcrService, SocialMediaDetectorService, SocialMediaBackfillService],
    };
    return SocialMediaModule.root;
  }
}
