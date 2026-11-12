import { PlatformMemoriahubAiAdminAdapter } from './platform-memoriahub-ai-admin.adapter';

function build() {
  const aiSettings = {
    testProvider: jest.fn(async () => ({ ok: true })),
    testEmbedding: jest.fn(async () => ({ ok: true, dimensions: 1536 })),
    credentialStatus: jest.fn(async () => ({ configured: true, enabled: false, last4: 'abcd' })),
  };
  const providers = {
    get: jest.fn((key: string) => {
      if (key === 'openai') return { id: key, audio: { transcribe: jest.fn() } };
      if (key === 'anthropic') return { id: key };
      if (key === 'broken') throw new Error('registry down');
      return undefined;
    }),
  };
  return { adapter: new PlatformMemoriahubAiAdminAdapter(aiSettings as never, providers as never), aiSettings, providers };
}

describe('PlatformMemoriahubAiAdminAdapter (RETRO-J10, #624)', () => {
  it('tests a model on the AI admin service call path', async () => {
    const { adapter, aiSettings } = build();
    await expect(adapter.testModel({ provider: 'openai', model: 'gpt-x' })).resolves.toEqual({ ok: true });
    expect(aiSettings.testProvider).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-x' });
  });

  it('tests the configured embedding (no provider or model passed)', async () => {
    const { adapter, aiSettings } = build();
    await expect(adapter.testEmbedding()).resolves.toEqual({ ok: true, dimensions: 1536 });
    expect(aiSettings.testEmbedding).toHaveBeenCalledWith({});
  });

  it('reports a key as configured and enabled only, never its last digits', async () => {
    const { adapter } = build();
    await expect(adapter.credentialStatus('openai')).resolves.toEqual({ configured: true, enabled: false });
  });

  it('reads the speech-to-text capability from the provider registry', () => {
    const { adapter } = build();
    expect(adapter.providerCapabilities('openai')).toEqual({ transcribeAudio: true });
    expect(adapter.providerCapabilities('anthropic')).toEqual({ transcribeAudio: false });
  });

  it('answers null for an unknown provider and for a registry that throws', () => {
    const { adapter } = build();
    expect(adapter.providerCapabilities('mystery')).toBeNull();
    expect(adapter.providerCapabilities('broken')).toBeNull();
  });
});
