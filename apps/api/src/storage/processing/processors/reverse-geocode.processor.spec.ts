/**
 * Unit tests for ReverseGeocodeProcessor.
 *
 * exifr is mocked so no real image parsing happens; GeoLocationService is mocked
 * so no provider/DB/network is touched.
 *
 * REGRESSION: a non-finite GPS coordinate (NaN latitude/longitude — exifr's
 * computed result for an empty GPS block, e.g. GPSLatitude=[null,null,null]
 * written by phones with location off) must NOT reach the geocoder. `typeof NaN`
 * is `'number'`, so the old typeof guard let it through and the offline kd-tree
 * geocoder stamped a bogus nearest city (Talnakh, RU).
 */

// ---------------------------------------------------------------------------
// Mock exifr so parse() returns whatever GPS block the test wants.
// ---------------------------------------------------------------------------

jest.mock('exifr', () => ({
  parse: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'stream';
import { StorageObject, StorageObjectStatus } from '@prisma/client';
import { ReverseGeocodeProcessor } from './reverse-geocode.processor';
import { GeoLocationService } from '../../../media/geo/geo-location.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exifrParseMock(): jest.Mock {
  return jest.requireMock('exifr').parse as jest.Mock;
}

function makeStorageObject(overrides: Partial<StorageObject> = {}): StorageObject {
  return {
    id: 'obj-1',
    name: 'photo.jpg',
    size: BigInt(12345),
    mimeType: 'image/jpeg',
    storageKey: 'uploads/photo.jpg',
    storageProvider: 's3',
    bucket: null,
    status: StorageObjectStatus.ready,
    s3UploadId: null,
    metadata: null,
    uploadedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as StorageObject;
}

function makeGetStream(content: Buffer = Buffer.from('fake-image-data')): () => Promise<Readable> {
  return () => Promise.resolve(Readable.from([content]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReverseGeocodeProcessor', () => {
  let processor: ReverseGeocodeProcessor;
  let parse: jest.Mock;
  let mockGeoLocationService: { reverseGeocode: jest.Mock };

  beforeEach(async () => {
    parse = exifrParseMock();
    parse.mockReset();

    mockGeoLocationService = { reverseGeocode: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReverseGeocodeProcessor,
        { provide: GeoLocationService, useValue: mockGeoLocationService },
      ],
    }).compile();

    processor = module.get<ReverseGeocodeProcessor>(ReverseGeocodeProcessor);
  });

  // -------------------------------------------------------------------------
  // canProcess
  // -------------------------------------------------------------------------

  describe('canProcess', () => {
    it('returns true for image/* MIME types', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'image/jpeg' }))).toBe(true);
    });

    it('returns false for video/* MIME types', () => {
      expect(processor.canProcess(makeStorageObject({ mimeType: 'video/mp4' }))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Non-finite / missing GPS — must NOT reach the geocoder
  // -------------------------------------------------------------------------

  describe('when GPS is non-finite or absent', () => {
    it.each([
      ['NaN latitude and longitude', { latitude: NaN, longitude: NaN }],
      ['NaN latitude only', { latitude: NaN, longitude: -84.0907 }],
      ['NaN longitude only', { latitude: 9.9281, longitude: NaN }],
      ['null latitude', { latitude: null, longitude: -84.0907 }],
      ['undefined coords', { latitude: undefined, longitude: undefined }],
      ['no GPS block (undefined)', undefined],
      ['empty GPS block', {}],
      ['Infinity latitude', { latitude: Infinity, longitude: -84.0907 }],
    ])('returns a clean no-op without calling the geocoder for %s', async (_label, gps) => {
      parse.mockResolvedValue(gps as any);

      const result = await processor.process(makeStorageObject(), makeGetStream());

      expect(result).toEqual({ success: true, metadata: {} });
      expect(mockGeoLocationService.reverseGeocode).not.toHaveBeenCalled();
    });

    it('REGRESSION: an empty GPS array yielding NaN does not produce a geocode result', async () => {
      // exifr computes latitude=NaN for GPSLatitude=[null,null,null] (location off).
      parse.mockResolvedValue({
        GPSLatitude: [null, null, null],
        GPSLongitude: [null, null, null],
        latitude: NaN,
        longitude: NaN,
      } as any);

      const result = await processor.process(makeStorageObject(), makeGetStream());

      expect(result).toEqual({ success: true, metadata: {} });
      expect(mockGeoLocationService.reverseGeocode).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Valid GPS — happy path
  // -------------------------------------------------------------------------

  describe('when GPS is a valid finite coordinate pair', () => {
    beforeEach(() => {
      parse.mockResolvedValue({ latitude: 9.9281, longitude: -84.0907 } as any);
    });

    it('calls the geocoder and returns the resolved metadata', async () => {
      mockGeoLocationService.reverseGeocode.mockResolvedValue({
        result: {
          country: 'Costa Rica',
          countryCode: 'CR',
          locality: 'La Fortuna',
          placeName: 'La Fortuna, Costa Rica',
        },
        source: 'geonames-offline',
      });

      const result = await processor.process(makeStorageObject(), makeGetStream());

      expect(mockGeoLocationService.reverseGeocode).toHaveBeenCalledWith(9.9281, -84.0907);
      expect(result.success).toBe(true);
      expect(result.metadata).toMatchObject({
        country: 'Costa Rica',
        countryCode: 'CR',
        locality: 'La Fortuna',
        source: 'geonames-offline',
      });
    });

    it('returns a clean no-op when the geocoder yields no result', async () => {
      mockGeoLocationService.reverseGeocode.mockResolvedValue({ result: null, source: 'geonames-offline' });

      const result = await processor.process(makeStorageObject(), makeGetStream());

      expect(result).toEqual({ success: true, metadata: {} });
    });
  });
});
