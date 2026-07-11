/**
 * Unit tests for NodesService.getJobCredentials — the transient, per-job
 * provider credentials endpoint for distributed worker nodes
 * (POST /api/nodes/:id/jobs/:jobId/credentials).
 *
 * Design under test (see apps/api/src/nodes/dto/job-credentials.dto.ts and
 * NodesService.getJobCredentials/getAutoTaggingCredentials/getGeocodeCredentials):
 * a node fetches a plaintext provider API key scoped to THIS job only and
 * calls the provider's HTTP API directly — the mandated alternative to the
 * "AI-proxy" pattern documented (stale) in docs/specs/distributed-nodes.md.
 *
 * Covers:
 *  1. Held-job guard reuse — same 404/403/409 semantics as the sibling
 *     getJobUploadUrl/submitJobResult endpoints (assertJobHeldByNode is
 *     exhaustively tested in nodes.service.spec.ts; this file does a single
 *     reuse check per status code to confirm getJobCredentials funnels
 *     through the same guard rather than re-deriving its own).
 *  2. auto_tagging happy path — response shape, decrypted apiKey, model/
 *     provider from system settings, prompt built via
 *     AutoTaggingService.buildPrompt, recordModel called.
 *  3. auto_tagging error paths — no mediaItemId, MediaItem not found,
 *     provider/model not configured.
 *  4. geocode happy paths — nominatim (no apiKey), google (apiKey decrypted),
 *     offline (default / no active provider configured).
 *  5. geocode: google active but credential missing/disabled falls back to
 *     offline (mirrors GeoLocationService's own fallback behavior).
 *  6. geocode error paths — no mediaItemId, no usable GPS coordinates.
 *  7. Unsupported job type -> 400.
 *
 * SECRETS_ENCRYPTION_KEY is set to a valid test value so the google-provider
 * encrypt/decrypt round-trip works (mirrors geo-settings.service.spec.ts).
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { JobStatus } from '@prisma/client';
import { NodesService } from './nodes.service';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentClaimService } from '../enrichment/enrichment-claim.service';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { EnrichmentTerminalService } from '../enrichment/enrichment-terminal.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { ObjectsService } from '../storage/objects/objects.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { AiSettingsService } from '../ai/ai-settings.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { AutoTaggingService } from '../tagging/auto-tagging.service';
import { encryptSecret } from '../common/crypto/secret-cipher';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

const VALID_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';

const USER_ID = 'user-1';
const NODE_ID = 'node-1';
const JOB_ID = 'job-1';

function makeNode(overrides: Record<string, unknown> = {}) {
  return {
    id: NODE_ID,
    createdById: USER_ID,
    status: 'online',
    eligibleTypes: ['auto_tagging', 'geocode'],
    concurrency: 1,
    ...overrides,
  };
}

function makeHeldJob(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    type: 'auto_tagging',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.running,
    attempts: 1,
    rateLimitHits: 0,
    claimedByNodeId: NODE_ID,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    executor: 'node',
    ...overrides,
  };
}

describe('NodesService.getJobCredentials', () => {
  let service: NodesService;
  let mockPrisma: MockPrismaService;
  let mockEnrichmentJobService: { recordModel: jest.Mock };
  let mockAiSettingsService: { resolveCredentials: jest.Mock };
  let mockSystemSettings: { getSettings: jest.Mock };
  let mockAutoTaggingService: { buildPrompt: jest.Mock };
  let originalKey: string | undefined;
  let originalGeoProviderEnv: string | undefined;

  beforeAll(() => {
    originalKey = process.env['SECRETS_ENCRYPTION_KEY'];
    process.env['SECRETS_ENCRYPTION_KEY'] = VALID_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env['SECRETS_ENCRYPTION_KEY'];
    } else {
      process.env['SECRETS_ENCRYPTION_KEY'] = originalKey;
    }
  });

  beforeEach(async () => {
    originalGeoProviderEnv = process.env['GEO_PROVIDER'];
    delete process.env['GEO_PROVIDER'];

    mockPrisma = createMockPrismaService();
    mockEnrichmentJobService = { recordModel: jest.fn().mockResolvedValue(undefined) };
    mockAiSettingsService = {
      resolveCredentials: jest.fn().mockResolvedValue({ apiKey: 'anthropic-test-key', baseUrl: undefined }),
    };
    mockSystemSettings = { getSettings: jest.fn().mockResolvedValue({}) };
    mockAutoTaggingService = {
      buildPrompt: jest.fn().mockReturnValue({ system: 'SYSTEM_PROMPT', prompt: 'USER_PROMPT' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NodesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentClaimService, useValue: { claim: jest.fn() } },
        { provide: EnrichmentHandlerRegistry, useValue: { get: jest.fn(), types: jest.fn().mockReturnValue([]) } },
        { provide: EnrichmentTerminalService, useValue: { completeSucceeded: jest.fn(), completeFailed: jest.fn() } },
        { provide: ObjectsService, useValue: { getDownloadUrl: jest.fn() } },
        { provide: StorageProviderResolver, useValue: { getActiveProvider: jest.fn() } },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: AiSettingsService, useValue: mockAiSettingsService },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
        { provide: AutoTaggingService, useValue: mockAutoTaggingService },
      ],
    }).compile();

    service = module.get(NodesService);

    (mockPrisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode());
  });

  afterEach(() => {
    if (originalGeoProviderEnv === undefined) {
      delete process.env['GEO_PROVIDER'];
    } else {
      process.env['GEO_PROVIDER'] = originalGeoProviderEnv;
    }
    jest.clearAllMocks();
  });

  // =========================================================================
  // Held-job guard reuse
  // =========================================================================

  describe('held-job guard reuse (same semantics as getJobUploadUrl/submitJobResult)', () => {
    it('404s when the job does not exist', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getJobCredentials(USER_ID, NODE_ID, JOB_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('403s when the node belongs to another user', async () => {
      (mockPrisma.workerNode.findUnique as jest.Mock).mockResolvedValue(
        makeNode({ createdById: 'someone-else' }),
      );

      await expect(service.getJobCredentials(USER_ID, NODE_ID, JOB_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('409s when the lease has expired', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ leaseExpiresAt: new Date(Date.now() - 1) }),
      );

      await expect(service.getJobCredentials(USER_ID, NODE_ID, JOB_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('409s when the job is claimed by a different node', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ claimedByNodeId: 'other-node' }),
      );

      await expect(service.getJobCredentials(USER_ID, NODE_ID, JOB_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('409s when the job is not running', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ status: JobStatus.pending }),
      );

      await expect(service.getJobCredentials(USER_ID, NODE_ID, JOB_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  // =========================================================================
  // auto_tagging
  // =========================================================================

  describe('auto_tagging', () => {
    beforeEach(() => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ type: 'auto_tagging', mediaItemId: 'media-1' }),
      );
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({ id: 'media-1' });
      (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue({
        key: 'global',
        value: { ai: { features: { tagging: { provider: 'anthropic', model: 'claude-3-5-sonnet' } } } },
      });
      (mockPrisma.tagLabel.findMany as jest.Mock).mockResolvedValue([
        { name: 'Beach' },
        { name: 'Sunset' },
      ]);
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([{ person: { name: 'Alice' } }]);
    });

    it('returns AutoTaggingJobCredentials with a decrypted apiKey, resolved provider/model, and the shared prompt', async () => {
      const result = await service.getJobCredentials(USER_ID, NODE_ID, JOB_ID);

      expect(result).toEqual({
        type: 'auto_tagging',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKey: 'anthropic-test-key',
        baseUrl: undefined,
        system: 'SYSTEM_PROMPT',
        prompt: 'USER_PROMPT',
        mimeTypeHint: 'image/jpeg',
      });
    });

    it('calls recordModel with the resolved provider/model so persistAutoTagging can read them later', async () => {
      await service.getJobCredentials(USER_ID, NODE_ID, JOB_ID);

      expect(mockEnrichmentJobService.recordModel).toHaveBeenCalledWith(
        JOB_ID,
        'anthropic',
        'claude-3-5-sonnet',
      );
    });

    it('resolves credentials for the configured tagging provider', async () => {
      await service.getJobCredentials(USER_ID, NODE_ID, JOB_ID);

      expect(mockAiSettingsService.resolveCredentials).toHaveBeenCalledWith('anthropic');
    });

    it('builds the prompt via AutoTaggingService.buildPrompt with enabled labels and assigned people names', async () => {
      await service.getJobCredentials(USER_ID, NODE_ID, JOB_ID);

      expect(mockAutoTaggingService.buildPrompt).toHaveBeenCalledWith(['Beach', 'Sunset'], ['Alice']);
    });

    it('propagates a baseUrl when the resolved credentials include one', async () => {
      mockAiSettingsService.resolveCredentials.mockResolvedValue({
        apiKey: 'k',
        baseUrl: 'https://custom.example.com',
      });

      const result = await service.getJobCredentials(USER_ID, NODE_ID, JOB_ID);

      expect(result).toMatchObject({ baseUrl: 'https://custom.example.com' });
    });

    it('400s when the job has no mediaItemId', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ type: 'auto_tagging', mediaItemId: null }),
      );

      await expect(service.getJobCredentials(USER_ID, NODE_ID, JOB_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('400s when the MediaItem no longer exists', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getJobCredentials(USER_ID, NODE_ID, JOB_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('400s when the tagging provider/model is not configured in system settings', async () => {
      (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue({
        key: 'global',
        value: {},
      });

      await expect(service.getJobCredentials(USER_ID, NODE_ID, JOB_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockEnrichmentJobService.recordModel).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // geocode
  // =========================================================================

  describe('geocode', () => {
    const GPS_LAT = 9.9325427;
    const GPS_LNG = -84.0795782;

    beforeEach(() => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ type: 'geocode', mediaItemId: 'media-1' }),
      );
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        takenLat: GPS_LAT,
        takenLng: GPS_LNG,
      });
    });

    it('returns GeocodeJobCredentials for provider=nominatim with no apiKey', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({ geo: { reverseProvider: 'nominatim' } });

      const result = await service.getJobCredentials(USER_ID, NODE_ID, JOB_ID);

      expect(result).toEqual({
        type: 'geocode',
        provider: 'nominatim',
        baseUrl: 'https://nominatim.openstreetmap.org',
        lat: GPS_LAT,
        lng: GPS_LNG,
      });
      expect((result as any).apiKey).toBeUndefined();
    });

    it('respects a custom NOMINATIM_BASE_URL env override', async () => {
      const original = process.env['NOMINATIM_BASE_URL'];
      process.env['NOMINATIM_BASE_URL'] = 'https://my-nominatim.example.com';
      mockSystemSettings.getSettings.mockResolvedValue({ geo: { reverseProvider: 'nominatim' } });

      try {
        const result = await service.getJobCredentials(USER_ID, NODE_ID, JOB_ID);
        expect(result).toMatchObject({ baseUrl: 'https://my-nominatim.example.com' });
      } finally {
        if (original === undefined) delete process.env['NOMINATIM_BASE_URL'];
        else process.env['NOMINATIM_BASE_URL'] = original;
      }
    });

    it('returns GeocodeJobCredentials for provider=google with a decrypted apiKey', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({ geo: { reverseProvider: 'google' } });
      (mockPrisma.geoProviderCredential.findUnique as jest.Mock).mockResolvedValue({
        provider: 'google',
        encryptedKey: encryptSecret('google-plaintext-key'),
        enabled: true,
      });

      const result = await service.getJobCredentials(USER_ID, NODE_ID, JOB_ID);

      expect(result).toEqual({
        type: 'geocode',
        provider: 'google',
        apiKey: 'google-plaintext-key',
        lat: GPS_LAT,
        lng: GPS_LNG,
      });
      expect((result as any).baseUrl).toBeUndefined();
    });

    it('falls back to offline when google is active but no credential row exists', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({ geo: { reverseProvider: 'google' } });
      (mockPrisma.geoProviderCredential.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.getJobCredentials(USER_ID, NODE_ID, JOB_ID);

      expect(result).toEqual({ type: 'geocode', provider: 'offline', lat: GPS_LAT, lng: GPS_LNG });
    });

    it('falls back to offline when google is active but the credential is disabled', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({ geo: { reverseProvider: 'google' } });
      (mockPrisma.geoProviderCredential.findUnique as jest.Mock).mockResolvedValue({
        provider: 'google',
        encryptedKey: encryptSecret('unused'),
        enabled: false,
      });

      const result = await service.getJobCredentials(USER_ID, NODE_ID, JOB_ID);

      expect(result).toEqual({ type: 'geocode', provider: 'offline', lat: GPS_LAT, lng: GPS_LNG });
    });

    it('returns provider=offline when no active provider is configured (default)', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({});

      const result = await service.getJobCredentials(USER_ID, NODE_ID, JOB_ID);

      expect(result).toEqual({ type: 'geocode', provider: 'offline', lat: GPS_LAT, lng: GPS_LNG });
      expect((result as any).apiKey).toBeUndefined();
      expect((result as any).baseUrl).toBeUndefined();
    });

    it('400s when the job has no mediaItemId', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ type: 'geocode', mediaItemId: null }),
      );

      await expect(service.getJobCredentials(USER_ID, NODE_ID, JOB_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it.each([
      ['null coordinates', null, null],
      ['NaN latitude', NaN, GPS_LNG],
      ['NaN longitude', GPS_LAT, NaN],
    ])('400s when the MediaItem has no usable GPS coordinates (%s)', async (_label, lat, lng) => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({ takenLat: lat, takenLng: lng });

      await expect(service.getJobCredentials(USER_ID, NODE_ID, JOB_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  // =========================================================================
  // Unsupported job type
  // =========================================================================

  describe('unsupported job type', () => {
    it('400s for a job type with no credentials contract (e.g. duplicate_detection)', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ type: 'duplicate_detection' }),
      );

      await expect(service.getJobCredentials(USER_ID, NODE_ID, JOB_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
