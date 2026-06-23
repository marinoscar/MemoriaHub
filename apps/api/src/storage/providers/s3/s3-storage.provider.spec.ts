/**
 * Unit tests for S3StorageProvider — retry/backoff and checksum configuration.
 *
 * Strategy: mock `@aws-sdk/client-s3` so the S3Client constructor is a spy.
 * Capture the options object passed to `new S3Client(...)` and assert:
 *
 *  1. maxAttempts comes from ConfigService (custom value forwarded)
 *  2. retryMode comes from ConfigService (custom value forwarded)
 *  3. Default values match configuration.ts defaults: maxAttempts=5, retryMode='adaptive'
 *
 *  4. requestChecksumCalculation is 'WHEN_REQUIRED' on BOTH construction paths
 *  5. responseChecksumValidation is 'WHEN_REQUIRED' on BOTH construction paths
 *
 * The checksum assertions (4 & 5) lock in the R2 compatibility fix:
 * since SDK v3.729 the SDK default changed to 'WHEN_SUPPORTED', adding CRC32
 * streaming-trailer checksums (aws-chunked) to server-side PutObject / Upload
 * calls.  Cloudflare R2 rejects those with HTTP 400.  'WHEN_REQUIRED' restores
 * pre-3.729 behaviour and is safe for both R2 and real AWS S3.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

// We must mock the AWS SDK BEFORE importing the provider so the constructor spy
// is in place when the module is loaded.
const mockS3ClientConstructor = jest.fn();
const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const original = jest.requireActual('@aws-sdk/client-s3') as any;
  return {
    ...original,
    S3Client: jest.fn().mockImplementation((opts: unknown) => {
      mockS3ClientConstructor(opts);
      return { send: mockS3Send };
    }),
  };
});

// Import AFTER mocking
import { S3StorageProvider, S3ProviderConfig } from './s3-storage.provider';

// ---------------------------------------------------------------------------
// Helper: build a ConfigService mock that returns specific values for known
// keys and sensible defaults for everything else.
// ---------------------------------------------------------------------------

function buildConfigMock(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    'storage.s3.region': 'us-east-1',
    'storage.s3.endpoint': undefined,
    'storage.s3.accessKeyId': '',
    'storage.s3.secretAccessKey': '',
    'storage.s3.bucket': 'test-bucket',
    'storage.s3.maxAttempts': 5,
    'storage.s3.retryMode': 'adaptive',
  };

  const config = { ...defaults, ...overrides };

  return {
    get: jest.fn((key: string, defaultVal?: unknown) => {
      if (key in config) return config[key];
      return defaultVal;
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('S3StorageProvider — retry config wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // maxAttempts wiring
  // -------------------------------------------------------------------------

  describe('maxAttempts', () => {
    it('passes maxAttempts from ConfigService to S3Client constructor', async () => {
      const mockConfig = buildConfigMock({ 'storage.s3.maxAttempts': 8 });

      await Test.createTestingModule({
        providers: [
          S3StorageProvider,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const constructorArg = mockS3ClientConstructor.mock.calls[0][0] as Record<string, unknown>;
      expect(constructorArg.maxAttempts).toBe(8);
    });

    it('uses the default maxAttempts of 5 when ConfigService returns the default', async () => {
      const mockConfig = buildConfigMock(); // default maxAttempts: 5

      await Test.createTestingModule({
        providers: [
          S3StorageProvider,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const constructorArg = mockS3ClientConstructor.mock.calls[0][0] as Record<string, unknown>;
      expect(constructorArg.maxAttempts).toBe(5);
    });

    it('ConfigService is queried with key "storage.s3.maxAttempts" and default 5', async () => {
      const mockConfig = buildConfigMock();

      await Test.createTestingModule({
        providers: [
          S3StorageProvider,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      // Verify ConfigService.get was called with the correct key
      const getCalls = (mockConfig.get as jest.Mock).mock.calls as [string, unknown][];
      const maxAttemptsCall = getCalls.find((c) => c[0] === 'storage.s3.maxAttempts');
      expect(maxAttemptsCall).toBeDefined();
      // Second arg is the default value
      expect(maxAttemptsCall![1]).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // retryMode wiring
  // -------------------------------------------------------------------------

  describe('retryMode', () => {
    it('passes retryMode from ConfigService to S3Client constructor', async () => {
      const mockConfig = buildConfigMock({ 'storage.s3.retryMode': 'standard' });

      await Test.createTestingModule({
        providers: [
          S3StorageProvider,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const constructorArg = mockS3ClientConstructor.mock.calls[0][0] as Record<string, unknown>;
      expect(constructorArg.retryMode).toBe('standard');
    });

    it('uses the default retryMode of "adaptive" when ConfigService returns the default', async () => {
      const mockConfig = buildConfigMock(); // default retryMode: 'adaptive'

      await Test.createTestingModule({
        providers: [
          S3StorageProvider,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const constructorArg = mockS3ClientConstructor.mock.calls[0][0] as Record<string, unknown>;
      expect(constructorArg.retryMode).toBe('adaptive');
    });

    it('ConfigService is queried with key "storage.s3.retryMode" and default "adaptive"', async () => {
      const mockConfig = buildConfigMock();

      await Test.createTestingModule({
        providers: [
          S3StorageProvider,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const getCalls = (mockConfig.get as jest.Mock).mock.calls as [string, unknown][];
      const retryModeCall = getCalls.find((c) => c[0] === 'storage.s3.retryMode');
      expect(retryModeCall).toBeDefined();
      expect(retryModeCall![1]).toBe('adaptive');
    });

    it('passes "legacy" retryMode through correctly', async () => {
      const mockConfig = buildConfigMock({ 'storage.s3.retryMode': 'legacy' });

      await Test.createTestingModule({
        providers: [
          S3StorageProvider,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const constructorArg = mockS3ClientConstructor.mock.calls[0][0] as Record<string, unknown>;
      expect(constructorArg.retryMode).toBe('legacy');
    });
  });

  // -------------------------------------------------------------------------
  // Both values together
  // -------------------------------------------------------------------------

  describe('maxAttempts + retryMode together', () => {
    it('S3Client constructor is called exactly once per provider instantiation', async () => {
      const mockConfig = buildConfigMock();

      await Test.createTestingModule({
        providers: [
          S3StorageProvider,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      expect(mockS3ClientConstructor).toHaveBeenCalledTimes(1);
    });

    it('configuration.ts defaults (maxAttempts=5, retryMode=adaptive) match what S3Client receives', async () => {
      // This test documents the contract between configuration.ts and the S3 constructor
      const mockConfig = buildConfigMock({
        'storage.s3.maxAttempts': 5,
        'storage.s3.retryMode': 'adaptive',
      });

      await Test.createTestingModule({
        providers: [
          S3StorageProvider,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const constructorArg = mockS3ClientConstructor.mock.calls[0][0] as Record<string, unknown>;
      expect(constructorArg.maxAttempts).toBe(5);
      expect(constructorArg.retryMode).toBe('adaptive');
    });
  });
});

// ---------------------------------------------------------------------------
// Checksum configuration — R2 / S3-compatible store compatibility fix
//
// Since SDK v3.729 the default requestChecksumCalculation changed to
// 'WHEN_SUPPORTED', which adds CRC32 streaming-trailer checksums (aws-chunked)
// to server-side PutObject / Upload requests.  Cloudflare R2 rejects these
// with HTTP 400.  Both S3Client construction paths must use 'WHEN_REQUIRED' so
// checksums are only sent when the operation mandates one.
// ---------------------------------------------------------------------------

describe('S3StorageProvider — checksum configuration (R2 compatibility)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // ConfigService path (DI-injected, used in production NestJS modules)
  // -------------------------------------------------------------------------

  describe('ConfigService path', () => {
    it('passes requestChecksumCalculation: WHEN_REQUIRED to S3Client', async () => {
      const mockConfig = buildConfigMock();

      await Test.createTestingModule({
        providers: [
          S3StorageProvider,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const constructorArg = mockS3ClientConstructor.mock.calls[0][0] as Record<string, unknown>;
      expect(constructorArg.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    });

    it('passes responseChecksumValidation: WHEN_REQUIRED to S3Client', async () => {
      const mockConfig = buildConfigMock();

      await Test.createTestingModule({
        providers: [
          S3StorageProvider,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const constructorArg = mockS3ClientConstructor.mock.calls[0][0] as Record<string, unknown>;
      expect(constructorArg.responseChecksumValidation).toBe('WHEN_REQUIRED');
    });
  });

  // -------------------------------------------------------------------------
  // Explicit-config path (used by StorageProviderResolver for DB credentials)
  // -------------------------------------------------------------------------

  describe('explicit-config path', () => {
    const explicitConfig: S3ProviderConfig = {
      region: 'auto',
      endpoint: 'https://account.r2.cloudflarestorage.com',
      accessKeyId: 'r2-key',
      secretAccessKey: 'r2-secret',
      bucket: 'media',
    };

    it('passes requestChecksumCalculation: WHEN_REQUIRED to S3Client', () => {
      const mockConfig = buildConfigMock();
      new S3StorageProvider(mockConfig as unknown as ConfigService, explicitConfig);

      const constructorArg = mockS3ClientConstructor.mock.calls[0][0] as Record<string, unknown>;
      expect(constructorArg.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    });

    it('passes responseChecksumValidation: WHEN_REQUIRED to S3Client', () => {
      const mockConfig = buildConfigMock();
      new S3StorageProvider(mockConfig as unknown as ConfigService, explicitConfig);

      const constructorArg = mockS3ClientConstructor.mock.calls[0][0] as Record<string, unknown>;
      expect(constructorArg.responseChecksumValidation).toBe('WHEN_REQUIRED');
    });

    it('still forwards region, endpoint, and credentials from explicit config', () => {
      const mockConfig = buildConfigMock();
      new S3StorageProvider(mockConfig as unknown as ConfigService, explicitConfig);

      const constructorArg = mockS3ClientConstructor.mock.calls[0][0] as Record<string, unknown>;
      expect(constructorArg.region).toBe('auto');
      expect(constructorArg.endpoint).toBe('https://account.r2.cloudflarestorage.com');
      expect(constructorArg.credentials).toEqual({
        accessKeyId: 'r2-key',
        secretAccessKey: 'r2-secret',
      });
    });
  });
});
