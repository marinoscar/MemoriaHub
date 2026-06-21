/**
 * Unit tests — ReverseGeocodeProcessor
 *
 * Fixture strategy:
 *   - GeoLocationProvider is injected via NestJS DI and mocked with jest.fn().
 *   - exifr is mocked at the module level with jest.mock() (hoisted by Jest)
 *     so we can control the GPS parse result via `mockExifrParse`.
 *   - A real 4×4 JPEG buffer is used as the stream payload; only exifr's
 *     parse return value matters, not the actual bytes.
 *
 * NOTE on exifr mocking:
 *   The processor uses `import('exifr')` (a dynamic import).  Jest's
 *   jest.mock() hoisting intercepts dynamic imports in the same way as static
 *   ones, so a top-level jest.mock('exifr', ...) works correctly here.
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  GeoLocationResult,
} from '../../../src/media/geo/geo-location-provider.interface';
import { GeoLocationService } from '../../../src/media/geo/geo-location.service';
import { ReverseGeocodeProcessor } from '../../../src/storage/processing/processors/reverse-geocode.processor';
import { getPlainJpegBuffer, makeGetStream } from '../../fixtures/media/image-fixtures';

// ---------------------------------------------------------------------------
// Module-level exifr mock
// ---------------------------------------------------------------------------
// mockExifrParseResult holds the value that the mock parse() returns.
// Tests mutate this variable in beforeEach to control what GPS data the
// processor sees.
let mockExifrParseResult: Record<string, unknown> | undefined = undefined;

jest.mock('exifr', () => ({
  // exifr default export pattern — the processor accesses `mod.default ?? mod`
  parse: jest.fn(async () => mockExifrParseResult),
  default: {
    parse: jest.fn(async () => mockExifrParseResult),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeObject(mimeType = 'image/jpeg') {
  return {
    id: 'obj-geo-001',
    mimeType,
    name: 'photo.jpg',
    size: BigInt(0),
    storageKey: 'key',
    storageProvider: 's3',
    bucket: 'bucket',
    status: 'ready',
    s3UploadId: null,
    uploadedById: 'user-1',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
}

const MOCK_GEO_RESULT: GeoLocationResult = {
  country: 'Costa Rica',
  countryCode: 'CR',
  admin1: 'Alajuela',
  admin2: 'San Carlos',
  locality: 'La Fortuna',
  placeName: 'Arenal Volcano',
};

const FIXTURE_LAT = 10.462;
const FIXTURE_LNG = -84.703;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ReverseGeocodeProcessor', () => {
  let processor: ReverseGeocodeProcessor;
  let mockGeoService: jest.Mocked<Pick<GeoLocationService, 'reverseGeocode'>>;

  async function buildModule() {
    mockGeoService = {
      reverseGeocode: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReverseGeocodeProcessor,
        {
          provide: GeoLocationService,
          useValue: mockGeoService,
        },
      ],
    }).compile();

    return module.get<ReverseGeocodeProcessor>(ReverseGeocodeProcessor);
  }

  beforeEach(async () => {
    mockExifrParseResult = undefined;
    processor = await buildModule();
    jest.clearAllMocks();
    // Reset mock to the standard resolved value after clearAllMocks wipes it
    mockGeoService.reverseGeocode.mockResolvedValue({
      result: MOCK_GEO_RESULT,
      source: 'geonames-offline',
    });
  });

  describe('processor identity', () => {
    it('should have name "geocode"', () => {
      expect(processor.name).toBe('geocode');
    });

    it('should have priority 30', () => {
      expect(processor.priority).toBe(30);
    });
  });

  describe('canProcess', () => {
    it('should return true for image/jpeg', () => {
      expect(processor.canProcess(makeObject('image/jpeg'))).toBe(true);
    });

    it('should return true for image/png', () => {
      expect(processor.canProcess(makeObject('image/png'))).toBe(true);
    });

    it('should return true for image/heic', () => {
      expect(processor.canProcess(makeObject('image/heic'))).toBe(true);
    });

    it('should return false for video/mp4', () => {
      expect(processor.canProcess(makeObject('video/mp4'))).toBe(false);
    });

    it('should return false for video/quicktime', () => {
      expect(processor.canProcess(makeObject('video/quicktime'))).toBe(false);
    });

    it('should return false for application/pdf', () => {
      expect(processor.canProcess(makeObject('application/pdf'))).toBe(false);
    });
  });

  describe('process — image WITH GPS (exifr mocked to return lat/lng)', () => {
    beforeEach(() => {
      mockExifrParseResult = {
        latitude: FIXTURE_LAT,
        longitude: FIXTURE_LNG,
      };
      mockGeoService.reverseGeocode.mockResolvedValue({
        result: MOCK_GEO_RESULT,
        source: 'geonames-offline',
      });
    });

    it('should return success:true', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.success).toBe(true);
    });

    it('should call reverseGeocode with the correct lat/lng', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      expect(mockGeoService.reverseGeocode).toHaveBeenCalledTimes(1);
      expect(mockGeoService.reverseGeocode).toHaveBeenCalledWith(FIXTURE_LAT, FIXTURE_LNG);
    });

    it('should write country to metadata', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.country).toBe('Costa Rica');
    });

    it('should write countryCode to metadata', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.countryCode).toBe('CR');
    });

    it('should write admin1 to metadata', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.admin1).toBe('Alajuela');
    });

    it('should write admin2 to metadata', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.admin2).toBe('San Carlos');
    });

    it('should write locality to metadata', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.locality).toBe('La Fortuna');
    });

    it('should write placeName to metadata', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.placeName).toBe('Arenal Volcano');
    });

    it('should write source "geonames-offline" to metadata', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata?.source).toBe('geonames-offline');
    });

    it('should write geocodedAt as a valid ISO 8601 string', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(typeof result.metadata?.geocodedAt).toBe('string');
      expect(new Date(result.metadata?.geocodedAt as string).getTime()).not.toBeNaN();
    });
  });

  describe('process — image WITHOUT GPS (exifr returns undefined)', () => {
    beforeEach(() => {
      mockExifrParseResult = undefined;
    });

    it('should return success:true without throwing', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return empty metadata object', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.metadata).toEqual({});
    });

    it('should NOT call the geo provider', async () => {
      const buf = await getPlainJpegBuffer();
      await processor.process(makeObject(), makeGetStream(buf));
      expect(mockGeoService.reverseGeocode).not.toHaveBeenCalled();
    });
  });

  describe('process — exifr returns object without numeric lat/lng', () => {
    beforeEach(() => {
      // EXIF present but no GPS coordinates
      mockExifrParseResult = { Make: 'Apple', Model: 'iPhone 15 Pro' };
    });

    it('should no-op and return empty metadata without calling provider', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.success).toBe(true);
      expect(result.metadata).toEqual({});
      expect(mockGeoService.reverseGeocode).not.toHaveBeenCalled();
    });
  });

  describe('process — geo provider returns null', () => {
    beforeEach(() => {
      mockExifrParseResult = { latitude: 0, longitude: 0 };
      mockGeoService.reverseGeocode.mockResolvedValue({
        result: null,
        source: 'geonames-offline',
      });
    });

    it('should return success:true with empty metadata when provider returns null', async () => {
      const buf = await getPlainJpegBuffer();
      const result = await processor.process(makeObject(), makeGetStream(buf));
      expect(result.success).toBe(true);
      expect(result.metadata).toEqual({});
    });
  });
});
