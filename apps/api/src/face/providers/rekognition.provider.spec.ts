/**
 * Unit tests for RekognitionProvider.
 *
 * Mocks the entire @aws-sdk/client-rekognition module.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-rekognition', () => ({
  RekognitionClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  DetectFacesCommand: jest.fn().mockImplementation((input) => input),
  ListCollectionsCommand: jest.fn().mockImplementation((input) => input),
  IndexFacesCommand: jest.fn().mockImplementation((input) => input),
  SearchFacesByImageCommand: jest.fn().mockImplementation((input) => input),
}));

import { RekognitionProvider } from './rekognition.provider';
import type { FaceProviderCredentials } from './face-provider.interface';

const validCreds: FaceProviderCredentials = {
  region: 'us-east-1',
};

describe('RekognitionProvider', () => {
  let provider: RekognitionProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new RekognitionProvider();
  });

  // ---------------------------------------------------------------------------
  // capabilities
  // ---------------------------------------------------------------------------
  describe('capabilities', () => {
    it('has detect:true, embed:false, delegatedRecognize:true', () => {
      expect(provider.capabilities).toEqual({
        detect: true,
        embed: false,
        delegatedRecognize: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // listModels
  // ---------------------------------------------------------------------------
  describe('listModels', () => {
    it('returns ["rekognition-2023"] statically', async () => {
      const result = await provider.listModels(validCreds);
      expect(result).toEqual(['rekognition-2023']);
    });
  });

  // ---------------------------------------------------------------------------
  // detect
  // ---------------------------------------------------------------------------
  describe('detect', () => {
    const testImage = Buffer.from('fake-image-data');

    it('maps AWS BoundingBox {Left, Top, Width, Height} to {x, y, w, h}', async () => {
      mockSend.mockResolvedValue({
        FaceDetails: [
          {
            BoundingBox: { Left: 0.1, Top: 0.2, Width: 0.3, Height: 0.4 },
            Confidence: 99.0,
          },
        ],
      });

      const results = await provider.detect(validCreds, testImage);

      expect(results).toHaveLength(1);
      expect(results[0].boundingBox).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    });

    it('normalizes AWS Confidence (95 → 0.95)', async () => {
      mockSend.mockResolvedValue({
        FaceDetails: [
          {
            BoundingBox: { Left: 0.0, Top: 0.0, Width: 1.0, Height: 1.0 },
            Confidence: 95.0,
          },
        ],
      });

      const results = await provider.detect(validCreds, testImage);

      expect(results[0].confidence).toBeCloseTo(0.95);
    });

    it('does not include embedding in result (embed:false)', async () => {
      mockSend.mockResolvedValue({
        FaceDetails: [
          {
            BoundingBox: { Left: 0.0, Top: 0.0, Width: 1.0, Height: 1.0 },
            Confidence: 90.0,
          },
        ],
      });

      const results = await provider.detect(validCreds, testImage);

      expect(results[0].embedding).toBeUndefined();
    });

    it('returns [] when FaceDetails is undefined', async () => {
      mockSend.mockResolvedValue({ FaceDetails: undefined });

      const results = await provider.detect(validCreds, testImage);

      expect(results).toEqual([]);
    });

    it('returns [] when FaceDetails is an empty array', async () => {
      mockSend.mockResolvedValue({ FaceDetails: [] });

      const results = await provider.detect(validCreds, testImage);

      expect(results).toEqual([]);
    });

    it('uses region from creds when provided', async () => {
      const { RekognitionClient } = jest.requireMock('@aws-sdk/client-rekognition');
      mockSend.mockResolvedValue({ FaceDetails: [] });

      const creds: FaceProviderCredentials = { region: 'eu-west-1' };
      await provider.detect(creds, testImage);

      expect(RekognitionClient).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'eu-west-1' }),
      );
    });

    it('defaults to us-east-1 when region is not provided', async () => {
      const { RekognitionClient } = jest.requireMock('@aws-sdk/client-rekognition');
      mockSend.mockResolvedValue({ FaceDetails: [] });

      await provider.detect({}, testImage);

      expect(RekognitionClient).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'us-east-1' }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // testConnection
  // ---------------------------------------------------------------------------
  describe('testConnection', () => {
    it('returns {ok:true} when ListCollections send succeeds', async () => {
      mockSend.mockResolvedValue({ CollectionIds: [] });

      const result = await provider.testConnection(validCreds);

      expect(result).toEqual({ ok: true });
    });

    it('returns {ok:false, error:message} when send throws', async () => {
      mockSend.mockRejectedValue(new Error('AccessDeniedException'));

      const result = await provider.testConnection(validCreds);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/AccessDeniedException/);
    });

    it('returns {ok:false, error:...} for unknown string throws', async () => {
      mockSend.mockRejectedValue('some string error');

      const result = await provider.testConnection(validCreds);

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
