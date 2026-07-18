/**
 * Unit tests for DoctorService.
 *
 * Verifies the on-demand configuration health sweep: report structure
 * (sections/summary/timing), exception normalization for checks whose
 * dependency throws, per-check timeout handling, feature-off → skipped
 * semantics, feature-flag/provider consistency checks, and the pgvector
 * missing-extension/table error path.
 *
 * No database required — PrismaService and all injected settings/admin
 * services are fully mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { DoctorService } from './doctor.service';
import { DoctorCheck, DoctorReport } from './doctor.types';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService, ResolvedSettings } from '../settings/system-settings/system-settings.service';
import { AiSettingsService } from '../ai/ai-settings.service';
import { FaceSettingsService } from '../face/face-settings.service';
import { GeoSettingsService } from '../geo/geo-settings.service';
import { StorageSettingsService } from '../storage-settings/storage-settings.service';
import { EnrichmentAdminService } from '../enrichment/enrichment-admin.service';
import { SocialMediaOcrService } from '../social-media/social-media-ocr.service';
import { VisualEmbeddingService } from '../dedup/visual-embedding.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flattens report.sections[].checks[] and returns the check by key. */
function findCheck(report: DoctorReport, key: string): DoctorCheck {
  for (const section of report.sections) {
    const check = section.checks.find((c) => c.key === key);
    if (check) return check;
  }
  throw new Error(`Check not found: ${key}`);
}

/** Routes prisma.$queryRaw calls to a canned result based on substring match
 * against the joined template-literal SQL text, so tests don't depend on the
 * concurrent call ordering of the 25 checks. */
function mockQueryRawByText(prisma: MockPrismaService, handlers: Array<[string, unknown]>): void {
  (prisma.$queryRaw as unknown as jest.Mock).mockImplementation((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    for (const [needle, value] of handlers) {
      if (text.includes(needle)) {
        return Promise.resolve(value);
      }
    }
    return Promise.resolve([]);
  });
}

/** Mocks the worker-node/enrichment-job Prisma calls used by the Worker Nodes
 * section's four checks so they resolve to 'skipped'/'ok' (no nodes
 * registered) rather than throwing on the deep-mocked Prisma client's default
 * `undefined` return value. */
function mockNoWorkerNodes(prisma: MockPrismaService): void {
  (prisma.workerNode.count as jest.Mock).mockResolvedValue(0);
  (prisma.workerNode.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);
}

function healthyQueryRawHandlers(): Array<[string, unknown]> {
  return [
    ['_prisma_migrations', [{ n: 0 }]],
    ['pg_extension', [{ ok: 1 }]],
    ['to_regclass', [{ t: 'media_item_embedding' }]],
    ['SELECT 1', [{ '?column?': 1 }]],
  ];
}

function makeSettings(overrides: Partial<ResolvedSettings> = {}): ResolvedSettings {
  return {
    ui: { allowUserThemeOverride: true },
    features: { autoTagging: false, faceRecognition: false, burstDetection: false },
    ai: {
      features: {
        search: { provider: null, model: null },
        tagging: { provider: null, model: null },
        embedding: { provider: null, model: null },
      },
    },
    face: {
      features: { detection: { provider: null, model: null } },
      video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 },
    },
    storage: {
      activeProvider: 's3',
      insights: { refreshIntervalHours: 4 },
      trash: { retentionDays: 30 },
    },
    burst: { timeGapSeconds: 10, hashDistance: 10, minGroupSize: 3 },
    geo: { reverseProvider: 'offline', forwardSearchEnabled: false },
    jobs: { history: { retentionDays: 30, purgeEnabled: true } },
    updatedAt: new Date(),
    updatedBy: null,
    version: 1,
    ...overrides,
  } as ResolvedSettings;
}

function makeHealthySettings(overrides: Partial<ResolvedSettings> = {}): ResolvedSettings {
  return makeSettings({
    features: { autoTagging: true, faceRecognition: true, burstDetection: true },
    ai: {
      features: {
        search: { provider: 'openai', model: 'gpt-4o' },
        tagging: { provider: 'openai', model: 'gpt-4o' },
        embedding: { provider: 'openai', model: 'text-embedding-3-small' },
      },
    },
    face: {
      features: { detection: { provider: 'human', model: null } },
      video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 },
    },
    ...overrides,
  });
}

const VALID_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
const VALID_JWT_SECRET = 'a'.repeat(32);

/** Baseline env — every var Doctor reads set to a healthy value. Merge with
 * overrides and swap in via ORIGINAL_ENV restore in afterEach. */
function healthyEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SECRETS_ENCRYPTION_KEY: VALID_SECRETS_KEY,
    JWT_SECRET: VALID_JWT_SECRET,
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    APP_URL: 'https://app.example.com',
    NODE_ENV: 'test',
    STORAGE_PROVIDER: 's3',
    GEO_PROVIDER: 'offline',
    ENRICHMENT_WORKER_ENABLED: 'true',
    FACE_WORKER_ENABLED: 'true',
    INITIAL_ADMIN_EMAIL: 'admin@example.com',
    ...overrides,
  };
}

const HEALTHY_STATS = {
  total: 0,
  byStatus: { pending: 0, running: 0, succeeded: 0, failed: 0 },
  byType: [],
  stuckRunning: 0,
  scheduled: 0,
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('DoctorService', () => {
  let service: DoctorService;
  let mockPrisma: MockPrismaService;
  let mockSystemSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettings'>>;
  let mockAiSettings: jest.Mocked<Pick<AiSettingsService, 'testProvider' | 'testEmbedding'>>;
  let mockFaceSettings: jest.Mocked<Pick<FaceSettingsService, 'testProvider'>>;
  let mockGeoSettings: jest.Mocked<Pick<GeoSettingsService, 'testProvider'>>;
  let mockStorageSettings: jest.Mocked<Pick<StorageSettingsService, 'testConnection'>>;
  let mockEnrichmentAdmin: jest.Mocked<Pick<EnrichmentAdminService, 'getStats'>>;
  let mockSocialMediaOcr: jest.Mocked<Pick<SocialMediaOcrService, 'getStatus'>>;
  let mockVisualEmbeddingService: jest.Mocked<Pick<VisualEmbeddingService, 'isAvailable'>>;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockSystemSettings = { getSettings: jest.fn() };
    mockAiSettings = { testProvider: jest.fn(), testEmbedding: jest.fn() };
    mockFaceSettings = { testProvider: jest.fn() };
    mockGeoSettings = { testProvider: jest.fn() };
    mockStorageSettings = { testConnection: jest.fn() };
    mockEnrichmentAdmin = { getStats: jest.fn() };
    mockSocialMediaOcr = { getStatus: jest.fn() };
    mockVisualEmbeddingService = { isAvailable: jest.fn().mockReturnValue(true) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DoctorService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
        { provide: AiSettingsService, useValue: mockAiSettings },
        { provide: FaceSettingsService, useValue: mockFaceSettings },
        { provide: GeoSettingsService, useValue: mockGeoSettings },
        { provide: StorageSettingsService, useValue: mockStorageSettings },
        { provide: EnrichmentAdminService, useValue: mockEnrichmentAdmin },
        { provide: SocialMediaOcrService, useValue: mockSocialMediaOcr },
        { provide: VisualEmbeddingService, useValue: mockVisualEmbeddingService },
      ],
    }).compile();

    service = module.get<DoctorService>(DoctorService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  // =========================================================================
  // 1. Happy-ish path / report structure
  // =========================================================================

  describe('report structure (all-healthy fixture)', () => {
    beforeEach(() => {
      process.env = healthyEnv();
      mockSystemSettings.getSettings.mockResolvedValue(makeHealthySettings());
      mockQueryRawByText(mockPrisma, healthyQueryRawHandlers());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockStorageSettings.testConnection.mockResolvedValue({ ok: true, bucket: 'my-bucket' } as any);
      mockEnrichmentAdmin.getStats.mockResolvedValue(HEALTHY_STATS as any);
      mockNoWorkerNodes(mockPrisma);
    });

    it('returns sections in the documented order: core, auth, storage, ai, face, geo, jobs, nodes', async () => {
      const report = await service.runDiagnostics();

      expect(report.sections.map((s) => s.key)).toEqual([
        'core',
        'auth',
        'storage',
        'ai',
        'face',
        'geo',
        'jobs',
        'nodes',
      ]);
    });

    it('produces a summary whose ok+warning+error+skipped sums to total', async () => {
      const report = await service.runDiagnostics();

      const { ok, warning, error, skipped, total } = report.summary;
      expect(ok + warning + error + skipped).toBe(total);
      expect(total).toBeGreaterThan(0);
    });

    it('has no error checks when everything is configured and healthy', async () => {
      const report = await service.runDiagnostics();

      expect(report.summary.error).toBe(0);
    });

    it('returns computedAt as a string and durationMs as a number', async () => {
      const report = await service.runDiagnostics();

      expect(typeof report.computedAt).toBe('string');
      expect(typeof report.durationMs).toBe('number');
    });

    it('gives every individual check a numeric durationMs', async () => {
      const report = await service.runDiagnostics();

      for (const section of report.sections) {
        for (const check of section.checks) {
          expect(typeof check.durationMs).toBe('number');
          expect(check.durationMs).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('includes all 27 documented checks across the 8 sections', async () => {
      const report = await service.runDiagnostics();

      const allKeys = report.sections.flatMap((s) => s.checks.map((c) => c.key));
      expect(allKeys).toEqual([
        'core.database',
        'core.migrations',
        'core.pgvector',
        'core.secretsKey',
        'core.appUrl',
        'auth.jwt',
        'auth.googleOauth',
        'auth.adminBootstrap',
        'storage.activeProvider',
        'storage.liveTest',
        'ai.search',
        'ai.tagging',
        'ai.embedding',
        'ai.flagConsistency',
        'ai.socialMedia',
        'ai.duplicateDetection',
        'ai.pictureEnhancer',
        'face.detection',
        'face.flagConsistency',
        'face.pgvector',
        'geo.reverseProvider',
        'jobs.workerEnabled',
        'jobs.queueHealth',
        'jobs.burstConfig',
        'nodes.registeredCount',
        'nodes.heartbeatFreshness',
        'nodes.staleLeases',
        'nodes.capabilityHealth',
      ]);
    });
  });

  // =========================================================================
  // 2. Thrown exception is normalized to 'error'
  // =========================================================================

  describe('exception normalization', () => {
    beforeEach(() => {
      process.env = healthyEnv();
      mockSystemSettings.getSettings.mockResolvedValue(makeHealthySettings());
      mockQueryRawByText(mockPrisma, healthyQueryRawHandlers());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockEnrichmentAdmin.getStats.mockResolvedValue(HEALTHY_STATS as any);
    });

    it('normalizes a thrown BadRequestException to a status:error check without rejecting the whole run', async () => {
      mockStorageSettings.testConnection.mockRejectedValue(new BadRequestException('no creds'));

      const report = await service.runDiagnostics();

      const check = findCheck(report, 'storage.liveTest');
      expect(check.status).toBe('error');
      expect(check.message).toContain('no creds');
    });

    it('still completes the rest of the report when one dependency throws', async () => {
      mockStorageSettings.testConnection.mockRejectedValue(new BadRequestException('no creds'));

      const report = await service.runDiagnostics();

      // Unrelated checks are unaffected.
      expect(findCheck(report, 'core.database').status).toBe('ok');
      expect(findCheck(report, 'ai.search').status).toBe('ok');
      expect(report.summary.total).toBe(28);
    });
  });

  // =========================================================================
  // 3. Per-check timeout
  // =========================================================================

  describe('per-check timeout', () => {
    it('resolves the hung check as status:error with a timeout message after 10s, while the rest of the report completes', async () => {
      process.env = healthyEnv();
      mockSystemSettings.getSettings.mockResolvedValue(makeHealthySettings());
      mockQueryRawByText(mockPrisma, healthyQueryRawHandlers());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockStorageSettings.testConnection.mockResolvedValue({ ok: true, bucket: 'my-bucket' } as any);
      mockEnrichmentAdmin.getStats.mockResolvedValue(HEALTHY_STATS as any);

      // Geo provider test hangs forever — never resolves or rejects.
      mockGeoSettings.testProvider.mockReturnValue(new Promise(() => {}));

      jest.useFakeTimers();
      try {
        const reportPromise = service.runDiagnostics();
        await jest.advanceTimersByTimeAsync(10_000);
        const report = await reportPromise;

        const hungCheck = findCheck(report, 'geo.reverseProvider');
        expect(hungCheck.status).toBe('error');
        expect(hungCheck.message.toLowerCase()).toContain('timed out');

        // The rest of the report still completed normally.
        expect(findCheck(report, 'core.database').status).toBe('ok');
        expect(findCheck(report, 'ai.search').status).toBe('ok');
        expect(report.summary.total).toBe(28);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // =========================================================================
  // 4. Feature-off → skipped (fresh-install fixture)
  // =========================================================================

  describe('feature-off produces skipped checks (fresh install)', () => {
    beforeEach(() => {
      // Fresh install: env fully healthy, but no AI/face providers configured
      // and all feature flags off — this must not raise any error checks.
      process.env = healthyEnv();
      mockSystemSettings.getSettings.mockResolvedValue(makeSettings()); // all features false, all providers null
      mockQueryRawByText(mockPrisma, healthyQueryRawHandlers());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockStorageSettings.testConnection.mockResolvedValue({ ok: true, bucket: 'my-bucket' } as any);
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockEnrichmentAdmin.getStats.mockResolvedValue(HEALTHY_STATS as any);
      mockNoWorkerNodes(mockPrisma);
      // AI/face provider test methods should not even be called in this fixture,
      // but stub them defensively in case of an unexpected call.
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
    });

    it('marks ai.search as skipped when no search provider/model is configured', async () => {
      const report = await service.runDiagnostics();
      expect(findCheck(report, 'ai.search').status).toBe('skipped');
    });

    it('marks ai.tagging as skipped when no tagging provider/model is configured', async () => {
      const report = await service.runDiagnostics();
      expect(findCheck(report, 'ai.tagging').status).toBe('skipped');
    });

    it('marks ai.embedding as skipped when no embedding provider/model is configured', async () => {
      const report = await service.runDiagnostics();
      expect(findCheck(report, 'ai.embedding').status).toBe('skipped');
    });

    it('marks face.detection as skipped when face recognition is disabled', async () => {
      const report = await service.runDiagnostics();
      expect(findCheck(report, 'face.detection').status).toBe('skipped');
    });

    it('marks jobs.burstConfig as skipped when burst detection is disabled', async () => {
      const report = await service.runDiagnostics();
      expect(findCheck(report, 'jobs.burstConfig').status).toBe('skipped');
    });

    it('produces zero error checks for a fresh-install configuration', async () => {
      const report = await service.runDiagnostics();
      expect(report.summary.error).toBe(0);
    });

    it('does not call out to AI/face provider test methods when unconfigured', async () => {
      await service.runDiagnostics();
      expect(mockAiSettings.testProvider).not.toHaveBeenCalled();
      expect(mockFaceSettings.testProvider).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. Flag inconsistency matrix
  // =========================================================================

  describe('ai.flagConsistency', () => {
    beforeEach(() => {
      process.env = healthyEnv();
      mockQueryRawByText(mockPrisma, healthyQueryRawHandlers());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockStorageSettings.testConnection.mockResolvedValue({ ok: true, bucket: 'my-bucket' } as any);
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockEnrichmentAdmin.getStats.mockResolvedValue(HEALTHY_STATS as any);
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
    });

    it('is status:error when autoTagging is enabled but no tagging provider is configured', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({
          features: { autoTagging: true, faceRecognition: false, burstDetection: false },
          ai: {
            features: {
              search: { provider: null, model: null },
              tagging: { provider: null, model: null },
              embedding: { provider: null, model: null },
            },
          },
        }),
      );

      const report = await service.runDiagnostics();
      expect(findCheck(report, 'ai.flagConsistency').status).toBe('error');
    });

    it('is status:warning when a tagging provider is configured but autoTagging is disabled', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({
          features: { autoTagging: false, faceRecognition: false, burstDetection: false },
          ai: {
            features: {
              search: { provider: null, model: null },
              tagging: { provider: 'openai', model: 'gpt-4o' },
              embedding: { provider: null, model: null },
            },
          },
        }),
      );

      const report = await service.runDiagnostics();
      expect(findCheck(report, 'ai.flagConsistency').status).toBe('warning');
    });

    it('is status:ok when autoTagging is enabled and a tagging provider is configured', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({
          features: { autoTagging: true, faceRecognition: false, burstDetection: false },
          ai: {
            features: {
              search: { provider: null, model: null },
              tagging: { provider: 'openai', model: 'gpt-4o' },
              embedding: { provider: null, model: null },
            },
          },
        }),
      );

      const report = await service.runDiagnostics();
      expect(findCheck(report, 'ai.flagConsistency').status).toBe('ok');
    });
  });

  describe('face.flagConsistency', () => {
    beforeEach(() => {
      process.env = healthyEnv();
      mockQueryRawByText(mockPrisma, healthyQueryRawHandlers());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockStorageSettings.testConnection.mockResolvedValue({ ok: true, bucket: 'my-bucket' } as any);
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockEnrichmentAdmin.getStats.mockResolvedValue(HEALTHY_STATS as any);
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
    });

    it('is status:warning when a face provider is configured but faceRecognition is disabled', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({
          features: { autoTagging: false, faceRecognition: false, burstDetection: false },
          face: {
            features: { detection: { provider: 'human', model: null } },
            video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 },
          },
        }),
      );

      const report = await service.runDiagnostics();
      expect(findCheck(report, 'face.flagConsistency').status).toBe('warning');
    });

    it('is status:ok when faceRecognition is enabled (provider configured)', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({
          features: { autoTagging: false, faceRecognition: true, burstDetection: false },
          face: {
            features: { detection: { provider: 'human', model: null } },
            video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 },
          },
        }),
      );

      const report = await service.runDiagnostics();
      expect(findCheck(report, 'face.flagConsistency').status).toBe('ok');
    });

    it('is status:skipped when faceRecognition is disabled and no provider is configured', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(makeSettings());

      const report = await service.runDiagnostics();
      expect(findCheck(report, 'face.flagConsistency').status).toBe('skipped');
    });
  });

  describe('ai.socialMedia', () => {
    beforeEach(() => {
      process.env = healthyEnv();
      mockQueryRawByText(mockPrisma, healthyQueryRawHandlers());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockStorageSettings.testConnection.mockResolvedValue({ ok: true, bucket: 'my-bucket' } as any);
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockEnrichmentAdmin.getStats.mockResolvedValue(HEALTHY_STATS as any);
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
    });

    it('is status:skipped when social media detection is disabled', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(makeSettings());

      const report = await service.runDiagnostics();
      expect(findCheck(report, 'ai.socialMedia').status).toBe('skipped');
      expect(mockSocialMediaOcr.getStatus).not.toHaveBeenCalled();
    });

    it('is status:ok (two-tier operational) when the feature is on, OCR enabled, and the model is available', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({
          features: { autoTagging: false, faceRecognition: false, burstDetection: false, socialMediaDetection: true } as any,
          socialMedia: {
            ocrEnabled: true,
            ocrLanguages: ['eng'],
            ocrMaxFrames: 4,
            ocrTimeoutSeconds: 60,
            minConfidence: 0.8,
            maxDurationSeconds: 300,
            maxSizeBytes: 500_000_000,
          },
        }),
      );
      mockSocialMediaOcr.getStatus.mockResolvedValue({
        ocrAvailable: true,
        degraded: false,
        modelPath: '/models/tesseract',
        languages: ['eng'],
      });

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'ai.socialMedia');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('Two-tier');
    });

    it('is status:warning (degraded) when OCR is enabled but the model is unavailable', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({
          features: { autoTagging: false, faceRecognition: false, burstDetection: false, socialMediaDetection: true } as any,
          socialMedia: {
            ocrEnabled: true,
            ocrLanguages: ['eng'],
            ocrMaxFrames: 4,
            ocrTimeoutSeconds: 60,
            minConfidence: 0.8,
            maxDurationSeconds: 300,
            maxSizeBytes: 500_000_000,
          },
        }),
      );
      mockSocialMediaOcr.getStatus.mockResolvedValue({
        ocrAvailable: false,
        degraded: true,
        modelPath: '/models/tesseract',
        languages: ['eng'],
      });

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'ai.socialMedia');
      expect(check.status).toBe('warning');
      expect(check.message).toContain('degraded');
    });
  });

  describe('ai.duplicateDetection', () => {
    beforeEach(() => {
      process.env = healthyEnv();
      mockQueryRawByText(mockPrisma, healthyQueryRawHandlers());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockStorageSettings.testConnection.mockResolvedValue({ ok: true, bucket: 'my-bucket' } as any);
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockEnrichmentAdmin.getStats.mockResolvedValue(HEALTHY_STATS as any);
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockNoWorkerNodes(mockPrisma);
    });

    it('is status:skipped when duplicate detection is disabled, and does not consult VisualEmbeddingService', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(makeSettings());

      const report = await service.runDiagnostics();
      expect(findCheck(report, 'ai.duplicateDetection').status).toBe('skipped');
      expect(mockVisualEmbeddingService.isAvailable).not.toHaveBeenCalled();
    });

    it('is status:ok (two-tier operational) when the feature is on and the CLIP model is available', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({
          features: {
            autoTagging: false,
            faceRecognition: false,
            burstDetection: false,
            duplicateDetection: true,
          } as any,
        }),
      );
      mockVisualEmbeddingService.isAvailable.mockReturnValue(true);

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'ai.duplicateDetection');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('Two-tier');
    });

    it('is status:warning (degraded) when the feature is on but the CLIP model is unavailable', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({
          features: {
            autoTagging: false,
            faceRecognition: false,
            burstDetection: false,
            duplicateDetection: true,
          } as any,
        }),
      );
      mockVisualEmbeddingService.isAvailable.mockReturnValue(false);

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'ai.duplicateDetection');
      expect(check.status).toBe('warning');
      expect(check.message).toContain('dHash-only');
      expect(check.actionItem).toBeTruthy();
    });
  });

  // =========================================================================
  // 6. pgvector missing → error
  // =========================================================================

  describe('core.pgvector', () => {
    beforeEach(() => {
      process.env = healthyEnv();
      mockSystemSettings.getSettings.mockResolvedValue(makeHealthySettings());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockStorageSettings.testConnection.mockResolvedValue({ ok: true, bucket: 'my-bucket' } as any);
      mockEnrichmentAdmin.getStats.mockResolvedValue(HEALTHY_STATS as any);
    });

    it('is status:error when the pgvector extension is not installed (empty extension row set)', async () => {
      mockQueryRawByText(mockPrisma, [
        ['_prisma_migrations', [{ n: 0 }]],
        ['pg_extension', []], // extension missing
        ['to_regclass', [{ t: 'media_item_embedding' }]],
        ['SELECT 1', [{ '?column?': 1 }]],
      ]);

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'core.pgvector');
      expect(check.status).toBe('error');
      expect(check.message).toContain('extension');
    });

    it('is status:error when the embedding table is missing (to_regclass returns null)', async () => {
      mockQueryRawByText(mockPrisma, [
        ['_prisma_migrations', [{ n: 0 }]],
        ['pg_extension', [{ ok: 1 }]],
        ['to_regclass', [{ t: null }]], // table missing
        ['SELECT 1', [{ '?column?': 1 }]],
      ]);

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'core.pgvector');
      expect(check.status).toBe('error');
      expect(check.message).toContain('table not found');
    });

    it('is status:ok when both the extension and table are present', async () => {
      mockQueryRawByText(mockPrisma, healthyQueryRawHandlers());

      const report = await service.runDiagnostics();
      expect(findCheck(report, 'core.pgvector').status).toBe('ok');
    });
  });

  // =========================================================================
  // 9. face.pgvector
  // =========================================================================

  describe('face.pgvector', () => {
    // NOTE on handler ordering: mockQueryRawByText matches on SQL-text
    // SUBSTRING and returns the first matching handler in array order. The
    // real `information_schema.columns` query text literally begins with
    // "SELECT 1 AS ok FROM information_schema.columns" (see
    // doctor.service.ts's checkFacePgvector), so it also contains the
    // substring "SELECT 1" used by healthyQueryRawHandlers()'s generic
    // 'SELECT 1' handler (for the plain `SELECT 1` liveness check). If the
    // more specific 'information_schema.columns' / 'pg_indexes' needles were
    // appended AFTER the handlers from healthyQueryRawHandlers() (which is
    // ordered ['_prisma_migrations','pg_extension','to_regclass','SELECT 1']),
    // the broader 'SELECT 1' needle would win the substring match first and
    // this check's `colRows` mock would silently be ignored. This helper
    // therefore inserts the face.pgvector-specific needles BEFORE 'SELECT 1'.
    function faceIndexQueryHandlers(
      colRows: unknown,
      idxRows: unknown,
    ): Array<[string, unknown]> {
      return [
        ['_prisma_migrations', [{ n: 0 }]],
        ['pg_extension', [{ ok: 1 }]],
        ['to_regclass', [{ t: 'media_item_embedding' }]],
        ['information_schema.columns', colRows],
        ['pg_indexes', idxRows],
        ['SELECT 1', [{ '?column?': 1 }]],
      ];
    }

    const ALL_INDEXES = [
      { indexname: 'faces_embedding_vec_hnsw_idx' },
      { indexname: 'faces_embedding_vec_archive_hnsw_idx' },
      { indexname: 'faces_embedding_vec_assigned_hnsw_idx' },
    ];

    beforeEach(() => {
      mockSystemSettings.getSettings.mockResolvedValue(makeHealthySettings());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockStorageSettings.testConnection.mockResolvedValue({ ok: true, bucket: 'my-bucket' } as any);
      mockEnrichmentAdmin.getStats.mockResolvedValue(HEALTHY_STATS as any);
      mockNoWorkerNodes(mockPrisma);
    });

    it('is status:skipped when FACE_VECTOR_BACKEND=app', async () => {
      process.env = healthyEnv({ FACE_VECTOR_BACKEND: 'app' });
      mockQueryRawByText(mockPrisma, healthyQueryRawHandlers());

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'face.pgvector');

      expect(check.status).toBe('skipped');
      expect(check.message).toContain('in-app cosine');
    });

    it('is status:ok when the backend defaults to pgvector (env unset) and both the column and both indexes are present', async () => {
      process.env = healthyEnv();
      mockQueryRawByText(mockPrisma, faceIndexQueryHandlers([{ ok: 1 }], ALL_INDEXES));

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'face.pgvector');

      expect(check.status).toBe('ok');
      expect(check.message).toContain('all three HNSW indexes present');
    });

    it('is status:ok when FACE_VECTOR_BACKEND=pgvector is set explicitly and both the column and both indexes are present', async () => {
      process.env = healthyEnv({ FACE_VECTOR_BACKEND: 'pgvector' });
      mockQueryRawByText(mockPrisma, faceIndexQueryHandlers([{ ok: 1 }], ALL_INDEXES));

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'face.pgvector');

      expect(check.status).toBe('ok');
    });

    it('is status:warning when the embedding_vec column is missing', async () => {
      process.env = healthyEnv();
      mockQueryRawByText(mockPrisma, faceIndexQueryHandlers([], ALL_INDEXES));

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'face.pgvector');

      expect(check.status).toBe('warning');
      expect(check.message).toContain('column is missing');
      expect(check.actionItem).toBeTruthy();
    });

    it('is status:warning when the main HNSW index is missing (column present)', async () => {
      process.env = healthyEnv();
      mockQueryRawByText(mockPrisma, faceIndexQueryHandlers([{ ok: 1 }], []));

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'face.pgvector');

      expect(check.status).toBe('warning');
      expect(check.message).toContain('faces_embedding_vec_hnsw_idx index is missing');
    });

    it('is status:warning when only the partial archive index is missing (column + main index present)', async () => {
      process.env = healthyEnv();
      mockQueryRawByText(
        mockPrisma,
        faceIndexQueryHandlers([{ ok: 1 }], [{ indexname: 'faces_embedding_vec_hnsw_idx' }]),
      );

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'face.pgvector');

      expect(check.status).toBe('warning');
      expect(check.message).toContain('faces_embedding_vec_archive_hnsw_idx');
      expect(check.message).toContain('partial archive index');
      expect(check.actionItem).toBeTruthy();
    });

    it('is status:warning when only the partial assigned-set index is missing (column + main + archive index present)', async () => {
      process.env = healthyEnv();
      mockQueryRawByText(
        mockPrisma,
        faceIndexQueryHandlers(
          [{ ok: 1 }],
          [
            { indexname: 'faces_embedding_vec_hnsw_idx' },
            { indexname: 'faces_embedding_vec_archive_hnsw_idx' },
          ],
        ),
      );

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'face.pgvector');

      expect(check.status).toBe('warning');
      expect(check.message).toContain(
        'faces_embedding_vec_assigned_hnsw_idx (partial assigned-set index) is missing',
      );
    });
  });

  // =========================================================================
  // 10. jobs.workerEnabled — worker-mode aware (ENRICHMENT_WORKER_MODE)
  // =========================================================================

  describe('jobs.workerEnabled — worker mode aware', () => {
    beforeEach(() => {
      mockQueryRawByText(mockPrisma, healthyQueryRawHandlers());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockStorageSettings.testConnection.mockResolvedValue({ ok: true, bucket: 'my-bucket' } as any);
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockEnrichmentAdmin.getStats.mockResolvedValue(HEALTHY_STATS as any);
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockNoWorkerNodes(mockPrisma);
    });

    it("is ok in mode 'all' (explicit) without touching worker_nodes for this check", async () => {
      process.env = healthyEnv({ ENRICHMENT_WORKER_MODE: 'all' });
      mockSystemSettings.getSettings.mockResolvedValue(makeHealthySettings());

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'jobs.workerEnabled');

      expect(check.status).toBe('ok');
      expect(check.message).toContain('mode: all');
    });

    it("is ok when the mode var is unset and the legacy vars are truthy (legacy → 'all')", async () => {
      process.env = healthyEnv(); // ENRICHMENT_WORKER_ENABLED=true, no mode var
      mockSystemSettings.getSettings.mockResolvedValue(makeHealthySettings());

      const report = await service.runDiagnostics();

      expect(findCheck(report, 'jobs.workerEnabled').status).toBe('ok');
    });

    it("is ok in mode 'system' when a fresh heavy-media node is registered", async () => {
      process.env = healthyEnv({ ENRICHMENT_WORKER_MODE: 'system' });
      mockSystemSettings.getSettings.mockResolvedValue(makeHealthySettings());
      (mockPrisma.workerNode.count as jest.Mock).mockResolvedValue(2);

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'jobs.workerEnabled');

      expect(check.status).toBe('ok');
      expect(check.message).toContain('system mode');
      expect(check.message).toContain('2 healthy worker node(s)');
    });

    it('the fresh-node count is scoped to online, fresh-heartbeat nodes serving heavy media types', async () => {
      process.env = healthyEnv({ ENRICHMENT_WORKER_MODE: 'system' });
      mockSystemSettings.getSettings.mockResolvedValue(makeHealthySettings());
      (mockPrisma.workerNode.count as jest.Mock).mockResolvedValue(1);

      await service.runDiagnostics();

      const heavyCall = (mockPrisma.workerNode.count as jest.Mock).mock.calls.find(
        ([arg]) => arg?.where?.eligibleTypes !== undefined,
      );
      expect(heavyCall).toBeDefined();
      const where = heavyCall![0].where;
      expect(where.status).toBe('online');
      expect(where.lastHeartbeatAt.gte).toBeInstanceOf(Date);
      expect(where.eligibleTypes).toEqual({ hasSome: ['face_detection', 'auto_tagging'] });
    });

    it("is warning in mode 'system' when enrichment features are on but no healthy node exists", async () => {
      process.env = healthyEnv({ ENRICHMENT_WORKER_MODE: 'system' });
      mockSystemSettings.getSettings.mockResolvedValue(makeHealthySettings());
      (mockPrisma.workerNode.count as jest.Mock).mockResolvedValue(0);

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'jobs.workerEnabled');

      expect(check.status).toBe('warning');
      expect(check.message).toContain('no healthy worker nodes');
      expect(check.actionItem).toBeTruthy();
    });

    it("is warning (not error) in mode 'system' when no features are on and no nodes exist", async () => {
      process.env = healthyEnv({ ENRICHMENT_WORKER_MODE: 'system' });
      mockSystemSettings.getSettings.mockResolvedValue(makeSettings()); // all features off
      (mockPrisma.workerNode.count as jest.Mock).mockResolvedValue(0);

      const report = await service.runDiagnostics();

      expect(findCheck(report, 'jobs.workerEnabled').status).toBe('warning');
    });

    it("is warning in mode 'off' with fresh nodes — no server fallback", async () => {
      process.env = healthyEnv({ ENRICHMENT_WORKER_MODE: 'off' });
      mockSystemSettings.getSettings.mockResolvedValue(makeHealthySettings());
      (mockPrisma.workerNode.count as jest.Mock).mockResolvedValue(3);

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'jobs.workerEnabled');

      expect(check.status).toBe('warning');
      expect(check.message).toContain('no server fallback');
      expect(check.actionItem).toContain('ENRICHMENT_WORKER_MODE=system');
    });

    it("is error in mode 'off' when enrichment features are on and no healthy nodes exist", async () => {
      process.env = healthyEnv({ ENRICHMENT_WORKER_MODE: 'off' });
      mockSystemSettings.getSettings.mockResolvedValue(makeHealthySettings());
      (mockPrisma.workerNode.count as jest.Mock).mockResolvedValue(0);

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'jobs.workerEnabled');

      expect(check.status).toBe('error');
      expect(check.actionItem).toContain('ENRICHMENT_WORKER_MODE=all');
    });

    it("is error via the LEGACY off switch too (ENRICHMENT_WORKER_ENABLED=false, mode unset)", async () => {
      process.env = healthyEnv({
        ENRICHMENT_WORKER_MODE: undefined,
        ENRICHMENT_WORKER_ENABLED: 'false',
        FACE_WORKER_ENABLED: undefined,
      });
      delete process.env['ENRICHMENT_WORKER_MODE'];
      delete process.env['FACE_WORKER_ENABLED'];
      mockSystemSettings.getSettings.mockResolvedValue(makeHealthySettings());
      (mockPrisma.workerNode.count as jest.Mock).mockResolvedValue(0);

      const report = await service.runDiagnostics();

      expect(findCheck(report, 'jobs.workerEnabled').status).toBe('error');
    });

    it("is plain warning in mode 'off' when no features are on and no nodes exist", async () => {
      process.env = healthyEnv({ ENRICHMENT_WORKER_MODE: 'off' });
      mockSystemSettings.getSettings.mockResolvedValue(makeSettings()); // all features off
      (mockPrisma.workerNode.count as jest.Mock).mockResolvedValue(0);

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'jobs.workerEnabled');

      expect(check.status).toBe('warning');
      expect(check.message).toContain('off');
    });
  });
});
