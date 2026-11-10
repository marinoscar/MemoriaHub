/**
 * Unit tests for AiSettingsService.
 *
 * IMPORTANT: SECRETS_ENCRYPTION_KEY must be set for encrypt/decrypt to work.
 * We set it in beforeAll and clean up in afterAll.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AiSettingsService } from './ai-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { AiService } from '@marinoscar/platform-api/ai';
import { MemoriaHubAiSettings } from './memoriahub-ai-settings';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { encryptSecret } from '../legacy/legacy-secret-cipher';
import { composePatchSystemSettingsSchema } from '@marinoscar/platform-api/settings';
import '../settings/registry';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';
import { AiDeploymentKeySource } from './ai-deployment-key-source';
import { CredentialsService } from '@marinoscar/platform-api/credentials';

const VALID_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';

describe('AiSettingsService', () => {
  let service: AiSettingsService;
  let mockPrisma: MockPrismaService;
  /** The platform AiService as a system call: `respond` (the probe) and `embed`. */
  let mockRespond: jest.Mock;
  let mockEmbed: jest.Mock;
  let mockSelection: jest.Mock;
  let mockSystemSettings: { getSettings: jest.Mock; patchSettings: jest.Mock };
  let originalKey: string | undefined;

  beforeAll(() => {
    originalKey = process.env.SECRETS_ENCRYPTION_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env.SECRETS_ENCRYPTION_KEY;
    } else {
      process.env.SECRETS_ENCRYPTION_KEY = originalKey;
    }
  });

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockRespond = jest.fn();
    mockEmbed = jest.fn();
    mockSelection = jest.fn().mockResolvedValue(null);
    mockSystemSettings = {
      getSettings: jest.fn(),
      patchSettings: jest.fn(),
    };
    // `getSettings` lists the providers (`findMany`), then reads each status (`findUnique`): answer
    // the per-provider read from whatever the test's `findMany` returns.
    mockPrisma.aiProviderCredential.findUnique.mockImplementation((async (args: { where: { provider: string } }) => {
      const rows = ((await mockPrisma.aiProviderCredential.findMany({} as never)) ?? []) as Array<{ provider: string }>;
      return rows.find((r) => r.provider === args.where.provider) ?? null;
    }) as never);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MemoriaHubAiSettings, useValue: { selection: mockSelection } },
        { provide: AiService, useValue: { forSystem: jest.fn(() => ({ respond: mockRespond, embed: mockEmbed })) } },
        { provide: AppSystemSettingsService, useValue: mockSystemSettings },
        // The real key source over an EMPTY platform store, so every test here exercises the
        // legacy-row fallback (the platform-first order: ai-deployment-key-source.spec.ts).
        AiDeploymentKeySource,
        {
          provide: CredentialsService,
          useValue: {
            describe: jest.fn().mockResolvedValue(null),
            list: jest.fn().mockResolvedValue([]),
            getSecret: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = module.get<AiSettingsService>(AiSettingsService);
  });

  // upsertCredential / deleteCredential were removed by RETRO-E3 (#605): the legacy key table is
  // read-only and the routes answer 410 (ai-settings.controller.spec.ts).

  // ---------------------------------------------------------------------------
  // getSettings
  // ---------------------------------------------------------------------------
  describe('getSettings', () => {
    it('never exposes encryptedKey or apiKey in the response', async () => {
      mockPrisma.aiProviderCredential.findMany.mockResolvedValue([
        {
          provider: 'openai',
          last4: 'abcd',
          baseUrl: null,
          enabled: true,
          updatedAt: new Date(),
          // encryptedKey intentionally present in the DB record but select excludes it
        },
      ] as any);
      mockSystemSettings.getSettings.mockResolvedValue({ ai: null });

      const result = await service.getSettings();

      // Walk the result deeply — no property should be named encryptedKey or apiKey
      const str = JSON.stringify(result);
      expect(str).not.toContain('encryptedKey');
      expect(str).not.toContain('apiKey');
    });

    it('returns providers with configured:true for stored credentials', async () => {
      mockPrisma.aiProviderCredential.findMany.mockResolvedValue([
        { provider: 'openai', last4: 'efgh', baseUrl: null, enabled: true, updatedAt: new Date() },
      ] as any);
      mockSystemSettings.getSettings.mockResolvedValue({ ai: null });

      const result = await service.getSettings();

      const openAiProvider = result.providers.find((p) => p.provider === 'openai');
      expect(openAiProvider).toBeDefined();
      expect(openAiProvider!.configured).toBe(true);
      expect(openAiProvider!.last4).toBe('efgh');
    });

    it('returns knownProviders listing unconfigured providers', async () => {
      mockPrisma.aiProviderCredential.findMany.mockResolvedValue([]);
      mockSystemSettings.getSettings.mockResolvedValue({ ai: null });

      const result = await service.getSettings();

      expect(result.knownProviders.length).toBe(2);
      for (const kp of result.knownProviders) {
        expect(kp.configured).toBe(false);
        expect(kp.enabled).toBe(false);
      }
    });

    it('returns default feature settings when ai system settings are null', async () => {
      mockPrisma.aiProviderCredential.findMany.mockResolvedValue([]);
      mockSystemSettings.getSettings.mockResolvedValue({ ai: null });

      const result = await service.getSettings();

      expect(result.features).toEqual({
        search: { provider: null, model: null },
        tagging: { provider: null, model: null },
        embedding: { provider: null, model: null },
        enhance: null,
        memories: null,
        transcription: null,
      });
    });

    it('returns stored feature settings from system settings', async () => {
      mockPrisma.aiProviderCredential.findMany.mockResolvedValue([]);
      mockSystemSettings.getSettings.mockResolvedValue({
        ai: {
          features: { search: { provider: 'openai', model: 'gpt-4o' } },
        },
      });

      const result = await service.getSettings();

      expect(result.features).toEqual({ search: { provider: 'openai', model: 'gpt-4o' } });
    });
  });

  // ---------------------------------------------------------------------------
  // resolveCredentials
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // setEmbeddingFeature
  // ---------------------------------------------------------------------------
  describe('setEmbeddingFeature', () => {
    it('calls patchSettings with the embedding provider and model', async () => {
      mockSystemSettings.patchSettings.mockResolvedValue(undefined);

      const result = await service.setEmbeddingFeature(
        { provider: 'openai', model: 'text-embedding-3-small' },
        'user-1',
      );

      expect(mockSystemSettings.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          ai: {
            features: {
              embedding: { provider: 'openai', model: 'text-embedding-3-small' },
            },
          },
        }),
        'user-1',
      );
      expect(result).toEqual({ provider: 'openai', model: 'text-embedding-3-small' });
    });

    it('returns the dto values as-is', async () => {
      mockSystemSettings.patchSettings.mockResolvedValue(undefined);

      const result = await service.setEmbeddingFeature(
        { provider: 'anthropic', model: 'embed-v1' },
        'user-2',
      );

      expect(result).toEqual({ provider: 'anthropic', model: 'embed-v1' });
    });
  });

  // ---------------------------------------------------------------------------
  // setMemoriesFeature / resolveMemoriesConfig (epic #300, issue #302)
  // ---------------------------------------------------------------------------
  describe('setMemoriesFeature', () => {
    it('persists the provider/model pair when the credential exists and is enabled', async () => {
      mockPrisma.aiProviderCredential.findUnique.mockResolvedValue({
        enabled: true,
      } as any);
      mockSystemSettings.patchSettings.mockResolvedValue(undefined);

      const result = await service.setMemoriesFeature(
        { provider: 'openai', model: 'gpt-4o-mini' },
        'user-1',
      );

      expect(mockSystemSettings.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          ai: {
            features: {
              memories: { provider: 'openai', model: 'gpt-4o-mini' },
            },
          },
        }),
        'user-1',
      );
      expect(result).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    });

    it('rejects a provider with NO configured credential (400)', async () => {
      mockPrisma.aiProviderCredential.findUnique.mockResolvedValue(null);

      await expect(
        service.setMemoriesFeature({ provider: 'openai', model: 'gpt-4o-mini' }, 'user-1'),
      ).rejects.toThrow(BadRequestException);

      // Nothing is written when validation fails.
      expect(mockSystemSettings.patchSettings).not.toHaveBeenCalled();
    });

    it('rejects a provider whose credential is DISABLED (400)', async () => {
      mockPrisma.aiProviderCredential.findUnique.mockResolvedValue({
        enabled: false,
      } as any);

      await expect(
        service.setMemoriesFeature({ provider: 'openai', model: 'gpt-4o-mini' }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockSystemSettings.patchSettings).not.toHaveBeenCalled();
    });

    it('clears the selection to null when either field is null — no credential check', async () => {
      mockSystemSettings.patchSettings.mockResolvedValue(undefined);

      const result = await service.setMemoriesFeature(
        { provider: 'openai', model: null },
        'user-1',
      );

      expect(result).toBeNull();
      expect(mockPrisma.aiProviderCredential.findUnique).not.toHaveBeenCalled();
      expect(mockSystemSettings.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({ ai: { features: { memories: null } } }),
        'user-1',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // setTranscriptionFeature / resolveTranscriptionConfig (epic #452, issue #454)
  // ---------------------------------------------------------------------------
  describe('setTranscriptionFeature', () => {
    it('persists the provider/model pair when the credential exists and is enabled', async () => {
      mockPrisma.aiProviderCredential.findUnique.mockResolvedValue({
        enabled: true,
      } as any);
      mockSystemSettings.patchSettings.mockResolvedValue(undefined);

      const result = await service.setTranscriptionFeature(
        { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
        'user-1',
      );

      expect(mockSystemSettings.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          ai: {
            features: {
              transcription: { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
            },
          },
        }),
        'user-1',
      );
      expect(result).toEqual({ provider: 'openai', model: 'gpt-4o-mini-transcribe' });
    });

    it('rejects a provider with no configured credential (400) — a bad selection would otherwise only surface inside an unattended job', async () => {
      mockPrisma.aiProviderCredential.findUnique.mockResolvedValue(null);

      await expect(
        service.setTranscriptionFeature(
          { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockSystemSettings.patchSettings).not.toHaveBeenCalled();
    });

    it('rejects a provider whose credential is DISABLED (400)', async () => {
      mockPrisma.aiProviderCredential.findUnique.mockResolvedValue({
        enabled: false,
      } as any);

      await expect(
        service.setTranscriptionFeature(
          { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockSystemSettings.patchSettings).not.toHaveBeenCalled();
    });

    it('clears the selection to null when either field is null — no credential check', async () => {
      mockSystemSettings.patchSettings.mockResolvedValue(undefined);

      const result = await service.setTranscriptionFeature(
        { provider: 'openai', model: null },
        'user-1',
      );

      expect(result).toBeNull();
      expect(mockPrisma.aiProviderCredential.findUnique).not.toHaveBeenCalled();
      expect(mockSystemSettings.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({ ai: { features: { transcription: null } } }),
        'user-1',
      );
    });
  });


  // ---------------------------------------------------------------------------
  // The wire DTO is a hand-maintained THIRD copy of every settings namespace
  // and strips unknown keys, so a namespace present only in the two zod
  // schemas validates in unit tests while every real PATCH silently no-ops.
  // See CLAUDE.md's "three hand-maintained copies" pitfall.
  // ---------------------------------------------------------------------------
  describe('ai.features.transcription is registered in the PATCH wire DTO', () => {
    it('survives patchSystemSettingsSchema parsing rather than being stripped', () => {
      const parsed: any = composePatchSystemSettingsSchema().parse({
        ai: {
          features: {
            transcription: { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
          },
        },
      });

      expect(parsed.ai?.features?.transcription).toEqual({
        provider: 'openai',
        model: 'gpt-4o-mini-transcribe',
      });
    });

    it('accepts an explicit null (clearing the selection)', () => {
      const parsed: any = composePatchSystemSettingsSchema().parse({
        ai: { features: { transcription: null } },
      });

      expect(parsed.ai?.features?.transcription).toBeNull();
    });
  });


  // ---------------------------------------------------------------------------
  // resolveEmbeddingConfig
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // getSettings — embedding feature in response
  // ---------------------------------------------------------------------------
  describe('getSettings — embedding feature', () => {
    it('returns default embedding feature when ai system settings are null', async () => {
      mockPrisma.aiProviderCredential.findMany.mockResolvedValue([]);
      mockSystemSettings.getSettings.mockResolvedValue({ ai: null });

      const result = await service.getSettings();

      expect(result.features).toMatchObject({
        embedding: { provider: null, model: null },
      });
    });

    it('returns stored embedding feature from system settings', async () => {
      mockPrisma.aiProviderCredential.findMany.mockResolvedValue([]);
      mockSystemSettings.getSettings.mockResolvedValue({
        ai: {
          features: {
            embedding: { provider: 'openai', model: 'text-embedding-3-small' },
          },
        },
      });

      const result = await service.getSettings();

      expect(result.features).toMatchObject({
        embedding: { provider: 'openai', model: 'text-embedding-3-small' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // testEmbedding
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // listEmbeddingModels
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // testProvider
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // testEmbedding: through the platform AiService (feature semantic_embedding)
  // ---------------------------------------------------------------------------
  describe('testEmbedding', () => {
    it('(a) returns ok:true with dimensions:1536 when the model answers a 1536-length vector', async () => {
      mockEmbed.mockResolvedValue({ vectors: [new Array(1536).fill(0.1)] });

      const result = await service.testEmbedding({ provider: 'openai', model: 'text-embedding-3-small' });

      expect(result).toEqual({ ok: true, provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 });
    });

    it('(b) returns ok:true WITH a warning for a mismatched-dimension model (3072-d)', async () => {
      mockEmbed.mockResolvedValue({ vectors: [new Array(3072).fill(0.1)] });

      const result = await service.testEmbedding({ provider: 'openai', model: 'text-embedding-3-large' });

      expect(result.ok).toBe(true);
      expect(result.dimensions).toBe(3072);
      expect(result.warning).toMatch(/3072/);
      expect(result.warning).toMatch(/1536/);
    });

    it('(c) returns ok:false when no provider/model configured and none passed', async () => {
      mockSelection.mockResolvedValue(null);

      const result = await service.testEmbedding({});

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no embedding provider/i);
      expect(mockEmbed).not.toHaveBeenCalled();
    });

    it('(d) returns ok:false with the platform message when the call is refused', async () => {
      mockEmbed.mockRejectedValue(new Error('The model does not support embeddings.'));

      const result = await service.testEmbedding({ provider: 'anthropic', model: 'embed-v1' });

      expect(result).toEqual({
        ok: false,
        provider: 'anthropic',
        model: 'embed-v1',
        error: 'The model does not support embeddings.',
      });
    });

    it('(e) falls back to the saved embedding selection when none is passed', async () => {
      mockSelection.mockResolvedValue({ provider: 'openai', model: 'text-embedding-3-small' });
      mockEmbed.mockResolvedValue({ vectors: [new Array(1536).fill(0.1)] });

      await service.testEmbedding({});

      expect(mockSelection).toHaveBeenCalledWith('embedding');
      expect(mockEmbed).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai', model: 'text-embedding-3-small' }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // testProvider: one small call through the platform AiService
  // ---------------------------------------------------------------------------
  describe('testProvider', () => {
    it('answers ok when the platform call succeeds', async () => {
      mockRespond.mockResolvedValue({ outputText: 'hi' });

      const result = await service.testProvider({ provider: 'openai', model: 'gpt-5.4' });

      expect(result).toEqual({ ok: true });
      expect(mockRespond).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai', model: 'gpt-5.4', input: 'hi' }),
      );
    });

    it('propagates the failure message (no key, model not enabled, provider error)', async () => {
      mockRespond.mockRejectedValue(new Error('Unauthorized'));

      const result = await service.testProvider({ provider: 'anthropic', model: 'claude-haiku-4-5' });

      expect(result).toEqual({ ok: false, error: 'Unauthorized' });
    });

    it('refuses an unknown provider before any call', async () => {
      await expect(service.testProvider({ provider: 'nope', model: 'x' })).rejects.toThrow(BadRequestException);
      expect(mockRespond).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Model lists: the platform catalogue first, the curated starter list before it has rows
  // ---------------------------------------------------------------------------
  describe('model lists', () => {
    const row = (modelId: string, capabilities: string[]) => ({ modelId, capabilities: { capabilities } });

    it('lists the enabled catalogue models that declare the capability', async () => {
      (mockPrisma.aiModel.findMany as jest.Mock).mockResolvedValue([
        row('text-embedding-3-large', ['embeddings']),
        row('text-embedding-3-small', ['embeddings']),
        row('gpt-5.5', ['responses']),
      ]);

      await expect(service.listEmbeddingModels('openai')).resolves.toEqual([
        'text-embedding-3-large',
        'text-embedding-3-small',
      ]);
    });

    it('keeps the GPT >= 5.4 chat filter for OpenAI', async () => {
      (mockPrisma.aiModel.findMany as jest.Mock).mockResolvedValue([
        row('gpt-4o', ['responses']),
        row('gpt-5.4', ['responses']),
        row('gpt-5.5-mini', ['responses']),
        row('gpt-image-1', ['responses']),
      ]);

      await expect(service.listModels('openai')).resolves.toEqual(['gpt-5.4', 'gpt-5.5-mini']);
    });

    it('falls back to the curated starter list before the catalogue has been refreshed', async () => {
      (mockPrisma.aiModel.findMany as jest.Mock).mockResolvedValue([]);

      await expect(service.listEmbeddingModels('openai')).resolves.toEqual([
        'text-embedding-3-small',
        'text-embedding-3-large',
      ]);
      await expect(service.listImageModels('openai')).resolves.toEqual(['gpt-image-1']);
    });

    it('answers an empty list for a provider without the capability (e.g. anthropic embeddings)', async () => {
      (mockPrisma.aiModel.findMany as jest.Mock).mockResolvedValue([]);

      await expect(service.listEmbeddingModels('anthropic')).resolves.toEqual([]);
      await expect(service.listTranscriptionModels('anthropic')).resolves.toEqual([]);
    });
  });
});
