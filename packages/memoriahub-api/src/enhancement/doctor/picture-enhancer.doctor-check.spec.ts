import { FakeMemoriahubAiAdmin } from '../../testing/index.js';
import { PictureEnhancerDoctorCheck, decidePictureEnhancer } from './picture-enhancer.doctor-check.js';

const settingsOver = (doc: Record<string, unknown>) =>
  ({ readSystem: async (name: string) => ({ value: doc[name], version: 1 }) }) as never;
const doctor = { registerCheck: jest.fn() };
const on = { features: { pictureEnhancement: true }, ai: { features: { enhance: { provider: 'openai', model: 'gpt-image-1' } } } };

describe('ai.picture-enhancer doctor check (RETRO-J10, #624)', () => {
  afterEach(() => {
    delete process.env['PICTURE_ENHANCEMENT_ENABLED'];
  });

  it('keeps the permanent id and settings path', () => {
    const check = new PictureEnhancerDoctorCheck(doctor as never, settingsOver({}));
    expect(check.id).toBe('memoriahub.ai.picture-enhancer');
    expect(check.settingsPath).toBe('/admin/settings/enhancer');
  });

  it('is skipped when the feature is off and warns under the environment override, with no probe', async () => {
    const admin = new FakeMemoriahubAiAdmin();
    expect((await new PictureEnhancerDoctorCheck(doctor as never, settingsOver({ features: {} }), admin).run()).status).toBe('skip');
    process.env['PICTURE_ENHANCEMENT_ENABLED'] = 'false';
    expect((await new PictureEnhancerDoctorCheck(doctor as never, settingsOver(on), admin).run()).status).toBe('warn');
    expect(admin.calls).toEqual([]);
  });

  it('fails without an enabled key, passes with one, reading key presence only', async () => {
    const admin = new FakeMemoriahubAiAdmin();
    const check = new PictureEnhancerDoctorCheck(doctor as never, settingsOver(on), admin);
    expect(await check.run()).toMatchObject({ status: 'fail', detail: 'No enabled openai credential configured for enhancement.' });
    admin.credentials.set('openai', { configured: true, enabled: false });
    expect((await check.run()).status).toBe('fail');
    admin.credentials.set('openai', { configured: true, enabled: true });
    expect(await check.run()).toMatchObject({ status: 'pass', data: { provider: 'openai', model: 'gpt-image-1' } });
    expect(admin.calls.every((c) => c.startsWith('credentialStatus:'))).toBe(true);
  });

  it('checks the openai key when no provider is selected, then warns about the missing model', async () => {
    const admin = new FakeMemoriahubAiAdmin();
    admin.credentials.set('openai', { configured: true, enabled: true });
    const check = new PictureEnhancerDoctorCheck(doctor as never, settingsOver({ features: { pictureEnhancement: true }, ai: { features: {} } }), admin);
    expect((await check.run()).status).toBe('warn');
    expect(admin.calls).toEqual(['credentialStatus:openai']);
  });

  it('is skipped (not failed) when a key probe is needed and the host binds no AI administration port', async () => {
    expect((await new PictureEnhancerDoctorCheck(doctor as never, settingsOver(on)).run()).status).toBe('skip');
  });

  it('decide: no model selected is a warn', () => {
    expect(decidePictureEnhancer({ featureEnabled: true, envDisabled: false, provider: null, model: null, credentialConfigured: true }).status).toBe('warn');
  });
});
