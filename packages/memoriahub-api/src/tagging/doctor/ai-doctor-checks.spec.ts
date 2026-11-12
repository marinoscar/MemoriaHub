import { FakeMemoriahubAiAdmin } from '../../testing/index.js';
import { AiTaggingDoctorCheck } from './ai-tagging.doctor-check.js';
import { VideoTaggingDoctorCheck, decideVideoTagging } from './video-tagging.doctor-check.js';

const settingsOver = (doc: Record<string, unknown>) =>
  ({ readSystem: async (name: string) => ({ value: doc[name], version: 1 }) }) as never;
const doctor = { registerCheck: jest.fn() };

const videoDoc = (over: Record<string, unknown> = {}) => ({
  features: { autoTagging: true },
  autoTagging: { video: { enabled: true, maxFrames: 4, transcription: { enabled: true, leadSeconds: 20 } } },
  ai: { features: { tagging: { provider: 'openai', model: 'v1' }, transcription: { provider: 'openai', model: 'whisper' } } },
  ...over,
});

describe('tagging slice AI diagnostics (RETRO-J10, #624)', () => {
  afterEach(() => {
    delete process.env['AUTO_TAG_ENABLED'];
  });

  it('ai.tagging: id, skip, pass and fail through the AI administration port', async () => {
    const admin = new FakeMemoriahubAiAdmin();
    const check = new AiTaggingDoctorCheck(
      doctor as never,
      settingsOver({ ai: { features: { tagging: { provider: 'anthropic', model: 'c1' } } } }),
      admin,
    );
    expect(check.id).toBe('memoriahub.ai.tagging');
    expect(await check.run()).toMatchObject({ status: 'pass', data: { provider: 'anthropic', model: 'c1' } });
    admin.models.set('anthropic/c1', { ok: false, error: 'overloaded' });
    expect(await check.run()).toMatchObject({ status: 'fail', detail: 'overloaded' });

    const none = new AiTaggingDoctorCheck(doctor as never, settingsOver({ ai: { features: {} } }), admin);
    expect((await none.run()).status).toBe('skip');
  });

  it('ai.video-tagging: the visual pass is required, transcription is an enrichment', async () => {
    const admin = new FakeMemoriahubAiAdmin();
    const run = () => new VideoTaggingDoctorCheck(doctor as never, settingsOver(videoDoc()), admin).run();
    expect(new VideoTaggingDoctorCheck(doctor as never, settingsOver(videoDoc()), admin).id).toBe('memoriahub.ai.video-tagging');

    // No tagging key: a FAIL.
    expect(await run()).toMatchObject({ status: 'fail', detail: 'No enabled openai credential configured for tagging.' });

    // A tagging key and a provider that can transcribe: ready, with transcription.
    admin.credentials.set('openai', { configured: true, enabled: true });
    admin.capabilities.set('openai', { transcribeAudio: true });
    expect(await run()).toMatchObject({ status: 'pass', data: { maxFrames: 4, transcription: true } });

    // A provider with no audio capability: a WARN.
    admin.capabilities.set('openai', { transcribeAudio: false });
    expect(await run()).toMatchObject({ status: 'warn' });

    // An unknown provider is not a missing capability.
    admin.capabilities.delete('openai');
    expect((await run()).status).toBe('pass');
  });

  it('ai.video-tagging: skip ladder and the AUTO_TAG_ENABLED override need no AI administration port', async () => {
    const off = new VideoTaggingDoctorCheck(doctor as never, settingsOver(videoDoc({ features: { autoTagging: false } })));
    expect((await off.run()).status).toBe('skip');

    process.env['AUTO_TAG_ENABLED'] = 'false';
    expect((await new VideoTaggingDoctorCheck(doctor as never, settingsOver(videoDoc())).run()).status).toBe('warn');
    delete process.env['AUTO_TAG_ENABLED'];

    // A probe is needed and the host has none: skipped, not failed.
    expect((await new VideoTaggingDoctorCheck(doctor as never, settingsOver(videoDoc())).run()).status).toBe('skip');
  });

  it('decideVideoTagging: visual-only pass when transcription is off', () => {
    const out = decideVideoTagging({
      autoTaggingEnabled: true,
      videoEnabled: true,
      envDisabled: false,
      tagging: { provider: 'openai', model: 'v1' },
      taggingCredentialEnabled: true,
      maxFrames: 6,
      transcriptionOn: false,
      leadSeconds: 30,
      transcription: null,
      transcriptionCredentialEnabled: false,
      transcriptionProviderLacksAudio: false,
    });
    expect(out).toMatchObject({ status: 'pass', data: { maxFrames: 6, transcription: false } });
  });
});
