// =============================================================================
// The media/face job types on the booted app (RETRO-C3, #585)
// =============================================================================
//
// Boots the real module graph (mocked Prisma, no database) and asserts on the
// registry the worker consults: the six media/face types are the NATIVE handler
// classes, registered by themselves and not through the legacy adapter, and the
// server-only set the `system` worker mode claims is derived from them exactly
// as the issue specifies. Literal type strings on purpose: a rename must fail here.
// =============================================================================

import { JobHandlerRegistry, ProviderThrottleService } from '@marinoscar/platform-api/jobs';

import { EnrichmentHandlerRegistry } from '../../src/enrichment/enrichment-handler.registry';
import { ThumbnailRegenHandler } from '@marinoscar/memoriahub-api/media';
import { ThumbnailRepairHandler } from '@marinoscar/memoriahub-api/media';
import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';

const NATIVE: Array<[string, new (...args: never[]) => unknown]> = [
  ['thumbnail_regen', ThumbnailRegenHandler],
  ['thumbnail_repair', ThumbnailRepairHandler],
];

describe('media/face job handlers on the booted app (RETRO-C3)', () => {
  let context: TestContext;
  let registry: JobHandlerRegistry;

  beforeAll(async () => {
    context = await createTestApp();
    registry = context.app.get(JobHandlerRegistry);
  }, 120_000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  it.each(NATIVE)('%s dispatches to the native handler class', (type, HandlerClass) => {
    expect(registry.get(type)).toBeInstanceOf(HandlerClass);
  });

  // The three face types are the packaged face slice's (RETRO-J6): it registers them through the
  // `MEMORIAHUB_JOBS` port, so the registry holds the port's adaptation of the handler, not the class.
  it.each([
    ['face_detection', 'Face detection (photo)'],
    ['video_face_detection', 'Face detection (video)'],
    ['face_auto_archive_sweep', 'Face auto-archive sweep'],
  ])('%s is registered by the face slice through the jobs port', (type, label) => {
    expect(registry.get(type)).toMatchObject({ type, label });
  });

  // `metadata_extraction` is the packaged media slice's (RETRO-J5): same port adaptation.
  it('metadata_extraction is registered by the media slice through the jobs port', () => {
    expect(registry.get('metadata_extraction')).toMatchObject({ type: 'metadata_extraction', label: 'Metadata extraction' });
  });

  it('none of the six goes through the legacy adapter', () => {
    const legacy = context.app.get(EnrichmentHandlerRegistry).types();
    for (const type of ['face_detection', 'video_face_detection', 'face_auto_archive_sweep']) expect(legacy).not.toContain(type);
    for (const [type] of NATIVE) expect(legacy).not.toContain(type);
    expect(legacy).not.toContain('metadata_extraction');
  });

  it('derives face_auto_archive_sweep and thumbnail_repair as server-only, not the other four', () => {
    const serverOnly = registry.serverOnlyTypes();
    expect(serverOnly).toEqual(expect.arrayContaining(['face_auto_archive_sweep', 'thumbnail_repair']));
    for (const type of ['face_detection', 'video_face_detection', 'metadata_extraction', 'thumbnail_regen']) {
      expect(serverOnly).not.toContain(type);
    }
  });

  it('keeps face_detection on the face provider throttle bucket', () => {
    expect(context.app.get(ProviderThrottleService).resolveKey('face_detection')).toBe('face');
  });
});
