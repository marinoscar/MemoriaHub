/**
 * test/node/compute/video-auto-tagging.spec.ts
 *
 * Unit tests for node/compute/video-auto-tagging.ts (epic #452, issue #460).
 *
 * PARITY is the acceptance bar for this issue: a node's compute must be
 * indistinguishable from the server's. These tests assert the properties that
 * make that true — the frame budget and prompt come from the SHARED package,
 * the vision request carries every frame in ONE multi-image call, and the
 * result is raw text (parsing stays server-side, since a node has no access to
 * the tag_labels vocabulary).
 *
 * They also pin the two degradation rules the server has: transcription is
 * best-effort (any failure ⇒ visual-only), except a rate limit, which
 * propagates so the queue defers.
 *
 * Mocked via jest.unstable_mockModule, mirroring auto-tagging.spec.ts.
 */

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE importing the module under test.
// ---------------------------------------------------------------------------

const mockLoadConfig = jest.fn();
jest.unstable_mockModule('../../../src/config.js', () => ({
  loadConfig: mockLoadConfig,
}));

const mockGetJobCredentials = jest.fn();
const MockApiClient = jest.fn().mockImplementation(() => ({
  getJobCredentials: mockGetJobCredentials,
}));
jest.unstable_mockModule('../../../src/api.js', () => ({
  ApiClient: MockApiClient,
}));

const mockPrepareImageForProcessing = jest.fn();
jest.unstable_mockModule('@memoriahub/enrichment-compute/image', () => ({
  prepareImageForProcessing: mockPrepareImageForProcessing,
}));

const mockCallAnthropicVision = jest.fn();
const mockCallOpenAiVision = jest.fn();
const mockBuildVideoTaggingPrompt = jest.fn();
jest.unstable_mockModule('@memoriahub/enrichment-compute/ai', () => ({
  callAnthropicVision: mockCallAnthropicVision,
  callOpenAiVision: mockCallOpenAiVision,
  buildVideoTaggingPrompt: mockBuildVideoTaggingPrompt,
  VIDEO_AUTO_TAGGING_SYSTEM_PROMPT: 'SHARED_SYSTEM_PROMPT',
  VIDEO_TAGGING_MAX_TOKENS: 2048,
}));

const mockExtractFrames = jest.fn();
const mockExtractAudioLead = jest.fn();
jest.unstable_mockModule('@memoriahub/enrichment-compute/video', () => ({
  extractFrames: mockExtractFrames,
  extractAudioLead: mockExtractAudioLead,
}));

const { CapabilityUnavailableError } = await import('../../../src/node/capabilities.js');
const { default: computeVideoAutoTagging } = await import(
  '../../../src/node/compute/video-auto-tagging.js'
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ctx = { nodeId: 'node-1', jobId: 'job-1' };
const INPUT_URL = 'https://storage.example.com/signed/video.mp4';

function baseCreds(overrides: Record<string, unknown> = {}) {
  return {
    type: 'video_auto_tagging',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    apiKey: 'sk-test-key',
    system: 'SERVER_SYSTEM_PROMPT',
    labelNames: ['Beach', 'Birthday'],
    peopleNames: ['Alice'],
    ...overrides,
  };
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    durationMs: 30_000,
    maxFrames: 6,
    sampleIntervalSeconds: 5,
    transcriptionEnabled: false,
    leadSeconds: 30,
    ...overrides,
  };
}

function makeFrames(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    timestampMs: (i + 1) * 2500,
    buffer: Buffer.from(`frame-${i}`),
  }));
}

beforeEach(() => {
  mockLoadConfig.mockReset();
  MockApiClient.mockClear();
  mockGetJobCredentials.mockReset();
  mockPrepareImageForProcessing.mockReset();
  mockCallAnthropicVision.mockReset();
  mockCallOpenAiVision.mockReset();
  mockBuildVideoTaggingPrompt.mockReset();
  mockExtractFrames.mockReset();
  mockExtractAudioLead.mockReset();

  mockLoadConfig.mockReturnValue({ serverUrl: 'https://api.example.com', pat: 'pat-test-token' });
  mockGetJobCredentials.mockResolvedValue(baseCreds());
  mockExtractFrames.mockResolvedValue(makeFrames(6));
  mockPrepareImageForProcessing.mockResolvedValue({
    buffer: Buffer.from('prepared'),
    width: 800,
    height: 600,
  });
  mockBuildVideoTaggingPrompt.mockReturnValue('VIDEO_USER_PROMPT');
  mockCallAnthropicVision.mockResolvedValue('{"tags":["Beach"],"description":"d"}');
  mockCallOpenAiVision.mockResolvedValue('{"tags":["Beach"],"description":"d"}');
  mockExtractAudioLead.mockResolvedValue({
    buffer: Buffer.from('audio'),
    mimeType: 'audio/mp4',
    leadSeconds: 30,
  });
});

