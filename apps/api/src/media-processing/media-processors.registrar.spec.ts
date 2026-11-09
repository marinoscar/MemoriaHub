import { ObjectProcessorRegistry } from '@marinoscar/platform-api/storage';

import { MEDIA_PROCESSOR_ORDER, MediaProcessorsRegistrar } from './media-processors.registrar';
import { ContentHashProcessor } from './processors/content-hash.processor';
import { ExifProcessor } from './processors/exif.processor';
import { ImageDimensionsProcessor } from './processors/image-dimensions.processor';
import { ReverseGeocodeProcessor } from './processors/reverse-geocode.processor';
import { ThumbnailProcessor } from './processors/thumbnail.processor';
import { VideoProbeProcessor } from './processors/video-probe.processor';
import { VisualHashProcessor } from './processors/visual-hash.processor';

/** The seven processors keep their names and run order on the platform registry (RETRO-D1). */
describe('MediaProcessorsRegistrar', () => {
  function registered(): ObjectProcessorRegistry {
    const registry = new ObjectProcessorRegistry();
    new MediaProcessorsRegistrar(
      registry,
      new ContentHashProcessor(),
      new ExifProcessor(),
      new ImageDimensionsProcessor(),
      new VideoProbeProcessor(),
      new ReverseGeocodeProcessor({} as never),
      new ThumbnailProcessor({} as never, {} as never),
      new VisualHashProcessor(),
    ).onModuleInit();
    return registry;
  }

  it('registers the seven processors in the pre-RETRO-D1 order', () => {
    expect(registered().names()).toEqual([...MEDIA_PROCESSOR_ORDER]);
  });

  it('runs images through content-hash, exif, dimensions, geocode, thumbnail, visual-hash', () => {
    const image = { mimeType: 'image/jpeg', storageKey: 'uploads/1/a.jpg' } as never;
    expect(registered().list().filter((p) => p.canProcess(image)).map((p) => p.name)).toEqual([
      'content-hash',
      'exif',
      'dimensions',
      'geocode',
      'thumbnail',
      'visual-hash',
    ]);
  });

  it('runs videos through video-probe and thumbnail, and never re-processes a thumbnail', () => {
    const registry = registered();
    const video = registry.list().filter((p) => p.canProcess({ mimeType: 'video/mp4', storageKey: 'uploads/1/a.mp4' } as never));
    expect(video.map((p) => p.name)).toEqual(expect.arrayContaining(['video-probe', 'thumbnail']));
    const thumb = { mimeType: 'image/jpeg', storageKey: 'thumbnails/x-0123456789abcdef.jpg' } as never;
    expect(registry.list().filter((p) => p.canProcess(thumb)).map((p) => p.name)).not.toContain('thumbnail');
  });
});
