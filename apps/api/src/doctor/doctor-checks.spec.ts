/**
 * Unit tests for the MemoriaHub Doctor checks (RETRO-B1b, #602).
 *
 * Ported from the old `DoctorService` spec. The 30 checks that stayed in the app
 * are instantiated here with the same mocked services the old service used, and
 * run through a small harness (`runDiagnostics`) that reports them in the OLD
 * shape (section/key, ok|warning|error|skipped, message, actionItem), so the
 * status-ladder assertions below are the ones that guarded the old code:
 *
 *   old key                  new check id
 *   core.pgvector            memoriahub.core.pgvector      (etc.: see KEY_BY_ID)
 *
 * Retired checks (core.database, core.migrations, core.secretsKey) are covered
 * by the platform host core's own checks, not here.
 *
 * Out of scope here (platform-owned): the report envelope, per-check timeout,
 * exception normalisation and dependency skipping (platform Doctor service).
 *
 * No database required: PrismaService and every injected service are mocked.
 */

import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { WorkflowRunStatus, WorkflowTrigger } from '@prisma/client';
import type { DoctorCheck as PlatformDoctorCheck } from '@marinoscar/platform-api/doctor';
import type { PrismaService } from '../prisma/prisma.service';
import type { AppSystemSettings } from '../settings/app-settings.types';
import type { AiSettingsService } from '../ai-port/ai-settings.service';
import type { AiProviderRegistry } from '../ai-port/legacy-ai-provider.registry';
import type { FaceSettingsService } from '../face/face-settings.service';
import type { GeoSettingsService } from '../geo/geo-settings.service';
import type { StorageProviderResolver } from '../platform/storage/storage-provider.resolver';
import type { SocialMediaOcrService } from '../social-media/social-media-ocr.service';
import type { VisualEmbeddingService } from '../dedup/visual-embedding.service';
import type { AndroidAppService } from '../android-app/android-app.service';
import type { AndroidReleaseService } from '../android-app/releases/android-release.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';

import { MEMORIAHUB_DOCTOR_CHECKS } from './doctor-checks.module';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

// ---------------------------------------------------------------------------
// Harness: run the registered checks and report them in the old shape
// ---------------------------------------------------------------------------

type OldStatus = 'ok' | 'warning' | 'error' | 'skipped';

interface DoctorCheck {
  key: string;
  status: OldStatus;
  message: string;
  actionItem?: string;
}

interface DoctorReport {
  summary: { ok: number; warning: number; error: number; skipped: number; total: number };
  checks: DoctorCheck[];
}

const OLD_STATUS: Record<string, OldStatus> = { pass: 'ok', warn: 'warning', fail: 'error', skip: 'skipped' };

/** New check id (without the `memoriahub.` prefix) -> the key the old report used. */
const KEY_BY_ID: Record<string, string> = {
  'core.pgvector': 'core.pgvector',
  'core.app-url': 'core.appUrl',
  'auth.jwt': 'auth.jwt',
  'auth.google-oauth': 'auth.googleOauth',
  'auth.admin-bootstrap': 'auth.adminBootstrap',
  'ai.search': 'ai.search',
  'ai.tagging': 'ai.tagging',
  'ai.embedding': 'ai.embedding',
  'ai.flag-consistency': 'ai.flagConsistency',
  'ai.social-media': 'ai.socialMedia',
  'ai.duplicate-detection': 'ai.duplicateDetection',
  'ai.picture-enhancer': 'ai.pictureEnhancer',
  'ai.video-tagging': 'ai.videoTagging',
  'face.detection': 'face.detection',
  'face.flag-consistency': 'face.flagConsistency',
  'face.pgvector': 'face.pgvector',
  'geo.reverse-provider': 'geo.reverseProvider',
  'jobs.burst-config': 'jobs.burstConfig',
  'nodes.registered-count': 'nodes.registeredCount',
  'nodes.heartbeat-freshness': 'nodes.heartbeatFreshness',
  'nodes.stale-leases': 'nodes.staleLeases',
  'nodes.capability-health': 'nodes.capabilityHealth',
  'workflows.state': 'workflows.state',
  'android.assetlinks': 'android.assetlinks',
  'android.releases': 'android.releases',
  'android.media-sync': 'android.mediaSync',
  'android.upload-path': 'android.uploadPath',
};

function findCheck(report: DoctorReport, key: string): DoctorCheck {
  const check = report.checks.find((c) => c.key === key);
  if (!check) throw new Error(`Check not found: ${key}`);
  return check;
}

/** Routes prisma.$queryRaw calls to a canned result based on substring match
 * against the joined template-literal SQL text, so tests don't depend on the
 * concurrent call ordering of the checks. */
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
  (prisma.mhLegacyWorkerNode.count as jest.Mock).mockResolvedValue(0);
  (prisma.mhLegacyWorkerNode.findMany as jest.Mock).mockResolvedValue([]);
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

function makeSettings(overrides: Record<string, unknown> = {}): AppSystemSettings {
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
      autoArchive: { matchThreshold: 0.45 },
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
  } as unknown as AppSystemSettings;
}

function makeHealthySettings(overrides: Record<string, unknown> = {}): AppSystemSettings {
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
      features: { detection: { provider: 'compreface', model: null } },
      video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 },
      autoArchive: { matchThreshold: 0.45 },
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


// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('MemoriaHub Doctor checks', () => {
  let service: { runDiagnostics: () => Promise<DoctorReport> };
  let mockPrisma: MockPrismaService;
  let mockSystemSettings: jest.Mocked<Pick<AppSystemSettingsService, 'readKnownValue'>>;
  let mockAiSettings: jest.Mocked<Pick<AiSettingsService, 'testProvider' | 'testEmbedding'>>;
  let mockFaceSettings: jest.Mocked<Pick<FaceSettingsService, 'testProvider'>>;
  let mockGeoSettings: jest.Mocked<Pick<GeoSettingsService, 'testProvider'>>;
  let mockStorageProvider: { exists: jest.Mock; getBucket: jest.Mock };
  let mockStorageResolver: { getProviderFor: jest.Mock };
  let mockSocialMediaOcr: jest.Mocked<Pick<SocialMediaOcrService, 'getStatus'>>;
  let mockVisualEmbeddingService: jest.Mocked<Pick<VisualEmbeddingService, 'isAvailable'>>;
  let mockAiProviderRegistry: { get: jest.Mock };
  let mockAndroidApp: jest.Mocked<Pick<AndroidAppService, 'getTrustedApps' | 'getReportedApps'>>;
  let mockAndroidReleases: jest.Mocked<Pick<AndroidReleaseService, 'current' | 'resolveUploadTarget'>>;
  const ORIGINAL_ENV = { ...process.env };

  /**
   * Builds each check with the constructor parameters it declares, matched BY
   * TYPE through Nest's `design:paramtypes` metadata, and runs them all.
   */
  function buildHarness(): { runDiagnostics: () => Promise<DoctorReport> } {
    const tokens: Array<[string, unknown]> = [
      ['DoctorCheckRegistry', { register: jest.fn() }],
      ['PrismaService', mockPrisma as unknown as PrismaService],
      ['AppSystemSettingsService', mockSystemSettings],
      ['AiSettingsService', mockAiSettings],
      ['AiProviderRegistry', mockAiProviderRegistry as unknown as AiProviderRegistry],
      ['FaceSettingsService', mockFaceSettings],
      ['GeoSettingsService', mockGeoSettings],
      ['StorageProviderResolver', mockStorageResolver as unknown as StorageProviderResolver],
      ['SocialMediaOcrService', mockSocialMediaOcr],
      ['VisualEmbeddingService', mockVisualEmbeddingService],
      ['AndroidAppService', mockAndroidApp],
      ['AndroidReleaseService', mockAndroidReleases],
    ];
    const byName = new Map(tokens);

    const instances: PlatformDoctorCheck[] = MEMORIAHUB_DOCTOR_CHECKS.map((Check) => {
      const paramTypes: Array<{ name: string }> = Reflect.getMetadata('design:paramtypes', Check) ?? [];
      const args = paramTypes.map((type) => {
        if (!byName.has(type.name)) throw new Error(`${Check.name}: no test double for ${type.name}`);
        return byName.get(type.name);
      });
      return new (Check as new (...a: unknown[]) => PlatformDoctorCheck)(...args);
    });

    return {
      async runDiagnostics(): Promise<DoctorReport> {
        const checks: DoctorCheck[] = await Promise.all(
          instances.map(async (instance) => {
            // The platform service turns a throw into a `fail`; mirror that guard.
            const outcome = await instance
              .run()
              .catch((err: unknown) => ({ status: 'fail' as const, detail: err instanceof Error ? err.message : String(err), remedy: undefined }));
            const key = KEY_BY_ID[instance.id.replace(/^memoriahub\./, '')];
            if (!key) throw new Error(`Unmapped check id ${instance.id}`);
            return {
              key,
              status: OLD_STATUS[outcome.status],
              message: outcome.detail,
              ...(outcome.remedy ? { actionItem: outcome.remedy } : {}),
            };
          }),
        );
        const summary = { ok: 0, warning: 0, error: 0, skipped: 0, total: 0 };
        for (const c of checks) {
          summary[c.status] += 1;
          summary.total += 1;
        }
        return { summary, checks };
      },
    };
  }

  beforeEach(() => {
    mockPrisma = createMockPrismaService();
    mockSystemSettings = { readKnownValue: jest.fn() };
    // `credentialStatus` (RETRO-E3, #605) answers from the legacy row mock, i.e. a deployment that
    // holds no platform key yet; `AiDeploymentKeySource`'s own spec covers the platform-first order.
    mockAiSettings = {
      testProvider: jest.fn(),
      testEmbedding: jest.fn(),
      credentialStatus: jest.fn(async (provider: string) => {
        const row = await mockPrisma.aiProviderCredential.findUnique({ where: { provider } });
        return { configured: !!row, enabled: !!row && row.enabled === true };
      }),
    } as any;
    mockFaceSettings = { testProvider: jest.fn() };
    mockGeoSettings = { testProvider: jest.fn() };
    // Read-only storage probe: `exists()` on a key that is never written.
    mockStorageProvider = { exists: jest.fn().mockResolvedValue(false), getBucket: jest.fn().mockReturnValue('my-bucket') };
    mockStorageResolver = { getProviderFor: jest.fn().mockResolvedValue(mockStorageProvider) };
    mockSocialMediaOcr = { getStatus: jest.fn() };
    mockVisualEmbeddingService = { isAvailable: jest.fn().mockReturnValue(true) };
    // OpenAI implements transcribeAudio; Anthropic deliberately does not (the
    // ai.videoTagging check reports the latter as a visual-only warning).
    mockAiProviderRegistry = {
      get: jest.fn().mockImplementation((key: string) =>
        key === 'anthropic' ? { key } : { key, transcribeAudio: jest.fn() },
      ),
    };

    // Android app section (#507): defaults to "no device paired, no release,
    // S3 presigned uploads" so the three device-scoped checks are skipped and
    // android.uploadPath is ok in every fixture that does not override them.
    mockAndroidApp = {
      getTrustedApps: jest.fn().mockResolvedValue([]),
      getReportedApps: jest.fn().mockResolvedValue([]),
    };
    mockAndroidReleases = {
      current: jest.fn().mockResolvedValue(null),
      resolveUploadTarget: jest
        .fn()
        .mockResolvedValue({ id: 's3', provider: { partUploadMode: 'presigned' } } as any),
    };
    (mockPrisma.mediaSyncDevice.count as jest.Mock).mockResolvedValue(0);
    (mockPrisma.mediaSyncDevice.findMany as jest.Mock).mockResolvedValue([]);

    service = buildHarness();
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  // =========================================================================
  // 1. Happy-ish path: every kept check is registered and the healthy fixture is clean
  // =========================================================================

  describe('all-healthy fixture', () => {
    beforeEach(() => {
      process.env = healthyEnv();
      mockSystemSettings.readKnownValue.mockResolvedValue(makeHealthySettings());
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
      mockNoWorkerNodes(mockPrisma);
    });

    it('has no failing checks when everything is configured and healthy', async () => {
      const report = await service.runDiagnostics();
      expect(report.summary.error).toBe(0);
      expect(report.summary.ok + report.summary.warning + report.summary.error + report.summary.skipped).toBe(
        report.summary.total,
      );
    });

    it('runs the 27 kept checks (the 35 documented ones minus the 3 the host core and the 2 the jobs slice retired, core.pgClientVersion, replaced by the db-backup slice backup.pg-client, and the two storage checks, replaced by the storage slice storage.config / storage.bucket)', async () => {
      const report = await service.runDiagnostics();

      expect(report.checks.map((c) => c.key)).toEqual([
        'core.pgvector',
        'core.appUrl',
        'auth.jwt',
        'auth.googleOauth',
        'auth.adminBootstrap',
        'ai.search',
        'ai.tagging',
        'ai.embedding',
        'ai.flagConsistency',
        'ai.socialMedia',
        'ai.duplicateDetection',
        'ai.pictureEnhancer',
        'ai.videoTagging',
        'face.detection',
        'face.flagConsistency',
        'face.pgvector',
        'geo.reverseProvider',
        'jobs.burstConfig',
        'nodes.registeredCount',
        'nodes.heartbeatFreshness',
        'nodes.staleLeases',
        'nodes.capabilityHealth',
        'workflows.state',
        'android.assetlinks',
        'android.releases',
        'android.mediaSync',
        'android.uploadPath',
      ]);
    });

    it('gives every ported check a remedy on warn/fail (platform contract rule 2)', async () => {
      process.env = healthyEnv({ APP_URL: undefined });
      const report = await service.runDiagnostics();
      for (const c of report.checks) {
        if (c.status === 'warning' || c.status === 'error') expect(c.actionItem).toBeTruthy();
      }
    });
  });

  // =========================================================================
  // 2. A failing live provider test (the storage live test is the platform's storage.bucket since RETRO-D1)
  // =========================================================================

  describe('live provider tests', () => {
    beforeEach(() => {
      process.env = healthyEnv();
      mockSystemSettings.readKnownValue.mockResolvedValue(makeHealthySettings());
      mockQueryRawByText(mockPrisma, healthyQueryRawHandlers());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({ provider: 's3', enabled: true });
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockNoWorkerNodes(mockPrisma);
    });

    it('a failing live provider test does not stop the other checks from running', async () => {
      mockGeoSettings.testProvider.mockRejectedValue(new Error('geo down'));
      const report = await service.runDiagnostics();
      expect(findCheck(report, 'geo.reverseProvider').status).toBe('error');
      expect(findCheck(report, 'geo.reverseProvider').message).toContain('geo down');
      expect(findCheck(report, 'ai.search').status).toBe('ok');
      expect(report.summary.total).toBe(27);
    });
  });

  // =========================================================================
  // 3. Feature-off -> skipped (fresh-install fixture)
  // =========================================================================

  describe('feature-off produces skipped checks (fresh install)', () => {
    beforeEach(() => {
      // Fresh install: env fully healthy, but no AI/face providers configured
      // and all feature flags off. This must not raise any failing check.
      process.env = healthyEnv();
      mockSystemSettings.readKnownValue.mockResolvedValue(makeSettings()); // all features false, all providers null
      mockQueryRawByText(mockPrisma, healthyQueryRawHandlers());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockNoWorkerNodes(mockPrisma);
      // AI/face provider test methods should not even be called in this fixture,
      // but stub them defensively in case of an unexpected call.
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
    });

    it('marks ai.search as skipped when no search provider/model is configured', async () => {
      expect(findCheck(await service.runDiagnostics(), 'ai.search').status).toBe('skipped');
    });

    it('marks ai.tagging as skipped when no tagging provider/model is configured', async () => {
      expect(findCheck(await service.runDiagnostics(), 'ai.tagging').status).toBe('skipped');
    });

    it('marks ai.embedding as skipped when no embedding provider/model is configured', async () => {
      expect(findCheck(await service.runDiagnostics(), 'ai.embedding').status).toBe('skipped');
    });

    it('marks face.detection as skipped when face recognition is disabled', async () => {
      expect(findCheck(await service.runDiagnostics(), 'face.detection').status).toBe('skipped');
    });

    it('marks jobs.burstConfig as skipped when burst detection is disabled', async () => {
      expect(findCheck(await service.runDiagnostics(), 'jobs.burstConfig').status).toBe('skipped');
    });

    it('produces zero error checks for a fresh-install configuration', async () => {
      expect((await service.runDiagnostics()).summary.error).toBe(0);
    });

    it('does not call out to AI/face provider test methods when unconfigured', async () => {
      await service.runDiagnostics();
      expect(mockAiSettings.testProvider).not.toHaveBeenCalled();
      expect(mockFaceSettings.testProvider).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // ai.videoTagging (epic #452, issue #457)
  //
  // The check's whole point is the asymmetry between the two cost levers: the
  // VISUAL pass is required (missing ⇒ error, the job cannot run) while
  // TRANSCRIPTION is an optional enrichment (missing ⇒ warning, the job runs
  // visual-only). Reporting both as errors would send an admin chasing a
  // transcription credential to fix a feature that already works.
  // =========================================================================

  describe('ai.videoTagging', () => {
    beforeEach(() => {
      process.env = healthyEnv();
      mockQueryRawByText(mockPrisma, healthyQueryRawHandlers());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockNoWorkerNodes(mockPrisma);
      (mockPrisma.aiProviderCredential.findUnique as jest.Mock).mockResolvedValue({
        provider: 'openai',
        enabled: true,
      });
    });

    /** Healthy settings plus an `autoTagging.video` block. */
    const withVideo = (video: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      makeHealthySettings({
        autoTagging: {
          video: {
            enabled: true,
            maxFrames: 6,
            sampleIntervalSeconds: 5,
            transcription: { enabled: false, leadSeconds: 30 },
            ...video,
          },
        },
        ...extra,
      } as any);

    it('is skipped when the master autoTagging flag is off', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
        makeHealthySettings({
          features: { autoTagging: false, faceRecognition: true, burstDetection: true },
          autoTagging: { video: { enabled: true, maxFrames: 6, sampleIntervalSeconds: 5, transcription: { enabled: false, leadSeconds: 30 } } },
        } as any),
      );

      const report = await service.runDiagnostics();
      expect(findCheck(report, 'ai.videoTagging').status).toBe('skipped');
    });

    it('is skipped when video tagging itself is off — the default, so an upgrade reports nothing new', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(withVideo({ enabled: false }));

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'ai.videoTagging');
      expect(check.status).toBe('skipped');
      expect(check.message).toMatch(/Video AI tagging is disabled/);
    });

    it('warns when AUTO_TAG_ENABLED=false overrides the setting — video tagging has no kill-switch of its own', async () => {
      process.env = healthyEnv({ AUTO_TAG_ENABLED: 'false' });
      mockSystemSettings.readKnownValue.mockResolvedValue(withVideo({}));

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'ai.videoTagging');
      expect(check.status).toBe('warning');
      expect(check.message).toMatch(/AUTO_TAG_ENABLED=false/);
    });

    it('is status:error when enabled with no tagging provider/model selected', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
        withVideo(
          {},
          {
            ai: {
              features: {
                search: { provider: 'openai', model: 'gpt-4o' },
                tagging: { provider: null, model: null },
                embedding: { provider: 'openai', model: 'text-embedding-3-small' },
              },
            },
          },
        ),
      );

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'ai.videoTagging');
      expect(check.status).toBe('error');
      expect(check.actionItem).toBeTruthy();
    });

    it('is status:error when the resolved tagging provider has no enabled credential', async () => {
      (mockPrisma.aiProviderCredential.findUnique as jest.Mock).mockResolvedValue({
        provider: 'openai',
        enabled: false,
      });
      mockSystemSettings.readKnownValue.mockResolvedValue(withVideo({}));

      const report = await service.runDiagnostics();
      expect(findCheck(report, 'ai.videoTagging').status).toBe('error');
    });

    it('is status:ok, visual-only, when transcription is off', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(withVideo({ maxFrames: 8 }));

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'ai.videoTagging');
      expect(check.status).toBe('ok');
      expect(check.message).toMatch(/8 frames\/video/);
      expect(check.message).toMatch(/visual-only/);
    });

    it('WARNS (never errors) when transcription is on but no transcription model is selected', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
        withVideo({ transcription: { enabled: true, leadSeconds: 30 } }),
      );

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'ai.videoTagging');
      // Warning, not error: the job still runs and produces tags.
      expect(check.status).toBe('warning');
      expect(check.message).toMatch(/visual-only/);
    });

    it('warns when the selected transcription provider has no audio capability (e.g. Anthropic)', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
        withVideo(
          { transcription: { enabled: true, leadSeconds: 30 } },
          {
            ai: {
              features: {
                search: { provider: 'openai', model: 'gpt-4o' },
                tagging: { provider: 'openai', model: 'gpt-4o' },
                embedding: { provider: 'openai', model: 'text-embedding-3-small' },
                transcription: { provider: 'anthropic', model: 'claude-opus-4-8' },
              },
            },
          },
        ),
      );

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'ai.videoTagging');
      expect(check.status).toBe('warning');
      expect(check.message).toMatch(/no audio capability/);
    });

    it('is status:ok and names both models when transcription is fully configured', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
        withVideo(
          { transcription: { enabled: true, leadSeconds: 45 } },
          {
            ai: {
              features: {
                search: { provider: 'openai', model: 'gpt-4o' },
                tagging: { provider: 'openai', model: 'gpt-4o' },
                embedding: { provider: 'openai', model: 'text-embedding-3-small' },
                transcription: { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
              },
            },
          },
        ),
      );

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'ai.videoTagging');
      expect(check.status).toBe('ok');
      expect(check.message).toMatch(/gpt-4o-mini-transcribe/);
      expect(check.message).toMatch(/first 45s/);
    });
  });

  describe('ai.flagConsistency', () => {
    beforeEach(() => {
      process.env = healthyEnv();
      mockQueryRawByText(mockPrisma, healthyQueryRawHandlers());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
    });

    it('is status:error when autoTagging is enabled but no tagging provider is configured', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
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
      mockSystemSettings.readKnownValue.mockResolvedValue(
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
      mockSystemSettings.readKnownValue.mockResolvedValue(
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
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
    });

    it('is status:warning when a face provider is configured but faceRecognition is disabled', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
        makeSettings({
          features: { autoTagging: false, faceRecognition: false, burstDetection: false },
          face: {
            features: { detection: { provider: 'compreface', model: null } },
            video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 },
      autoArchive: { matchThreshold: 0.45 },
          },
        }),
      );

      const report = await service.runDiagnostics();
      expect(findCheck(report, 'face.flagConsistency').status).toBe('warning');
    });

    it('is status:ok when faceRecognition is enabled (provider configured)', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
        makeSettings({
          features: { autoTagging: false, faceRecognition: true, burstDetection: false },
          face: {
            features: { detection: { provider: 'compreface', model: null } },
            video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 },
      autoArchive: { matchThreshold: 0.45 },
          },
        }),
      );

      const report = await service.runDiagnostics();
      expect(findCheck(report, 'face.flagConsistency').status).toBe('ok');
    });

    it('is status:skipped when faceRecognition is disabled and no provider is configured', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(makeSettings());

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
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
    });

    it('is status:skipped when social media detection is disabled', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(makeSettings());

      const report = await service.runDiagnostics();
      expect(findCheck(report, 'ai.socialMedia').status).toBe('skipped');
      expect(mockSocialMediaOcr.getStatus).not.toHaveBeenCalled();
    });

    it('is status:ok (two-tier operational) when the feature is on, OCR enabled, and the model is available', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
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
      mockSystemSettings.readKnownValue.mockResolvedValue(
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
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockNoWorkerNodes(mockPrisma);
    });

    it('is status:skipped when duplicate detection is disabled, and does not consult VisualEmbeddingService', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(makeSettings());

      const report = await service.runDiagnostics();
      expect(findCheck(report, 'ai.duplicateDetection').status).toBe('skipped');
      expect(mockVisualEmbeddingService.isAvailable).not.toHaveBeenCalled();
    });

    it('is status:ok (two-tier operational) when the feature is on and the CLIP model is available', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
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
      mockSystemSettings.readKnownValue.mockResolvedValue(
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


  describe('core.pgvector', () => {
    beforeEach(() => {
      process.env = healthyEnv();
      mockSystemSettings.readKnownValue.mockResolvedValue(makeHealthySettings());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
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
      mockSystemSettings.readKnownValue.mockResolvedValue(makeHealthySettings());
      (mockPrisma.user.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.storageProviderCredential.findFirst as jest.Mock).mockResolvedValue({
        provider: 's3',
        enabled: true,
      });
      mockAiSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockAiSettings.testEmbedding.mockResolvedValue({ ok: true, dimensions: 1536 } as any);
      mockFaceSettings.testProvider.mockResolvedValue({ ok: true } as any);
      mockGeoSettings.testProvider.mockResolvedValue({ ok: true, sample: {} } as any);
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
  // 11. nodes.capabilityHealth — issue #148 operational-self-test overlay
  // =========================================================================

  describe('nodes.capabilityHealth', () => {
    beforeEach(() => {
      process.env = healthyEnv();
      mockSystemSettings.readKnownValue.mockResolvedValue(makeHealthySettings());
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
      (mockPrisma.enrichmentJob.count as jest.Mock).mockResolvedValue(0);
      // One online node with a fresh heartbeat so nodes.heartbeatFreshness stays
      // 'ok' and doesn't interfere with this check's isolated assertions —
      // checkNodesHeartbeat and checkNodesCapabilityHealth both read from the
      // same mocked workerNode.findMany() call.
      (mockPrisma.mhLegacyWorkerNode.count as jest.Mock).mockResolvedValue(1);
    });

    /** A single online node fixture with a fresh heartbeat. */
    function nodeFixture(opts: { name?: string; eligibleTypes: string[]; capabilities: unknown }): any[] {
      return [
        {
          name: opts.name ?? 'worker-1',
          eligibleTypes: opts.eligibleTypes,
          capabilities: opts.capabilities,
          lastHeartbeatAt: new Date(),
        },
      ];
    }

    it('is status:warning when a node reports operational:false on a capability backing one of its eligibleTypes (#148 shape)', async () => {
      (mockPrisma.mhLegacyWorkerNode.findMany as jest.Mock).mockResolvedValue(
        nodeFixture({
          eligibleTypes: ['face_detection'],
          capabilities: {
            compreface: {
              available: true,
              detail: 'compreface-core',
              operational: false,
              operationalDetail: 'CompreFace self-test failed: sidecar unreachable',
            },
            sharp: { available: true, detail: 'sharp', operational: true },
          },
        }),
      );

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'nodes.capabilityHealth');

      expect(check.status).toBe('warning');
      expect(check.message).toContain('worker-1 (compreface)');
      expect(check.actionItem).toBeTruthy();
    });

    it('does not flag operational:false for a capability that backs none of the node eligibleTypes', async () => {
      (mockPrisma.mhLegacyWorkerNode.findMany as jest.Mock).mockResolvedValue(
        nodeFixture({
          // geocode has no capability requirements at all (JOB_TYPE_REQUIREMENTS.geocode === []),
          // and tesseract only backs social_media_detection — not eligible here.
          eligibleTypes: ['geocode'],
          capabilities: {
            tesseract: {
              available: true,
              detail: 'tesseract.js',
              operational: false,
              operationalDetail: 'language data not present',
            },
          },
        }),
      );

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'nodes.capabilityHealth');

      expect(check.status).toBe('ok');
      expect(check.message).toContain('healthy capabilities');
    });

    it('backward-compat: a node reporting presence-only capabilities (no operational field, pre-#148 shape) is classified exactly as before this change — not degraded', async () => {
      (mockPrisma.mhLegacyWorkerNode.findMany as jest.Mock).mockResolvedValue(
        nodeFixture({
          eligibleTypes: ['face_detection'],
          capabilities: {
            // Older CLI: presence-only shape, no 'status' and no 'operational' field
            // at all — collectCapabilityEntries has nothing to key on for either of
            // them, so (both before and after #148) this produces no entry and the
            // node is never flagged as degraded by this check, regardless of
            // whether the capability itself is actually present.
            compreface: { available: false, detail: 'compreface-core not reachable' },
            sharp: { available: true, detail: 'sharp' },
          },
        }),
      );

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'nodes.capabilityHealth');

      expect(check.status).toBe('ok');
      expect(check.message).toContain('healthy capabilities');
    });

    it('still recognizes the legacy flat-string status shape ({ face: "error" }) as degraded — unchanged by #148', async () => {
      (mockPrisma.mhLegacyWorkerNode.findMany as jest.Mock).mockResolvedValue(
        nodeFixture({
          eligibleTypes: ['face_detection'],
          capabilities: { face: 'error' },
        }),
      );

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'nodes.capabilityHealth');

      expect(check.status).toBe('warning');
      expect(check.message).toContain('worker-1 (face)');
    });

    it('is status:skipped when no online node has reported a capability summary at all', async () => {
      (mockPrisma.mhLegacyWorkerNode.findMany as jest.Mock).mockResolvedValue(
        nodeFixture({ eligibleTypes: ['face_detection'], capabilities: undefined }),
      );

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'nodes.capabilityHealth');

      expect(check.status).toBe('skipped');
    });
  });

  // =========================================================================
  // 12. workflows.state — Media Workflow Automation (issue #143)
  // =========================================================================

  describe('workflows.state', () => {
    /**
     * Routes the two distinct `workflowRun.count` calls the check makes
     * (stuck non-terminal runs vs. stale awaiting_approval runs) to separate
     * canned values by inspecting the `status.in` filter, since both share the
     * same mocked method.
     */
    function mockWorkflowRunCounts(opts: { stuck?: number; staleApproval?: number } = {}): void {
      (mockPrisma.workflowRun.count as jest.Mock).mockImplementation((args: any) => {
        const status = args?.where?.status;
        const statusIn: string[] | undefined = status?.in;
        if (statusIn?.includes(WorkflowRunStatus.running)) {
          return Promise.resolve(opts.stuck ?? 0);
        }
        if (status === WorkflowRunStatus.awaiting_approval) {
          return Promise.resolve(opts.staleApproval ?? 0);
        }
        return Promise.resolve(0);
      });
    }

    beforeEach(() => {
      process.env = healthyEnv();
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
      mockNoWorkerNodes(mockPrisma);
      mockWorkflowRunCounts();
      (mockPrisma.workflow.count as jest.Mock).mockResolvedValue(0);
    });

    it('is status:skipped when the workflows feature flag is off', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(makeSettings()); // features.workflows absent/false

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'workflows.state');

      expect(check.status).toBe('skipped');
      expect(check.message).toContain('disabled');
      // Feature is off — the check must not touch workflowRun/workflow at all.
      expect(mockPrisma.workflowRun.count).not.toHaveBeenCalled();
      expect(mockPrisma.workflow.count).not.toHaveBeenCalled();
    });

    it('is status:ok when the feature is on and no runs are stuck, stale, or misconfigured', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
        makeHealthySettings({ features: { autoTagging: false, faceRecognition: false, burstDetection: false, workflows: true } as any }),
      );

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'workflows.state');

      expect(check.status).toBe('ok');
      expect(check.message).toContain('no stuck, stale, or misconfigured runs');
    });

    it('is status:warning when WORKFLOWS_ENABLED=false overrides the enabled feature flag (env kill-switch)', async () => {
      process.env = healthyEnv({ WORKFLOWS_ENABLED: 'false' });
      mockSystemSettings.readKnownValue.mockResolvedValue(
        makeHealthySettings({ features: { autoTagging: false, faceRecognition: false, burstDetection: false, workflows: true } as any }),
      );

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'workflows.state');

      expect(check.status).toBe('warning');
      expect(check.message).toContain('WORKFLOWS_ENABLED=false');
      expect(check.actionItem).toContain('WORKFLOWS_ENABLED=true');
    });

    it('is status:warning when runs are stuck non-terminal past the stuck window with no progress', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
        makeHealthySettings({ features: { autoTagging: false, faceRecognition: false, burstDetection: false, workflows: true } as any }),
      );
      mockWorkflowRunCounts({ stuck: 2 });

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'workflows.state');

      expect(check.status).toBe('warning');
      expect(check.message).toContain('2 workflow run(s) stuck non-terminal');
      expect(check.actionItem).toContain('Cancel the stuck run(s)');
    });

    it('is status:warning when awaiting_approval runs are past their previewTtlHours TTL but not expired', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
        makeHealthySettings({
          features: { autoTagging: false, faceRecognition: false, burstDetection: false, workflows: true } as any,
          workflows: { previewTtlHours: 12 } as any,
        }),
      );
      mockWorkflowRunCounts({ staleApproval: 3 });

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'workflows.state');

      expect(check.status).toBe('warning');
      expect(check.message).toContain('3 awaiting-approval run(s)');
      expect(check.message).toContain('12h TTL');
      expect(check.actionItem).toContain('workflow_history_purge');
    });

    it('is status:warning when enabled scheduled workflows exist but workflows.triggers.scheduled is off', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
        makeHealthySettings({
          features: { autoTagging: false, faceRecognition: false, burstDetection: false, workflows: true } as any,
          workflows: { triggers: { scheduled: false } } as any,
        }),
      );
      (mockPrisma.workflow.count as jest.Mock).mockResolvedValue(4);

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'workflows.state');

      expect(check.status).toBe('warning');
      expect(check.message).toContain('4 enabled scheduled workflow(s)');
      expect(check.actionItem).toContain('workflows.triggers.scheduled');
      // Confirms the check only queries workflow.count when the scheduled
      // trigger is off — never when it's on (see the other tests here).
      expect(mockPrisma.workflow.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { enabled: true, trigger: WorkflowTrigger.scheduled } }),
      );
    });

    it('does not query workflow.count for scheduled workflows when the scheduled trigger is on', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
        makeHealthySettings({ features: { autoTagging: false, faceRecognition: false, burstDetection: false, workflows: true } as any }),
      );

      await service.runDiagnostics();

      expect(mockPrisma.workflow.count).not.toHaveBeenCalled();
    });

    it('combines multiple simultaneous warnings into one message', async () => {
      mockSystemSettings.readKnownValue.mockResolvedValue(
        makeHealthySettings({
          features: { autoTagging: false, faceRecognition: false, burstDetection: false, workflows: true } as any,
          workflows: { triggers: { scheduled: false } } as any,
        }),
      );
      mockWorkflowRunCounts({ stuck: 1, staleApproval: 1 });
      (mockPrisma.workflow.count as jest.Mock).mockResolvedValue(1);

      const report = await service.runDiagnostics();
      const check = findCheck(report, 'workflows.state');

      expect(check.status).toBe('warning');
      expect(check.message).toContain('stuck non-terminal');
      expect(check.message).toContain('awaiting-approval');
      expect(check.message).toContain('enabled scheduled workflow(s)');
    });
  });

  // =========================================================================
  // Android app section (epic #498, issue #507)
  // =========================================================================

  describe('android section', () => {
    const HOUR = 3_600_000;

    function makeDevice(overrides: Record<string, unknown> = {}) {
      return {
        name: 'Pixel 8',
        lastSeenAt: new Date(Date.now() - HOUR),
        stats: { eligible: 10, uploaded: 10, blocked: 0 },
        permission: 'full',
        patId: 'pat-1',
        pat: { revokedAt: null, expiresAt: new Date(Date.now() + 30 * 24 * HOUR) },
        user: { email: 'alice@example.com' },
        ...overrides,
      };
    }

    /**
     * The check reads devices, then their personal access tokens in one batched
     * query (the `pat_id` relation is not modelled, RETRO-B2): serve both from the
     * same fixture rows.
     */
    function mockDevices(devices: Array<Record<string, any>>) {
      (mockPrisma.mediaSyncDevice.findMany as jest.Mock).mockResolvedValue(devices);
      (mockPrisma.personalAccessToken.findMany as jest.Mock).mockResolvedValue(
        devices.filter((d) => d.patId && d.pat).map((d) => ({ id: d.patId, ...d.pat })),
      );
    }

    function makeRelease(overrides: Record<string, unknown> = {}) {
      return {
        id: 'rel-1',
        packageName: 'cr.marin.memoriahub',
        versionName: '2.1.0',
        versionCode: 21,
        signingSha256: `AA${':AA'.repeat(31)}`,
        isCurrent: true,
        ...overrides,
      } as any;
    }

    const TRUSTED = { packageName: 'cr.marin.memoriahub', sha256: `AA${':AA'.repeat(31)}` };

    beforeEach(() => {
      process.env = healthyEnv();
      mockSystemSettings.readKnownValue.mockResolvedValue(makeHealthySettings());
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
      mockNoWorkerNodes(mockPrisma);
    });

    it('registers the four android checks, in order', async () => {
      const report = await service.runDiagnostics();

      expect(report.checks.filter((c) => c.key.startsWith('android.')).map((c) => c.key)).toEqual([
        'android.assetlinks',
        'android.releases',
        'android.mediaSync',
        'android.uploadPath',
      ]);
    });

    it('skips the three device-scoped checks with no paired device', async () => {
      const report = await service.runDiagnostics();

      expect(findCheck(report, 'android.assetlinks').status).toBe('skipped');
      expect(findCheck(report, 'android.releases').status).toBe('skipped');
      expect(findCheck(report, 'android.mediaSync').status).toBe('skipped');
      expect(findCheck(report, 'android.uploadPath').status).toBe('ok');
    });

    it('reports the releases warning and the upload-path error independently', async () => {
      (mockPrisma.mediaSyncDevice.count as jest.Mock).mockResolvedValue(1);
      mockAndroidReleases.resolveUploadTarget.mockRejectedValue(new Error('boom'));

      const report = await service.runDiagnostics();

      expect(findCheck(report, 'android.releases').status).toBe('warning');
      expect(findCheck(report, 'android.uploadPath').status).toBe('error');
    });

    // -----------------------------------------------------------------------
    describe('android.assetlinks', () => {
      it('is skipped when no active device has reported a signer and there is no release', async () => {
        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.assetlinks');

        expect(check.status).toBe('skipped');
        expect(check.message).toContain('No active Media Sync device');
      });

      it('is ok when every reported pair (and the current release signer) is trusted', async () => {
        mockAndroidApp.getTrustedApps.mockResolvedValue([TRUSTED]);
        mockAndroidApp.getReportedApps.mockResolvedValue([
          { ...TRUSTED, deviceCount: 2, lastSeenAt: null, trusted: true },
        ]);
        // The release spells the fingerprint as bare lowercase hex: still trusted.
        mockAndroidReleases.current.mockResolvedValue(makeRelease({ signingSha256: 'aa'.repeat(32) }));

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.assetlinks');

        expect(check.status).toBe('ok');
        expect(check.message).toContain('All 1 reported');
        expect(mockAndroidApp.getReportedApps).toHaveBeenCalledWith([TRUSTED]);
      });

      it('warns on an untrusted reported pair, listing at most three, with the trust action item', async () => {
        const untrusted = ['a', 'b', 'c', 'd'].map((suffix) => ({
          packageName: `cr.marin.${suffix}`,
          sha256: `BB${':BB'.repeat(31)}`,
          deviceCount: 1,
          lastSeenAt: null,
          trusted: false,
        }));
        mockAndroidApp.getReportedApps.mockResolvedValue(untrusted);

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.assetlinks');

        expect(check.status).toBe('warning');
        expect(check.message).toContain('4 reported app signer(s) are not trusted');
        expect(check.message).toContain('cr.marin.a');
        expect(check.message).toContain('cr.marin.c');
        expect(check.message).not.toContain('cr.marin.d');
        expect(check.message).toContain('…');
        expect(check.actionItem).toContain('Trust it in Admin → Settings → Android app');
      });

      it('warns when the current release signer is not trusted, even with no device reporting', async () => {
        mockAndroidReleases.current.mockResolvedValue(makeRelease());

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.assetlinks');

        expect(check.status).toBe('warning');
        expect(check.message).toContain('current release 2.1.0 (21)');
        expect(check.message).toContain('not trusted');
      });

      it('is error when the trusted apps cannot be read', async () => {
        mockAndroidApp.getTrustedApps.mockRejectedValue(new Error('connection refused'));

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.assetlinks');

        expect(check.status).toBe('error');
        expect(check.message).toContain('connection refused');
        expect(check.actionItem).toBeDefined();
      });
    });

    // -----------------------------------------------------------------------
    describe('android.releases', () => {
      it('is skipped when no active device is paired', async () => {
        mockAndroidReleases.current.mockResolvedValue(makeRelease());

        const report = await service.runDiagnostics();

        expect(findCheck(report, 'android.releases').status).toBe('skipped');
      });

      it('warns when devices are paired but no release is current', async () => {
        (mockPrisma.mediaSyncDevice.count as jest.Mock).mockResolvedValue(3);

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.releases');

        expect(check.status).toBe('warning');
        expect(check.message).toContain('3 active device(s)');
        expect(check.actionItem).toContain('memoriahub android release');
      });

      it('is ok with a current release and reports devicesBehind', async () => {
        (mockPrisma.mediaSyncDevice.count as jest.Mock).mockImplementation((args: any) =>
          Promise.resolve(args?.where?.appVersionCode ? 1 : 3),
        );
        mockAndroidReleases.current.mockResolvedValue(makeRelease());

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.releases');

        expect(check.status).toBe('ok');
        expect(check.message).toContain('Current release 2.1.0 (21)');
        expect(check.message).toContain('devicesBehind: 1 of 3');
        expect(mockPrisma.mediaSyncDevice.count).toHaveBeenCalledWith({
          where: {
            status: 'active',
            appVersionCode: { lt: 21 },
            OR: [{ packageName: 'cr.marin.memoriahub' }, { packageName: null }],
          },
        });
      });

      it('is error (normalized) when the device count query fails', async () => {
        (mockPrisma.mediaSyncDevice.count as jest.Mock).mockRejectedValue(new Error('db down'));

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.releases');

        expect(check.status).toBe('error');
        expect(check.message).toContain('db down');
      });
    });

    // -----------------------------------------------------------------------
    describe('android.mediaSync', () => {
      it('is skipped when no active device is paired', async () => {
        const report = await service.runDiagnostics();

        expect(findCheck(report, 'android.mediaSync').status).toBe('skipped');
        expect(mockPrisma.mediaSyncDevice.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { status: 'active' } }),
        );
      });

      it('is ok when every active device is fresh, fully permitted, unblocked and holds a live token', async () => {
        mockDevices([
          makeDevice(),
          makeDevice({ name: 'Galaxy S24' }),
        ]);

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.mediaSync');

        expect(check.status).toBe('ok');
        expect(check.message).toContain('All 2 active device(s)');
      });

      it('warns on a device with no check-in for more than 48h, naming it and its owner', async () => {
        mockDevices([
          makeDevice({ name: 'Old Phone', lastSeenAt: new Date(Date.now() - 72 * HOUR) }),
          makeDevice(),
        ]);

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.mediaSync');

        expect(check.status).toBe('warning');
        expect(check.message).toContain('1 of 2 active device(s) need attention');
        expect(check.message).toContain('1 silent >48h');
        expect(check.message).toContain('Old Phone, alice@example.com: no check-in for 72h');
        expect(check.actionItem).toBeDefined();
      });

      it('treats a device that never checked in as stale', async () => {
        mockDevices([
          makeDevice({ lastSeenAt: null, permission: null }),
        ]);

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.mediaSync');

        expect(check.status).toBe('warning');
        expect(check.message).toContain('never checked in');
        // A null permission (not reported yet) is not flagged on its own.
        expect(check.message).not.toContain('media permission');
      });

      it('warns on blocked files', async () => {
        mockDevices([
          makeDevice({ stats: { blocked: 4 } }),
        ]);

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.mediaSync');

        expect(check.status).toBe('warning');
        expect(check.message).toContain('4 blocked file(s)');
        expect(check.message).toContain('1 with blocked files');
      });

      it('ignores malformed stats', async () => {
        mockDevices([
          makeDevice({ stats: { blocked: 'many' } }),
          makeDevice({ stats: null }),
          makeDevice({ stats: [1, 2] }),
        ]);

        const report = await service.runDiagnostics();

        expect(findCheck(report, 'android.mediaSync').status).toBe('ok');
      });

      it.each(['partial', 'denied'])('warns when media permission is %s', async (permission) => {
        mockDevices([makeDevice({ permission })]);

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.mediaSync');

        expect(check.status).toBe('warning');
        expect(check.message).toContain(`media permission ${permission}`);
        expect(check.message).toContain('1 without full media permission');
      });

      it.each([
        ['revoked', { revokedAt: new Date(), expiresAt: new Date(Date.now() + HOUR) }, 'token revoked'],
        ['expired', { revokedAt: null, expiresAt: new Date(Date.now() - HOUR) }, 'token expired'],
      ])('warns when the paired PAT is %s', async (_label, pat, expected) => {
        mockDevices([makeDevice({ pat })]);

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.mediaSync');

        expect(check.status).toBe('warning');
        expect(check.message).toContain(expected);
        expect(check.message).toContain('1 with a revoked/expired token');
      });

      it('warns when the device has no PAT at all (deleted)', async () => {
        mockDevices([
          makeDevice({ patId: null, pat: null }),
        ]);

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.mediaSync');

        expect(check.status).toBe('warning');
        expect(check.message).toContain('no token');
      });

      it('names at most five devices and counts every reason', async () => {
        const devices = Array.from({ length: 7 }, (_, i) =>
          makeDevice({ name: `Phone ${i + 1}`, permission: 'partial' }),
        );
        mockDevices(devices);

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.mediaSync');

        expect(check.message).toContain('7 of 7 active device(s)');
        expect(check.message).toContain('Phone 5');
        expect(check.message).not.toContain('Phone 6');
        expect(check.message).toContain('…');
      });

      it('is error (normalized) when the device query fails', async () => {
        (mockPrisma.mediaSyncDevice.findMany as jest.Mock).mockRejectedValue(new Error('db down'));

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.mediaSync');

        expect(check.status).toBe('error');
        expect(check.message).toContain('db down');
      });
    });

    // -----------------------------------------------------------------------
    describe('android.uploadPath', () => {
      it('is ok for a provider with presigned parts (S3/R2), naming the provider', async () => {
        mockAndroidReleases.resolveUploadTarget.mockResolvedValue({
          id: 'r2',
          provider: { partUploadMode: 'presigned' },
        } as any);

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.uploadPath');

        expect(check.status).toBe('ok');
        expect(check.message).toContain('"r2"');
        expect(check.message).toContain('presigned');
      });

      it('is ok for the local provider through the API part route', async () => {
        mockAndroidReleases.resolveUploadTarget.mockResolvedValue({
          id: 'local',
          provider: { partUploadMode: 'proxied', uploadPart: jest.fn() },
        } as any);

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.uploadPath');

        expect(check.status).toBe('ok');
        expect(check.message).toContain('"local"');
        expect(check.message).toContain('API part route');
      });

      it('is error when the active provider is unconfigured, naming its key', async () => {
        mockAndroidReleases.resolveUploadTarget.mockRejectedValue(
          new ServiceUnavailableException({
            message: 'Object storage is not configured',
            details: { reason: 'STORAGE_NOT_CONFIGURED', provider: 's3' },
          }),
        );

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.uploadPath');

        expect(check.status).toBe('error');
        expect(check.message).toContain('"s3"');
        expect(check.actionItem).toContain('Admin Settings → Storage');
      });

      it('is error when the provider supports neither part path', async () => {
        mockAndroidReleases.resolveUploadTarget.mockResolvedValue({
          id: 'odd',
          provider: { partUploadMode: 'proxied' },
        } as any);

        const report = await service.runDiagnostics();
        const check = findCheck(report, 'android.uploadPath');

        expect(check.status).toBe('error');
        expect(check.message).toContain('"odd"');
      });
    });
  });
});
