import { AI_SYSTEM_SETTINGS } from '@marinoscar/platform-api/ai';
import { extendSystemSettingsNamespace, type SystemSettingsNamespace } from '@marinoscar/platform-api/settings';

import {
  AI_FEATURES_DEFAULTS,
  MEMORIAHUB_AI_SETTINGS_EXTENSION,
  mergeAiFeatures,
} from './ai-settings.extension';

// The `ai` namespace is the platform's since RETRO-E1 (#595); MemoriaHub's per-feature
// selections ride in it unchanged. These cases pin the merge and read rules the old
// app namespace had, so the feature routes (`/api/admin/memoriahub-ai/features/*`) behave exactly as before.

const SAVED = {
  search: { provider: 'openai', model: 'gpt-5.5' },
  tagging: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  embedding: { provider: 'openai', model: 'text-embedding-3-small' },
  enhance: { provider: 'openai', model: 'gpt-image-1' },
  memories: null,
  transcription: { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
};

describe('MEMORIAHUB_AI_SETTINGS_EXTENSION', () => {
  it('patches one selection without touching the others', () => {
    const merged = mergeAiFeatures(SAVED, { memories: { provider: 'openai', model: 'gpt-5.4' } });
    expect(merged).toEqual({ ...SAVED, memories: { provider: 'openai', model: 'gpt-5.4' } });
  });

  it('keeps the stored provider/model on an explicit null for search, tagging and embedding', () => {
    const merged = mergeAiFeatures(SAVED, { search: { provider: null, model: 'gpt-5.4' } });
    expect(merged.search).toEqual({ provider: 'openai', model: 'gpt-5.4' });
  });

  it('clears a whole-or-null selection with null', () => {
    expect(mergeAiFeatures(SAVED, { transcription: null }).transcription).toBeNull();
  });

  it('salvages each selection on its own when a stored row lacks one', () => {
    const { transcription: _gone, ...older } = SAVED;
    expect(mergeAiFeatures(older, undefined)).toEqual({ ...SAVED, transcription: null });
    expect(mergeAiFeatures(undefined, undefined)).toEqual(AI_FEATURES_DEFAULTS);
  });

  it('extends the platform namespace: defaults carry both halves and a patch keeps the platform fields', () => {
    const extended = extendSystemSettingsNamespace(
      AI_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace,
      MEMORIAHUB_AI_SETTINGS_EXTENSION,
    );
    const defaults = extended.defaults as Record<string, unknown>;
    expect(defaults['features']).toEqual(AI_FEATURES_DEFAULTS);
    expect(defaults['enabled']).toBe(false);

    const current = { ...defaults, features: SAVED };
    const merged = extended.merge(current, { features: { enhance: null } }) as Record<string, unknown>;
    expect(merged['enabled']).toBe(false);
    expect(merged['features']).toEqual({ ...SAVED, enhance: null });

    expect(extended.putSchema.safeParse({ ...defaults, features: { ...SAVED, enhance: 'x' } }).success).toBe(false);
    expect(extended.wirePatchSchema.safeParse({ features: { search: { model: 'm' } } }).success).toBe(true);
  });
});