// ---------------------------------------------------------------------------

describe('computeVideoAutoTagging — URL input (issue #456)', () => {
  it('hands the presigned URL straight to the frame extractor, downloading nothing', async () => {
    await computeVideoAutoTagging(INPUT_URL, baseParams(), ctx);

    // video_auto_tagging is in the engine's URL_INPUT_TYPES, so `input` is a
    // URL, not a temp path — ffmpeg range-seeks it.
    expect(mockExtractFrames.mock.calls[0][0]).toBe(INPUT_URL);
  });
});

describe('computeVideoAutoTagging — parity with the server', () => {
  it('makes exactly ONE multi-image vision call carrying every prepared frame', async () => {
    await computeVideoAutoTagging(INPUT_URL, baseParams(), ctx);

    expect(mockCallAnthropicVision).toHaveBeenCalledTimes(1);
    const [, req] = mockCallAnthropicVision.mock.calls[0] as [unknown, Record<string, unknown>];
    expect((req.images as unknown[]).length).toBe(6);
    // The single-image field must not also be set.
    expect(req.imageBase64).toBeUndefined();
    expect(req.maxTokens).toBe(2048);
  });

  it('forwards the server-resolved frame budget, unchanged, for any video length', async () => {
    await computeVideoAutoTagging(INPUT_URL, baseParams({ maxFrames: 4, durationMs: 3 * 3600_000 }), ctx);

    expect(mockExtractFrames.mock.calls[0][1]).toMatchObject({
      durationMs: 3 * 3600_000,
      maxFrames: 4,
      sampleIntervalSeconds: 5,
    });
  });

  it('builds the prompt with the SHARED builder, from the server-supplied vocabulary and people', async () => {
    await computeVideoAutoTagging(INPUT_URL, baseParams(), ctx);

    // A node cannot read tag_labels, so these must come from the credentials
    // response — and the prompt must be composed by the same function the
    // server uses, or the two executors drift.
    expect(mockBuildVideoTaggingPrompt).toHaveBeenCalledWith(
      ['Beach', 'Birthday'],
      ['Alice'],
      [2500, 5000, 7500, 10000, 12500, 15000],
      null,
    );
  });

  it('prefers the server-sent system prompt over the local constant', async () => {
    await computeVideoAutoTagging(INPUT_URL, baseParams(), ctx);

    const [, req] = mockCallAnthropicVision.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(req.system).toBe('SERVER_SYSTEM_PROMPT');
  });

  it('falls back to the shared constant when the server sends no system prompt', async () => {
    mockGetJobCredentials.mockResolvedValue(baseCreds({ system: '' }));

    await computeVideoAutoTagging(INPUT_URL, baseParams(), ctx);

    const [, req] = mockCallAnthropicVision.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(req.system).toBe('SHARED_SYSTEM_PROMPT');
  });

  it('returns RAW text plus frame provenance — parsing stays server-side', async () => {
    const result = (await computeVideoAutoTagging(INPUT_URL, baseParams(), ctx)) as {
      rawText: string;
      frameCount: number;
      sampledTimestampsMs: number[];
    };

    expect(result.rawText).toBe('{"tags":["Beach"],"description":"d"}');
    expect(result.frameCount).toBe(6);
    expect(result.sampledTimestampsMs).toEqual([2500, 5000, 7500, 10000, 12500, 15000]);
  });

  it('skips a frame sharp cannot decode rather than failing the whole video', async () => {
    mockPrepareImageForProcessing
      .mockResolvedValueOnce({ buffer: Buffer.from('ok'), width: 800, height: 600 })
      .mockResolvedValueOnce({ buffer: Buffer.alloc(0), width: 0, height: 0 })
      .mockResolvedValue({ buffer: Buffer.from('ok'), width: 800, height: 600 });

    const result = (await computeVideoAutoTagging(INPUT_URL, baseParams(), ctx)) as {
      frameCount: number;
    };

    expect(result.frameCount).toBe(5);
    expect(mockCallAnthropicVision).toHaveBeenCalledTimes(1);
  });

  it('throws when no frame could be extracted at all', async () => {
    mockExtractFrames.mockResolvedValue([]);

    await expect(computeVideoAutoTagging(INPUT_URL, baseParams(), ctx)).rejects.toThrow(
      /no frames could be extracted/,
    );
    expect(mockCallAnthropicVision).not.toHaveBeenCalled();
  });
});

