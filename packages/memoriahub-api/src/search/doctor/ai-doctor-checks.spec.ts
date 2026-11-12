import { FakeMemoriahubAiAdmin } from '../../testing/index.js';
import { AiEmbeddingDoctorCheck } from './ai-embedding.doctor-check.js';
import { AiSearchDoctorCheck } from './ai-search.doctor-check.js';

/** A settings double: `peekSystem` answers the namespaces of `doc`. */
const settingsOver = (doc: Record<string, unknown>) =>
  ({ readSystem: async (name: string) => ({ value: doc[name], version: 1 }) }) as never;

describe('search slice AI diagnostics (RETRO-J10, #624)', () => {
  const doctor = { registerCheck: jest.fn() };

  it('ai.search: keeps the permanent id, registers, and skips without a configured model', async () => {
    const admin = new FakeMemoriahubAiAdmin();
    const check = new AiSearchDoctorCheck(doctor as never, settingsOver({ ai: { features: { search: { provider: null, model: null } } } }), admin);
    expect(check.id).toBe('memoriahub.ai.search');
    check.onModuleInit();
    expect(doctor.registerCheck).toHaveBeenCalledWith(check);
    expect((await check.run()).status).toBe('skip');
    expect(admin.calls).toEqual([]);
  });

  it('ai.search: passes when the live probe answers and fails with the provider error otherwise', async () => {
    const admin = new FakeMemoriahubAiAdmin();
    const doc = { ai: { features: { search: { provider: 'openai', model: 'm1' } } } };
    const check = new AiSearchDoctorCheck(doctor as never, settingsOver(doc), admin);
    const ok = await check.run();
    expect(ok).toMatchObject({ status: 'pass', data: { provider: 'openai', model: 'm1' } });
    expect(admin.calls).toEqual(['testModel:openai/m1']);

    admin.models.set('openai/m1', { ok: false, error: 'bad key' });
    expect(await check.run()).toMatchObject({ status: 'fail', detail: 'bad key', remedy: 'Check the provider API key and model in Admin Settings → AI.' });
  });

  it('ai.search: skips (not a failure) when the host binds no AI administration port', async () => {
    const check = new AiSearchDoctorCheck(doctor as never, settingsOver({ ai: { features: { search: { provider: 'openai', model: 'm1' } } } }));
    expect((await check.run()).status).toBe('skip');
  });

  it('ai.embedding: skip, pass with dimensions, warn on a size mismatch, fail on an error', async () => {
    const admin = new FakeMemoriahubAiAdmin();
    const doc = { ai: { features: { embedding: { provider: 'openai', model: 'text-embedding-3-small' } } } };
    const check = new AiEmbeddingDoctorCheck(doctor as never, settingsOver(doc), admin);
    expect(check.id).toBe('memoriahub.ai.embedding');

    expect(await check.run()).toMatchObject({ status: 'pass', data: { dimensions: 1536 } });
    admin.embedding = { ok: true, dimensions: 3072, warning: 'does not fit' };
    expect(await check.run()).toMatchObject({ status: 'warn', detail: 'does not fit' });
    admin.embedding = { ok: false, error: 'quota' };
    expect(await check.run()).toMatchObject({ status: 'fail', detail: 'quota' });

    const none = new AiEmbeddingDoctorCheck(doctor as never, settingsOver({ ai: { features: {} } }), admin);
    expect((await none.run()).status).toBe('skip');
  });

  it('a probe that throws is a failed check, not an exception', async () => {
    const admin = new FakeMemoriahubAiAdmin();
    admin.testModel = async () => {
      throw new Error('network');
    };
    const check = new AiSearchDoctorCheck(doctor as never, settingsOver({ ai: { features: { search: { provider: 'openai', model: 'm1' } } } }), admin);
    expect(await check.run()).toMatchObject({ status: 'fail', detail: 'network' });
  });

});
