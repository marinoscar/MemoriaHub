/**
 * Integration-style unit tests for ExifCarryoverService.
 *
 * Deliberately does NOT mock `exiftool-vendored` — this service exists solely
 * to get file-level metadata semantics right (argument order, the numeric
 * `-Orientation#=1` write, dropped thumbnails), and a mocked child process
 * would never catch a regression in any of that. ExifTool 13.59 + perl are
 * available in this environment (verified via `exiftool.version()`), so the
 * suite spawns the real vendored binary against a committed fixture.
 *
 * Fixture: apps/api/test/fixtures/exif-source-sample.jpg — a small synthetic
 * JPEG (400x300) stamped with known EXIF/GPS via exiftool-vendored:
 *   Make=MemoriaHubCam, Model=TestModel X100,
 *   DateTimeOriginal=2024:03:15 10:30:00, GPS 37.7749,-122.4194,
 *   Orientation=6 (Rotate 90 CW — deliberately NOT 1, so the service's forced
 *   numeric orientation write is actually exercised), plus an embedded
 *   ThumbnailImage.
 *
 * A fresh child ExifTool process is not spawned per test — `exiftool-vendored`
 * is a shared singleton across the whole process (including this spec's own
 * verification reads), which is why the process is shut down exactly once in
 * the file's final `afterAll` rather than per-service-instance.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { exiftool } from 'exiftool-vendored';
import {
  AI_DIGITAL_SOURCE_TYPE,
  ExifCarryoverService,
} from './exif-carryover.service';

jest.setTimeout(30000);

const FIXTURE_PATH = join(__dirname, '..', '..', 'test', 'fixtures', 'exif-source-sample.jpg');

/** Read a Buffer through exiftool by round-tripping via a scratch temp file. */
async function readTagsFromBuffer(buffer: Buffer, dir: string) {
  const p = join(dir, `readback-${Math.random().toString(36).slice(2)}.jpg`);
  await writeFile(p, buffer);
  try {
    return await exiftool.read(p);
  } finally {
    await rm(p, { force: true });
  }
}

