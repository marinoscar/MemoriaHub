/**
 * Real-fixture regression test for ExifProcessor.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The sibling spec (exif.processor.spec.ts) mocks `exifr.parse` to return a
 * flat synthetic object, which means it cannot detect regressions in how the
 * processor calls exifr — specifically, it would NOT catch the mergeOutput bug:
 *
 *   exifr.parse(buf, { mergeOutput: false })
 *
 * With mergeOutput:false exifr returns a NESTED segment object:
 *   { ifd0: { Make, Model }, exif: { DateTimeOriginal }, gps: { latitude } }
 * The processor reads TOP-LEVEL keys (raw['Make'], raw['DateTimeOriginal'],
 * raw['latitude'], etc.), so every field comes back undefined and the
 * processor silently emits an empty {} for every uploaded photo.
 *
 * This spec runs the REAL ExifProcessor against a REAL JPEG so that any
 * future change to exifr options, merge mode, or key-reading paths will
 * cause an immediate, observable test failure.
 *
 * RULES FOR THIS FILE
 * -------------------
 * - NEVER add jest.mock / jest.doMock of 'exifr' anywhere in this file.
 * - NEVER replace the real ExifProcessor with a stub.
 * - The fixture (test-data.jpg) is a 26 KB Samsung Galaxy Z Fold7 JPEG with
 *   full EXIF + GPS embedded; all expected values below were verified against
 *   the real fixed processor.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { ExifProcessor } from '../../../src/storage/processing/processors/exif.processor';

// ---------------------------------------------------------------------------
// Fixture path — resolves to apps/api/test/fixtures/test-data.jpg
// ---------------------------------------------------------------------------
const FIXTURE_PATH = path.join(__dirname, '../../fixtures/test-data.jpg');

// ---------------------------------------------------------------------------
// Minimal StorageObject stub (mirrors the pattern in exif.processor.spec.ts)
// ---------------------------------------------------------------------------
function makeObject(mimeType = 'image/jpeg') {
  return {
    id: 'obj-fixture-exif-001',
    mimeType,
    name: 'test-data.jpg',
    size: BigInt(26682),
    storageKey: 'fixtures/test-data.jpg',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'ready',
    s3UploadId: null,
    uploadedById: 'user-fixture',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
}

// ---------------------------------------------------------------------------
// getStream factory — wraps the fixture buffer in a Readable (no mock)
// ---------------------------------------------------------------------------
function makeGetStream(buf: Buffer): () => Promise<Readable> {
  return () => Promise.resolve(Readable.from(buf));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ExifProcessor — real fixture (no exifr mock)', () => {
  let processor: ExifProcessor;
  let buffer: Buffer;

  beforeAll(() => {
    processor = new ExifProcessor();
    buffer = fs.readFileSync(FIXTURE_PATH);
  });

  it('should read the fixture file (sanity check)', () => {
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it('should return success:true', async () => {
    const result = await processor.process(makeObject(), makeGetStream(buffer));
    expect(result.success).toBe(true);
  });

  describe('extracted metadata', () => {
    // We run process() once and share the result across all assertions in
    // this describe block to avoid repeating the parse for every it().
    let metadata: Record<string, unknown>;

    beforeAll(async () => {
      const result = await processor.process(makeObject(), makeGetStream(buffer));
      metadata = result.metadata as Record<string, unknown>;
    });

    // regression guard: empty metadata here means exifr options/merge broke
    // (see mergeOutput regression — with mergeOutput:false every field is
    // read from the wrong nesting level and comes back undefined)
    it('should NOT return an empty metadata object (regression guard: mergeOutput)', () => {
      expect(metadata).toBeDefined();
      expect(Object.keys(metadata).length).toBeGreaterThan(0);
    });

    it('capturedAt should be defined (regression guard)', () => {
      expect(metadata['capturedAt']).toBeDefined();
    });

    it('cameraMake should be defined (regression guard)', () => {
      expect(metadata['cameraMake']).toBeDefined();
    });

    it('cameraModel should be defined (regression guard)', () => {
      expect(metadata['cameraModel']).toBeDefined();
    });

    // -----------------------------------------------------------------------
    // Exact-value assertions (verified against the real fixed processor)
    // -----------------------------------------------------------------------

    it('capturedAt should be an ISO 8601 UTC string on 2026-06-20 with 438 ms sub-second from SubSecTimeOriginal', () => {
      // The 438 ms sub-second is read from SubSecTimeOriginal; this proves
      // the sub-second merge path works end-to-end with the real exifr call.
      //
      // NOTE ON TIMEZONE: exifr with reviveValues:true parses DateTimeOriginal
      // ("2026:06:20 15:16:07") as a JavaScript Date using the LOCAL timezone
      // of the process, then the processor serialises it via .toISOString()
      // which yields UTC.  The exact hour therefore varies by host timezone and
      // we cannot pin it to a single constant without timezone-normalisation in
      // the processor.  What we CAN assert deterministically is:
      //   - the date portion is "2026-06-20"
      //   - the sub-second ".438" is preserved (proves SubSecTimeOriginal merge)
      //   - the string is a valid ISO 8601 UTC timestamp ending in "Z"
      const capturedAt = metadata['capturedAt'] as string;
      expect(capturedAt).toMatch(/^2026-06-20T\d{2}:16:07\.438Z$/);
    });

    it('capturedAtOffset should be -300 (from OffsetTimeOriginal "-05:00")', () => {
      // '-05:00' → -(5*60 + 0) = -300
      expect(metadata['capturedAtOffset']).toBe(-300);
    });

    it('cameraMake should be "samsung"', () => {
      expect(metadata['cameraMake']).toBe('samsung');
    });

    it('cameraModel should be "Galaxy Z Fold7"', () => {
      expect(metadata['cameraModel']).toBe('Galaxy Z Fold7');
    });

    it('orientation should be 1', () => {
      expect(metadata['orientation']).toBe(1);
    });

    it('latitude should be approximately 30.2413485', () => {
      expect(metadata['latitude']).toBeCloseTo(30.2413485, 5);
    });

    it('longitude should be approximately -95.4831974', () => {
      expect(metadata['longitude']).toBeCloseTo(-95.4831974, 5);
    });
  });
});