describe('computeVideoAutoTagging — provider dispatch', () => {
  it('routes openai to callOpenAiVision, never callAnthropicVision', async () => {
    mockGetJobCredentials.mockResolvedValue(baseCreds({ provider: 'openai', model: 'gpt-5.4' }));

    await computeVideoAutoTagging(INPUT_URL, baseParams(), ctx);

    expect(mockCallOpenAiVision).toHaveBeenCalledTimes(1);
    expect(mockCallAnthropicVision).not.toHaveBeenCalled();
  });

  it('DECLINES an unsupported provider so the job stays server-only, rather than failing it', async () => {
    mockGetJobCredentials.mockResolvedValue(baseCreds({ provider: 'moonshot' }));

    await expect(computeVideoAutoTagging(INPUT_URL, baseParams(), ctx)).rejects.toBeInstanceOf(
      CapabilityUnavailableError,
    );
    expect(mockCallAnthropicVision).not.toHaveBeenCalled();
    expect(mockCallOpenAiVision).not.toHaveBeenCalled();
  });

  it('rejects a credentials payload for the wrong job type', async () => {
    mockGetJobCredentials.mockResolvedValue(baseCreds({ type: 'auto_tagging' }));

    await expect(computeVideoAutoTagging(INPUT_URL, baseParams(), ctx)).rejects.toThrow(
      /unexpected credentials type/,
    );
  });

  it('requires job context to fetch transient credentials', async () => {
    await expect(computeVideoAutoTagging(INPUT_URL, baseParams(), undefined)).rejects.toThrow(
      /job context not provided/,
    );
  });
});

describe('computeVideoAutoTagging — transcription is best-effort', () => {
  const withTranscription = (overrides: Record<string, unknown> = {}) =>
    baseCreds({
      transcription: {
        provider: 'openai',
        model: 'gpt-4o-mini-transcribe',
        apiKey: 'sk-audio',
        ...overrides,
      },
    });

  it('never extracts audio when transcription is off', async () => {
    await computeVideoAutoTagging(INPUT_URL, baseParams({ transcriptionEnabled: false }), ctx);

    expect(mockExtractAudioLead).not.toHaveBeenCalled();
  });

  it('never extracts audio when the server sent no transcription credential', async () => {
    await computeVideoAutoTagging(INPUT_URL, baseParams({ transcriptionEnabled: true }), ctx);

    expect(mockExtractAudioLead).not.toHaveBeenCalled();
    expect(mockCallAnthropicVision).toHaveBeenCalledTimes(1);
  });

  it('degrades to visual-only when audio extraction fails (e.g. no audio track)', async () => {
    mockGetJobCredentials.mockResolvedValue(withTranscription());
    mockExtractAudioLead.mockRejectedValue(new Error('ffmpeg produced an empty output file'));

    const result = (await computeVideoAutoTagging(
      INPUT_URL,
      baseParams({ transcriptionEnabled: true }),
      ctx,
    )) as { transcript: unknown };

    // The tagging call still happens — transcription is an enrichment, not a
    // precondition.
    expect(mockCallAnthropicVision).toHaveBeenCalledTimes(1);
    expect(result.transcript).toBeNull();
  });

  it('RETHROWS a rate-limited transcription so the queue defers instead of silently degrading', async () => {
    mockGetJobCredentials.mockResolvedValue(withTranscription());
    mockExtractAudioLead.mockRejectedValue(Object.assign(new Error('slow down'), { status: 429 }));

    await expect(
      computeVideoAutoTagging(INPUT_URL, baseParams({ transcriptionEnabled: true }), ctx),
    ).rejects.toThrow(/slow down/);
    expect(mockCallAnthropicVision).not.toHaveBeenCalled();
  });

  it('bounds the audio to the server-resolved leadSeconds, not the video duration', async () => {
    mockGetJobCredentials.mockResolvedValue(withTranscription());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ text: 'happy birthday' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    try {
      await computeVideoAutoTagging(
        INPUT_URL,
        baseParams({ transcriptionEnabled: true, leadSeconds: 45, durationMs: 3 * 3600_000 }),
        ctx,
      );

      expect(mockExtractAudioLead.mock.calls[0][1]).toMatchObject({ leadSeconds: 45 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('feeds a successful transcript into the prompt and returns it with its leadSeconds', async () => {
    mockGetJobCredentials.mockResolvedValue(withTranscription());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ text: 'happy birthday' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    try {
      const result = (await computeVideoAutoTagging(
        INPUT_URL,
        baseParams({ transcriptionEnabled: true, leadSeconds: 45 }),
        ctx,
      )) as { transcript: { text: string; leadSeconds: number } | null };

      expect(result.transcript).toEqual({ text: 'happy birthday', leadSeconds: 45 });
      expect(mockBuildVideoTaggingPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'happy birthday',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('degrades to visual-only on a transcription HTTP error that is not a rate limit', async () => {
    mockGetJobCredentials.mockResolvedValue(withTranscription());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('bad request', { status: 400 })) as typeof fetch;

    try {
      const result = (await computeVideoAutoTagging(
        INPUT_URL,
        baseParams({ transcriptionEnabled: true }),
        ctx,
      )) as { transcript: unknown };

      expect(result.transcript).toBeNull();
      expect(mockCallAnthropicVision).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