describe('ExifCarryoverService', () => {
  let service: ExifCarryoverService;
  let originalBuffer: Buffer;
  let scratchDir: string;

  beforeAll(async () => {
    originalBuffer = await readFile(FIXTURE_PATH);
    scratchDir = await mkdtemp(join(tmpdir(), 'exif-carryover-spec-'));
  });

  afterAll(async () => {
    await rm(scratchDir, { recursive: true, force: true });
    // Shared exiftool-vendored singleton — shut down exactly once for the
    // whole file so the jest process can exit cleanly.
    await exiftool.end();
  });

  beforeEach(() => {
    service = new ExifCarryoverService();
  });

  // -------------------------------------------------------------------------
  // Real round-trip: applyCarryover against the fixture
  // -------------------------------------------------------------------------

  describe('applyCarryover — real ExifTool round-trip', () => {
    let enhancedBuffer: Buffer;
    let stamped: Buffer;
    let tags: Awaited<ReturnType<typeof exiftool.read>>;

    beforeAll(async () => {
      // A plain, no-EXIF JPEG of DIFFERENT dimensions than the original
      // (300x200 vs. the original's 400x300), so a dimensions assertion can
      // distinguish "copied from original" (wrong) from "actual output"
      // (correct).
      enhancedBuffer = await sharp({
        create: { width: 300, height: 200, channels: 3, background: { r: 5, g: 5, b: 5 } },
      })
        .jpeg({ quality: 70 })
        .toBuffer();

      service = new ExifCarryoverService();
      stamped = await service.applyCarryover(originalBuffer, enhancedBuffer, {
        model: 'gpt-image-1',
        width: 300,
        height: 200,
        originalExtension: '.jpg',
      });
      tags = await readTagsFromBuffer(stamped, scratchDir);
    });

    it('returns non-empty, different bytes than the plain enhanced input (something was actually written)', () => {
      expect(stamped.length).toBeGreaterThan(0);
      expect(Buffer.compare(stamped, enhancedBuffer)).not.toBe(0);
    });

    it('carries DateTimeOriginal over from the original', () => {
      expect(tags.DateTimeOriginal).toBeTruthy();
      const dto = tags.DateTimeOriginal as any;
      expect(dto.year).toBe(2024);
      expect(dto.month).toBe(3);
      expect(dto.day).toBe(15);
    });

    it('carries GPS latitude/longitude over from the original', () => {
      expect(tags.GPSLatitude).toBeCloseTo(37.7749, 3);
      expect(tags.GPSLongitude).toBeCloseTo(-122.4194, 3);
    });

    it('carries Make/Model over from the original', () => {
      expect(tags.Make).toBe('MemoriaHubCam');
      expect(tags.Model).toBe('TestModel X100');
    });

    it('forces Orientation to the raw numeric value 1, not a PrintConv-mismatched label', () => {
      // The fixture's Orientation is 6 (Rotate 90 CW). A plain textual
      // `-EXIF:Orientation=1` write matches "1" against PrintConv *labels*
      // and silently lands on value 3 ("Rotate 180") instead — this is
      // exactly the bug the `#` (ValueConv) suffix in buildWriteArgs exists
      // to avoid. This assertion is the load-bearing one for that fix.
      expect(tags.Orientation).toBe(1);
    });

    it('stamps Software and XMP CreatorTool with the model name', () => {
      expect(tags.Software).toContain('gpt-image-1');
      expect((tags as any).CreatorTool).toContain('gpt-image-1');
    });

    it('stamps the IPTC/XMP DigitalSourceType with the AI-generated NewsCode', () => {
      expect((tags as any).DigitalSourceType).toBe(AI_DIGITAL_SOURCE_TYPE);
    });

    it('records the ACTUAL output dimensions on ExifImageWidth/Height, not the original file’s dimensions', () => {
      // The original fixture is 400x300; the requested output dims here are
      // 300x200. The original fixture never had ExifImageWidth/Height set at
      // all (verified: undefined before carryover), so a non-400/300 value
      // proves this was written by the service, not copied from the source.
      expect(tags.ExifImageWidth).toBe(300);
      expect(tags.ExifImageHeight).toBe(200);
    });

    it('drops any embedded thumbnail/preview carried on the original', () => {
      expect(tags.ThumbnailImage).toBeFalsy();
      expect((tags as any).PreviewImage).toBeFalsy();
    });
  });

  describe('applyCarryover — omitted dimensions', () => {
    it('does not stamp ExifImageWidth/Height when width/height are not supplied', async () => {
      const enhancedBuffer = await sharp({
        create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 1, b: 1 } },
      })
        .jpeg()
        .toBuffer();

      const stamped = await service.applyCarryover(originalBuffer, enhancedBuffer, {
        model: 'gpt-image-1',
      });
      const tags = await readTagsFromBuffer(stamped, scratchDir);

      expect(tags.ExifImageWidth).toBeUndefined();
      expect(tags.ExifImageHeight).toBeUndefined();
      // The rest of the carryover still happened.
      expect(tags.Make).toBe('MemoriaHubCam');
    });
  });

  // -------------------------------------------------------------------------
  // buildWriteArgs — pure argument-vector construction, no child process
  // -------------------------------------------------------------------------

  describe('buildWriteArgs', () => {
    it('places -TagsFromFile before all per-tag override args (later args win in ExifTool)', () => {
      const args = service.buildWriteArgs('/tmp/original.jpg', {
        model: 'gpt-image-1',
        width: 640,
        height: 480,
      });

      const tagsFromFileIdx = args.indexOf('-TagsFromFile');
      expect(tagsFromFileIdx).toBeGreaterThanOrEqual(0);

      const overrideNeedles = [
        '-EXIF:Orientation#=1',
        '-EXIF:ExifImageWidth#=640',
        '-EXIF:ExifImageHeight#=480',
      ];
      for (const needle of overrideNeedles) {
        const idx = args.indexOf(needle);
        expect(idx).toBeGreaterThan(tagsFromFileIdx);
      }

      // Software / CreatorTool / DigitalSourceType are prefix-matched since
      // they carry the interpolated model name.
      const softwareIdx = args.findIndex((a) => a.startsWith('-EXIF:Software='));
      const creatorToolIdx = args.findIndex((a) => a.startsWith('-XMP-xmp:CreatorTool='));
      const digitalSourceIdx = args.findIndex((a) =>
        a.startsWith('-XMP-iptcExt:DigitalSourceType='),
      );
      expect(softwareIdx).toBeGreaterThan(tagsFromFileIdx);
      expect(creatorToolIdx).toBeGreaterThan(tagsFromFileIdx);
      expect(digitalSourceIdx).toBeGreaterThan(tagsFromFileIdx);
    });

    it('includes the original path immediately after -TagsFromFile', () => {
      const args = service.buildWriteArgs('/tmp/some-original.heic', { model: 'x' });
      const idx = args.indexOf('-TagsFromFile');
      expect(args[idx + 1]).toBe('/tmp/some-original.heic');
    });

    it('omits ExifImageWidth/Height override args entirely when width/height are not supplied', () => {
      const args = service.buildWriteArgs('/tmp/original.jpg', { model: 'gpt-image-1' });
      expect(args.some((a) => a.startsWith('-EXIF:ExifImageWidth'))).toBe(false);
      expect(args.some((a) => a.startsWith('-EXIF:ExifImageHeight'))).toBe(false);
    });

    it('embeds the model name in the Software/CreatorTool override strings', () => {
      const args = service.buildWriteArgs('/tmp/original.jpg', { model: 'claude-vision-x' });
      expect(args).toContain('-EXIF:Software=MemoriaHub AI Enhance (claude-vision-x)');
      expect(args).toContain('-XMP-xmp:CreatorTool=MemoriaHub AI Enhance (claude-vision-x)');
    });

    it('uses the numeric ValueConv (#) suffix on the Orientation override, not a plain assignment', () => {
      const args = service.buildWriteArgs('/tmp/original.jpg', { model: 'x' });
      expect(args).toContain('-EXIF:Orientation#=1');
      expect(args).not.toContain('-EXIF:Orientation=1');
    });

    it('drops embedded thumbnail/preview via empty-value clears', () => {
      const args = service.buildWriteArgs('/tmp/original.jpg', { model: 'x' });
      expect(args).toContain('-ThumbnailImage=');
      expect(args).toContain('-PreviewImage=');
    });
  });

  // -------------------------------------------------------------------------
  // Best-effort degrade contract
  // -------------------------------------------------------------------------

  describe('best-effort degradation when ExifTool is unavailable', () => {
    class ExifCarryoverServiceUnavailable extends ExifCarryoverService {
      protected loadExiftool(): Promise<any> {
        return Promise.resolve(null);
      }
    }

    class ExifCarryoverServiceThrowing extends ExifCarryoverService {
      protected loadExiftool(): Promise<any> {
        return Promise.reject(new Error('simulated: perl not on PATH'));
      }
    }

    it('returns the original input buffer unchanged when the exiftool module fails to load', async () => {
      const degraded = new ExifCarryoverServiceUnavailable();
      const enhancedBuffer = Buffer.from('stub-enhanced-bytes-not-a-real-jpeg');

      const result = await degraded.applyCarryover(originalBuffer, enhancedBuffer, {
        model: 'gpt-image-1',
      });

      expect(result).toBe(enhancedBuffer);
    });

    it('never throws, even when loadExiftool itself rejects', async () => {
      const degraded = new ExifCarryoverServiceThrowing();
      const enhancedBuffer = Buffer.from('stub-enhanced-bytes-not-a-real-jpeg');

      await expect(
        degraded.applyCarryover(originalBuffer, enhancedBuffer, { model: 'gpt-image-1' }),
      ).resolves.toBe(enhancedBuffer);
    });
  });
});
