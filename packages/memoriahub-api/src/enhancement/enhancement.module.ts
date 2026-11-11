import { Module, type DynamicModule, type ModuleMetadata, type Provider } from '@nestjs/common';

import { MediaModule } from '../media/index.js';
import { ENHANCEMENT_OPTIONS, type EnhancementModuleOptions } from './enhancement-host-hooks.js';
import { MediaEnhancementService } from './media-enhancement.service.js';
import { PictureEnhancementHandler } from './picture-enhancement.handler.js';
import { PictureEnhancementPurgeHandler } from './picture-enhancement-purge.handler.js';
import { PictureEnhancementPurgeTask } from './picture-enhancement-purge.task.js';

/**
 * Options of {@link EnhancementModule.forRoot}: the host's hook bindings and imports, and the queue knobs.
 *
 * @stability experimental
 */
export interface EnhancementModuleForRootOptions extends EnhancementModuleOptions {
  /**
   * The host's bindings: `ENHANCEMENT_IMAGE_TOOLS`, `ENHANCEMENT_KEY_STATUS`, `ENHANCEMENT_STORAGE_ORG` and
   * the media slice's `MEDIA_OBJECT_REPROCESSOR` and `MEDIA_THUMBNAIL_PRUNER`.
   */
  providers: Provider[];
  /**
   * Host modules the slice needs: the one that provides `MediaMetadataSyncService` (the host binds its
   * location hook) and the ones the bindings above use.
   */
  imports?: ModuleMetadata['imports'];
}

/**
 * The enhancement slice (RETRO-J10, #624): the AI Picture Enhancer. `MediaEnhancementService` (single and
 * bulk start, list, poll, keep-both, replace, discard, batch inspection and cancel), the server-only
 * `picture_enhancement` job (every model call goes through `MEMORIAHUB_AI`; type string and profile
 * unchanged, no node result pair), the `picture_enhancement_purge` housekeeping job and its enqueue-only
 * hourly cron. It reaches the outside only through the host ports plus the hooks of
 * `enhancement-host-hooks`.
 *
 * The three controllers (`MediaEnhancementController`, `EnhancementBatchesController`,
 * `AdminEnhancementController`) are exported classes, not mounted by `forRoot()`: the host lists them in
 * the `controllers` of the module where its routes belong.
 *
 * Import it ONCE in the host (the handlers and the cron are singletons).
 *
 * @stability experimental
 */
@Module({})
export class EnhancementModule {
  private static root: DynamicModule | undefined;

  /**
   * Builds the module (cached, so every call names the same instance).
   *
   * @param options - the hook bindings, the host imports and the queue knobs.
   */
  static forRoot(options: EnhancementModuleForRootOptions): DynamicModule {
    const { providers: hostProviders, imports = [], ...rest } = options;
    EnhancementModule.root ??= {
      module: EnhancementModule,
      imports: [MediaModule.forRoot(), ...imports],
      providers: [
        ...hostProviders,
        { provide: ENHANCEMENT_OPTIONS, useValue: rest satisfies EnhancementModuleOptions },
        MediaEnhancementService,
        PictureEnhancementHandler,
        PictureEnhancementPurgeHandler,
        PictureEnhancementPurgeTask,
      ],
      exports: [MediaEnhancementService],
    };
    return EnhancementModule.root;
  }
}
