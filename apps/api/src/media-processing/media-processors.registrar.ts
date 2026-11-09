import { Injectable, OnModuleInit } from '@nestjs/common';
import { ObjectProcessorRegistry, type ObjectProcessor } from '@marinoscar/platform-api/storage';

import { ContentHashProcessor } from './processors/content-hash.processor';
import { ExifProcessor } from './processors/exif.processor';
import { ImageDimensionsProcessor } from './processors/image-dimensions.processor';
import { ReverseGeocodeProcessor } from './processors/reverse-geocode.processor';
import { ThumbnailProcessor } from './processors/thumbnail.processor';
import { VideoProbeProcessor } from './processors/video-probe.processor';
import { VisualHashProcessor } from './processors/visual-hash.processor';

// =============================================================================
// MediaProcessorsRegistrar: MemoriaHub's post-upload processors on the platform registry
// =============================================================================
//
// The seven processors run inside the platform's `storage.object.process` job,
// in priority order (lower first); equal priorities keep REGISTRATION order,
// which is why one registrar registers them all, in the order the old
// `OBJECT_PROCESSOR` factory listed them, instead of each processor
// self-registering from its own `onModuleInit` (whose relative order Nest does
// not promise):
//
//   content-hash (10), exif (20), video-probe (20), dimensions (25),
//   geocode (30), thumbnail (40), visual-hash (45)
//
// `exif` and `video-probe` share priority 20 and never both apply to one object
// (images and videos), so their order only matters for the log.
// =============================================================================

/** The processor names, in the order they run. */
export const MEDIA_PROCESSOR_ORDER = [
  'content-hash',
  'exif',
  'video-probe',
  'dimensions',
  'geocode',
  'thumbnail',
  'visual-hash',
] as const;

@Injectable()
export class MediaProcessorsRegistrar implements OnModuleInit {
  constructor(
    private readonly registry: ObjectProcessorRegistry,
    private readonly contentHash: ContentHashProcessor,
    private readonly exif: ExifProcessor,
    private readonly dimensions: ImageDimensionsProcessor,
    private readonly videoProbe: VideoProbeProcessor,
    private readonly geocode: ReverseGeocodeProcessor,
    private readonly thumbnail: ThumbnailProcessor,
    private readonly visualHash: VisualHashProcessor,
  ) {}

  /** The processors, in the old factory's order. */
  processors(): ObjectProcessor[] {
    return [
      this.contentHash,
      this.exif,
      this.dimensions,
      this.videoProbe,
      this.geocode,
      this.thumbnail,
      this.visualHash,
    ];
  }

  onModuleInit(): void {
    for (const processor of this.processors()) this.registry.register(processor);
  }
}
