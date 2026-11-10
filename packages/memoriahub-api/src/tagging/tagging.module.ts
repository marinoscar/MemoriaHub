import { Module, type DynamicModule } from '@nestjs/common';

import { MediaModule } from '../media/index.js';
import { AutoTaggingHandler } from './auto-tagging.handler.js';
import { AutoTaggingService } from './auto-tagging.service.js';
import { TagLabelsService } from './tag-labels.service.js';
import { TaggingBackfillService } from './tagging-backfill.service.js';
import { TaggingUploadEnrichment } from './tagging-upload-enrichment.js';
import { VideoAutoTaggingHandler } from './video-auto-tagging.handler.js';
import { VideoAutoTaggingService } from './video-auto-tagging.service.js';
import { VideoInputResolver } from './video-input.service.js';

/**
 * Options of {@link TaggingModule.forRoot}. None yet: the image budget is `TAG_MAX_IMAGE_DIM`, the
 * video parameters are the `autoTagging.video.*` system settings, and the model is the
 * `ai.features.tagging` selection, all read through the ports.
 *
 * @stability experimental
 */
export interface TaggingModuleOptions {
  /** Reserved for the options the slice may take (an image budget, a frame budget). */
  readonly reserved?: never;
}

/**
 * The tagging slice (RETRO-J7, #618): photo and video auto-tagging, the transcript, the tag
 * vocabulary and the tagging backfill. It reaches the outside only through the ports of
 * `@marinoscar/memoriahub-api/ports` (the host binds them once with `MemoriahubPortsModule.forRoot`);
 * AI goes through `MEMORIAHUB_AI` and never imports a provider SDK. Both job types are SERVER-ONLY
 * (no node result pair): a key is never brokered to a worker node.
 *
 * The slice's controllers (`TaggingController`, `TagLabelsController`, `AdminTaggingController`) are
 * exported classes, not mounted by `forRoot()`: the host lists them in the `controllers` of the module
 * where its routes belong, so the order of its OpenAPI document (which follows module order) stays the
 * host's decision.
 *
 * Import it ONCE in the host and re-export it from the host's own tagging module.
 *
 * @stability experimental
 */
@Module({})
export class TaggingModule {
  private static root: DynamicModule | undefined;

  /**
   * Builds the module. The result is cached, so every `forRoot()` call in a host's module graph names
   * the same module instance and each handler registers once.
   *
   * @param _options - reserved.
   */
  static forRoot(_options: TaggingModuleOptions = {}): DynamicModule {
    TaggingModule.root ??= {
      module: TaggingModule,
      imports: [MediaModule.forRoot()],
      providers: [
        AutoTaggingHandler,
        AutoTaggingService,
        VideoAutoTaggingHandler,
        VideoAutoTaggingService,
        VideoInputResolver,
        TagLabelsService,
        TaggingBackfillService,
        TaggingUploadEnrichment,
      ],
      exports: [AutoTaggingService, VideoAutoTaggingService, TagLabelsService, TaggingBackfillService],
    };
    return TaggingModule.root;
  }
}
