/**
 * The MemoriaHub section of the admin AI page (RETRO-E4, #607): the per-feature provider and
 * model selections over `/api/admin/memoriahub-ai/*`, with the write controls gated on
 * `ai_config:write` (the API enforces it; the page only disables).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';

vi.mock('../../../services/ai', () => ({
  getAiSettings: vi.fn(),
  getAiModelsFor: vi.fn(),
  putAiFeature: vi.fn(),
  testAiProvider: vi.fn(),
  testAiEmbedding: vi.fn(),
}));
vi.mock('../../../hooks/usePermissions', () => ({ usePermissions: vi.fn() }));

import { getAiModelsFor, getAiSettings, putAiFeature } from '../../../services/ai';
import { usePermissions } from '../../../hooks/usePermissions';
import {
  MEMORIAHUB_AI_FEATURES,
  MemoriaHubAiFeaturesSection,
} from '../../../platform/ai/MemoriaHubAiFeaturesSection';

const settings = {
  providers: [{ provider: 'openai', configured: true, enabled: true, last4: 'abcd', baseUrl: null }],
  knownProviders: [{ provider: 'anthropic', configured: false, enabled: false, last4: null, baseUrl: null }],
  features: {
    search: { provider: 'openai', model: 'model-a' },
    tagging: { provider: null, model: null },
    embedding: { provider: null, model: null },
    enhance: null,
    memories: { provider: 'openai', model: 'model-a' },
    transcription: null,
  },
};

function permissions(write: boolean) {
  return {
    hasPermission: (p: string) => p === 'ai_config:read' || (write && p === 'ai_config:write'),
  } as unknown as ReturnType<typeof usePermissions>;
}

describe('MemoriaHubAiFeaturesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAiSettings).mockResolvedValue(settings as never);
    vi.mocked(getAiModelsFor).mockResolvedValue(['model-a', 'model-b']);
    vi.mocked(putAiFeature).mockResolvedValue(undefined);
  });

  it('lists the six MemoriaHub features with their saved selection', async () => {
    vi.mocked(usePermissions).mockReturnValue(permissions(true));
    render(<MemoriaHubAiFeaturesSection />);

    expect(await screen.findByRole('heading', { name: 'MemoriaHub AI features' })).toBeInTheDocument();
    for (const feature of MEMORIAHUB_AI_FEATURES) {
      expect(screen.getByRole('heading', { name: feature.title })).toBeInTheDocument();
    }
    expect(MEMORIAHUB_AI_FEATURES.map((f) => f.key)).toEqual([
      'search',
      'tagging',
      'embedding',
      'enhance',
      'memories',
      'transcription',
    ]);
    expect(screen.getAllByText('OpenAI · model-a')).toHaveLength(2);
  });

  it('asks each feature for its own model list (image for the enhancer, transcription for video)', async () => {
    vi.mocked(usePermissions).mockReturnValue(permissions(true));
    render(<MemoriaHubAiFeaturesSection />);
    await screen.findByRole('heading', { name: 'MemoriaHub AI features' });

    await waitFor(() => expect(getAiModelsFor).toHaveBeenCalledWith('openai', 'chat'));
  });

  it('clears a whole-or-null selection with nulls', async () => {
    vi.mocked(usePermissions).mockReturnValue(permissions(true));
    const user = userEvent.setup();
    render(<MemoriaHubAiFeaturesSection />);
    const memories = await screen.findByRole('region', { name: 'Memory titles' });

    await user.click(memories.querySelector('button:last-of-type') as HTMLElement);

    await waitFor(() => expect(putAiFeature).toHaveBeenCalledWith('memories', { provider: null, model: null }));
  });

  it('disables every write without ai_config:write', async () => {
    vi.mocked(usePermissions).mockReturnValue(permissions(false));
    render(<MemoriaHubAiFeaturesSection />);
    await screen.findByRole('heading', { name: 'MemoriaHub AI features' });

    for (const button of screen.getAllByRole('button', { name: /^(Save|Test|Clear)$/ })) {
      expect(button).toBeDisabled();
    }
  });

  it('warns when the chosen provider has no enabled deployment key', async () => {
    vi.mocked(getAiSettings).mockResolvedValue({
      ...settings,
      features: { ...settings.features, search: { provider: 'anthropic', model: 'model-a' } },
    } as never);
    vi.mocked(usePermissions).mockReturnValue(permissions(true));
    render(<MemoriaHubAiFeaturesSection />);

    expect(await screen.findByText(/Anthropic has no enabled deployment key/)).toBeInTheDocument();
  });
});
