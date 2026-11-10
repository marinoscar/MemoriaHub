import type { DefaultAiTargetResolver } from '@marinoscar/platform-api/ai';

import { AI_FEATURE_SELECTION, isMemoriaHubAiFeature } from './ai-features';
import type { MemoriaHubAiSettings } from './memoriahub-ai-settings';
import { MemoriaHubAiTargetResolver } from './memoriahub-ai-target-resolver';

// The feature -> (provider, model) routing the platform asks `AI_TARGET_RESOLVER` for (RETRO-E2).

describe('MemoriaHubAiTargetResolver', () => {
  let forFeature: jest.Mock;
  let fallbackResolve: jest.Mock;
  let resolver: MemoriaHubAiTargetResolver;

  beforeEach(() => {
    forFeature = jest.fn();
    fallbackResolve = jest.fn().mockResolvedValue({ provider: 'fallback', model: 'default' });
    resolver = new MemoriaHubAiTargetResolver(
      { forFeature } as unknown as MemoriaHubAiSettings,
      { resolve: fallbackResolve } as unknown as DefaultAiTargetResolver,
    );
  });

  it('answers the saved selection for a MemoriaHub feature', async () => {
    forFeature.mockResolvedValue({ provider: 'openai', model: 'gpt-5.5' });

    await expect(
      resolver.resolve({ userId: 'u1', feature: 'search_agent', requested: {} }),
    ).resolves.toEqual({ provider: 'openai', model: 'gpt-5.5' });
    expect(forFeature).toHaveBeenCalledWith('search_agent');
    expect(fallbackResolve).not.toHaveBeenCalled();
  });

  it('answers a system call (no user) the same way', async () => {
    forFeature.mockResolvedValue({ provider: 'openai', model: 'gpt-image-1' });

    await expect(
      resolver.resolve({ userId: null, feature: 'picture_enhance', requested: {} }),
    ).resolves.toEqual({ provider: 'openai', model: 'gpt-image-1' });
  });

  it('lets a call that names BOTH provider and model win (the probes test an unsaved model)', async () => {
    forFeature.mockResolvedValue({ provider: 'openai', model: 'gpt-5.5' });

    await expect(
      resolver.resolve({
        userId: null,
        feature: 'semantic_embedding',
        requested: { provider: 'openai', model: 'text-embedding-3-large' },
      }),
    ).resolves.toEqual({ provider: 'openai', model: 'text-embedding-3-large' });
    expect(forFeature).not.toHaveBeenCalled();
  });

  it('answers null ("No model selected") when the feature has no saved selection', async () => {
    forFeature.mockResolvedValue(null);

    await expect(
      resolver.resolve({ userId: 'u1', feature: 'memory_titles', requested: {} }),
    ).resolves.toBeNull();
  });

  it('defers every other feature (the Playground, a call with none) to the platform order', async () => {
    await expect(
      resolver.resolve({ userId: 'u1', feature: 'playground', requested: {} }),
    ).resolves.toEqual({ provider: 'fallback', model: 'default' });
    await expect(resolver.resolve({ userId: 'u1', requested: {} })).resolves.toEqual({
      provider: 'fallback',
      model: 'default',
    });
    expect(forFeature).not.toHaveBeenCalled();
  });

  it('routes each of the seven features through one of the six saved selections', () => {
    expect(Object.keys(AI_FEATURE_SELECTION).sort()).toEqual([
      'media_tagging',
      'memory_titles',
      'picture_enhance',
      'search_agent',
      'semantic_embedding',
      'video_tagging',
      'video_transcription',
    ]);
    expect(new Set(Object.values(AI_FEATURE_SELECTION))).toEqual(
      new Set(['search', 'tagging', 'embedding', 'enhance', 'memories', 'transcription']),
    );
    expect(isMemoriaHubAiFeature('search_agent')).toBe(true);
    expect(isMemoriaHubAiFeature('playground')).toBe(false);
    expect(isMemoriaHubAiFeature(undefined)).toBe(false);
  });
});
