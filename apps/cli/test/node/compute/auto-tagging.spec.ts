/**
 * test/node/compute/auto-tagging.spec.ts
 *
 * Unit tests for node/compute/auto-tagging.ts's provider dispatch:
 *   - provider: 'anthropic' calls the shared package's callAnthropicVision
 *     (and NOT callOpenAiVision) with the expected visionCreds/visionReq shape
 *     built from the transient job credentials + the prepared image buffer.
 *   - provider: 'openai' calls callOpenAiVision instead (and NOT
 *     callAnthropicVision) — mirrors the anthropic case exactly.
 *   - any other provider value declines with CapabilityUnavailableError
 *     mentioning the provider name, without calling either vision function.
 *
 * `../../../src/config.js` (loadConfig), `../../../src/api.js` (ApiClient),
 * `@memoriahub/enrichment-compute/image` (prepareImageForProcessing), and
 * `@memoriahub/enrichment-compute/ai` (callAnthropicVision/callOpenAiVision)
 * are mocked via jest.unstable_mockModule (mirrors face-detection.spec.ts's
 * convention) so no real network calls, CLI config file, or heavy
 * dependencies are touched. The input file is a real temp file on disk (the
 * module reads it via `node:fs/promises`'s readFile), containing arbitrary
 * bytes since `prepareImageForProcessing` is mocked and never actually
 * decodes it — same convention face-detection.spec.ts uses for its (sync)
 * file read.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
jest.unstable_mockModule('@memoriahub/enrichment-compute/ai', () => ({
  callAnthropicVision: mockCallAnthropicVision,
  callOpenAiVision: mockCallOpenAiVision,
}));

const { CapabilityUnavailableError } = await import('../../../src/node/capabilities.js');
const { default: computeAutoTagging } = await import('../../../src/node/compute/auto-tagging.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let inputPath: string;

const ctx = { nodeId: 'node-1', jobId: 'job-1' };

function baseCreds(overrides: Record<string, unknown> = {}) {
  return {
    type: 'auto_tagging',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    apiKey: 'sk-test-key',
    baseUrl: undefined,
    system: 'You are a tagger.',
    prompt: 'Tag this image.',
    mimeTypeHint: 'image/jpeg',
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-auto-tagging-compute-'));
  inputPath = path.join(tmpDir, 'input.jpg');
  fs.writeFileSync(inputPath, Buffer.from('fake-image-bytes'));

  mockLoadConfig.mockReset();
  MockApiClient.mockClear();
  mockGetJobCredentials.mockReset();
  mockPrepareImageForProcessing.mockReset();
  mockCallAnthropicVision.mockReset();
  mockCallOpenAiVision.mockReset();

  mockLoadConfig.mockReturnValue({ serverUrl: 'https://api.example.com', pat: 'pat-test-token' });

  // Default: preprocessing "succeeds" with a plausible prepared buffer/dims.
  mockPrepareImageForProcessing.mockResolvedValue({
    buffer: Buffer.from('prepared-bytes'),
    width: 800,
    height: 600,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Anthropic branch
// ---------------------------------------------------------------------------

describe('computeAutoTagging — anthropic provider', () => {
  it('calls callAnthropicVision (not callOpenAiVision) and returns { rawText }', async () => {
    mockGetJobCredentials.mockResolvedValue(baseCreds({ provider: 'anthropic' }));
    mockCallAnthropicVision.mockResolvedValue('A sunny beach with palm trees.');

    const result = await computeAutoTagging(inputPath, {}, ctx);

    expect(result).toEqual({ rawText: 'A sunny beach with palm trees.' });
    expect(mockCallOpenAiVision).not.toHaveBeenCalled();
    expect(mockCallAnthropicVision).toHaveBeenCalledTimes(1);

    const [visionCreds, visionReq] = mockCallAnthropicVision.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(visionCreds).toEqual({ apiKey: 'sk-test-key', baseUrl: undefined });
    expect(visionReq).toEqual({
      model: 'claude-3-5-sonnet-20241022',
      system: 'You are a tagger.',
      prompt: 'Tag this image.',
      imageBase64: Buffer.from('prepared-bytes').toString('base64'),
      mimeType: 'image/jpeg',
    });
  });

  it('fetches job credentials via ApiClient constructed from loadConfig', async () => {
    mockGetJobCredentials.mockResolvedValue(baseCreds({ provider: 'anthropic' }));
    mockCallAnthropicVision.mockResolvedValue('ok');

    await computeAutoTagging(inputPath, {}, ctx);

    expect(MockApiClient).toHaveBeenCalledWith({
      serverUrl: 'https://api.example.com',
      pat: 'pat-test-token',
    });
    expect(mockGetJobCredentials).toHaveBeenCalledWith('node-1', 'job-1');
  });
});

// ---------------------------------------------------------------------------
// OpenAI branch
// ---------------------------------------------------------------------------

describe('computeAutoTagging — openai provider', () => {
  it('calls callOpenAiVision (not callAnthropicVision) and returns { rawText }', async () => {
    mockGetJobCredentials.mockResolvedValue(
      baseCreds({ provider: 'openai', model: 'gpt-5.4-mini', baseUrl: 'https://custom-openai.example.com' }),
    );
    mockCallOpenAiVision.mockResolvedValue('A city skyline at night.');

    const result = await computeAutoTagging(inputPath, {}, ctx);

    expect(result).toEqual({ rawText: 'A city skyline at night.' });
    expect(mockCallAnthropicVision).not.toHaveBeenCalled();
    expect(mockCallOpenAiVision).toHaveBeenCalledTimes(1);

    const [visionCreds, visionReq] = mockCallOpenAiVision.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(visionCreds).toEqual({ apiKey: 'sk-test-key', baseUrl: 'https://custom-openai.example.com' });
    expect(visionReq).toEqual({
      model: 'gpt-5.4-mini',
      system: 'You are a tagger.',
      prompt: 'Tag this image.',
      imageBase64: Buffer.from('prepared-bytes').toString('base64'),
      mimeType: 'image/jpeg',
    });
  });
});

// ---------------------------------------------------------------------------
// Unsupported provider branch
// ---------------------------------------------------------------------------

describe('computeAutoTagging — unsupported provider', () => {
  it('throws CapabilityUnavailableError mentioning the provider name, without calling either vision function', async () => {
    mockGetJobCredentials.mockResolvedValue(baseCreds({ provider: 'some-other-provider' }));

    await expect(computeAutoTagging(inputPath, {}, ctx)).rejects.toThrow(CapabilityUnavailableError);
    await expect(computeAutoTagging(inputPath, {}, ctx)).rejects.toThrow(/some-other-provider/);

    expect(mockCallAnthropicVision).not.toHaveBeenCalled();
    expect(mockCallOpenAiVision).not.toHaveBeenCalled();
  });
});
