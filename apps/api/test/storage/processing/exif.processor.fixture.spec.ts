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

    it('capturedAt should be exactly "2026-06-20T20:16:07.438Z" (timezone-determinism regression guard)', () => {
      // The 438 ms sub-second is read from SubSecTimeOriginal; this proves
      // the sub-second merge path works end-to-end with the real exifr call.
      //
      // Previously this used a regex because the processor was TZ-sensitive.
      // Now it asserts the exact value — this is a timezone-determinism
      // regression guard: if the processor reverts to TZ-sensitive behavior
      // (e.g. using dto.toISOString() instead of re-encoding via Date.UTC from
      // local getters), this will fail on non-UTC hosts.
      //
      // The processor now rebuilds capturedAt from local-getter wall-clock
      // components re-encoded as UTC, so "2026:06:20 20:16:07" in the EXIF
      // string always maps to exactly "2026-06-20T20:16:07.438Z" regardless
      // of the server's local timezone.
      const capturedAt = metadata['capturedAt'] as string;
      expect(capturedAt).toBe('2026-06-20T20:16:07.438Z');
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

  // ---------------------------------------------------------------------------
  // Timezone-determinism regression guard
  //
  // Verify that the processor emits the same exact capturedAt string even when
  // the process timezone is changed to a non-UTC zone (America/Chicago, UTC-5/6).
  //
  // NOTE: In Node.js the `process.env.TZ` change only takes effect for Date
  // operations that happen AFTER the assignment within the same isolate. Jest
  // runs each spec file in its own worker, so setting TZ in beforeAll here
  // affects all Date constructors called subsequently in this describe block.
  // However, because `process.env.TZ` is applied at the libuv/ICU level, it
  // may not take effect in all environments (notably on some glibc configurations
  // the TZ is read only at process start). We therefore:
  //   1. Set TZ in beforeAll and verify it took effect by checking the
  //      getTimezoneOffset() of a known local-time Date.
  //   2. If the change did NOT take effect (e.g. the host is already UTC and
  //      glibc ignores runtime TZ changes), we skip the assertion with a
  //      descriptive message — the processor is still correct for UTC.
  //   3. If the change DID take effect, we assert the exact expected value.
  // ---------------------------------------------------------------------------
  describe('timezone determinism — TZ=America/Chicago', () => {
    let originalTz: string | undefined;
    let tzTookEffect: boolean;

    beforeAll(() => {
      originalTz = process.env.TZ;
      process.env.TZ = 'America/Chicago';

      // America/Chicago is UTC-5 (CST) or UTC-6 (CDT); either way non-zero.
      // If TZ did not take effect the offset for a mid-summer date will be 0.
      const offset = new Date(2026, 5, 20, 20, 16, 7).getTimezoneOffset();
      // Non-UTC: offset is 300 (CST) or 360 (CDT)
      tzTookEffect = offset !== 0;
    });

    afterAll(() => {
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    });

    it('should produce the same capturedAt under America/Chicago as under UTC', async () => {
      if (!tzTookEffect) {
        // Host's glibc did not honour the runtime TZ change — skip the TZ-specific
        // assertion. The regression is still guarded by the UTC assertion above.
        console.warn(
          'process.env.TZ change did not take effect (host may ignore runtime TZ); ' +
          'skipping TZ=America/Chicago capturedAt assertion.',
        );
        return;
      }

      const result = await processor.process(makeObject(), makeGetStream(buffer));
      const capturedAt = (result.metadata as Record<string, unknown>)['capturedAt'] as string;

      // Regardless of host TZ, the processor re-encodes EXIF wall-clock digits
      // as UTC via Date.UTC(dto.getFullYear(), ..., dto.getHours(), ...) so the
      // result is always the literal wall-clock digits in the EXIF string.
      expect(capturedAt).toBe('2026-06-20T20:16:07.438Z');
    });
  });
});
