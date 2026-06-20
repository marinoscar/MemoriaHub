import OpenAI from 'openai';
import { isEligibleOpenAiModel, OpenAiProvider } from './openai.provider';

// ---------------------------------------------------------------------------
// Mock the OpenAI SDK so no real HTTP calls are made
// ---------------------------------------------------------------------------
jest.mock('openai');

const mockCreate = jest.fn();
const MockOpenAI = OpenAI as jest.MockedClass<typeof OpenAI>;

beforeEach(() => {
  mockCreate.mockReset();
  MockOpenAI.mockImplementation(
    () =>
      ({
        chat: {
          completions: {
            create: mockCreate,
          },
        },
      }) as unknown as OpenAI,
  );
});

// ---------------------------------------------------------------------------
// isEligibleOpenAiModel — model filter
// ---------------------------------------------------------------------------
describe('isEligibleOpenAiModel', () => {
  // ---- models that SHOULD be included ----
  it.each([
    // Boundary: 5.4 is now inclusive
    ['gpt-5.4', true],
    ['gpt-5.4-mini', true],
    ['gpt-5.4-nano', true],
    // Above boundary
    ['gpt-5.5', true],
    ['gpt-5.5-turbo', true],
    ['gpt-5.5-mini', true],
    ['gpt-5.5-nano', true],
    ['gpt-6', true],
    ['gpt-7.0', true],
  ])('returns true for %s', (id, expected) => {
    expect(isEligibleOpenAiModel(id)).toBe(expected);
  });

  // ---- models that SHOULD be excluded ----
  it.each([
    // GPT versions below 5.4
    ['gpt-5', false],           // 5.0 — minor defaults to 0, not >= 4
    ['gpt-5-mini', false],      // 5.0 variant — still below floor
    ['gpt-4o', false],
    ['gpt-4o-mini', false],
    ['gpt-3.5-turbo', false],
    // Non-text / non-chat modalities (modality keyword beats version)
    ['text-embedding-3-large', false],
    ['gpt-5.5-audio', false],
    ['gpt-5.5-mini-audio', false],  // audio keyword wins even for mini
    ['gpt-realtime', false],
    ['dall-e-3', false],
  ])('returns false for %s', (id, expected) => {
    expect(isEligibleOpenAiModel(id)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// OpenAiProvider.testModel — must use max_completion_tokens (not max_tokens)
// ---------------------------------------------------------------------------
describe('OpenAiProvider.testModel', () => {
  const provider = new OpenAiProvider();
  const creds = { apiKey: 'sk-test', baseUrl: undefined };

  it('sends reasoning_effort:low and max_completion_tokens:1024 for a healthy model', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'ok' } }],
    });

    const result = await provider.testModel(creds, 'gpt-5.4');

    expect(result).toEqual({ ok: true });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs).toHaveProperty('reasoning_effort', 'low');
    expect(callArgs).toHaveProperty('max_completion_tokens', 1024);
    expect(callArgs).not.toHaveProperty('max_tokens');
  });

  it('returns ok:false with "Invalid API key" on 401', async () => {
    mockCreate.mockRejectedValueOnce({ status: 401, message: 'Unauthorized' });

    const result = await provider.testModel(creds, 'gpt-5.4');

    expect(result).toEqual({ ok: false, error: 'Invalid API key' });
  });

  it('returns ok:false with model-not-found message on 404', async () => {
    mockCreate.mockRejectedValueOnce({ status: 404, message: 'Not found' });

    const result = await provider.testModel(creds, 'gpt-5.4');

    expect(result).toEqual({ ok: false, error: 'Model not found: gpt-5.4' });
  });
});

// ---------------------------------------------------------------------------
// OpenAiProvider.analyzeImage — must use max_completion_tokens (not max_tokens)
// ---------------------------------------------------------------------------
describe('OpenAiProvider.analyzeImage', () => {
  const provider = new OpenAiProvider();
  const creds = { apiKey: 'sk-test', baseUrl: undefined };
  const baseReq = {
    model: 'gpt-5.4',
    prompt: 'Describe this image',
    imageBase64: 'abc123',
    mimeType: 'image/jpeg',
    system: undefined as string | undefined,
  };

  it('sends reasoning_effort:low and max_completion_tokens:4096 (not max_tokens)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'A sunny beach.' } }],
    });

    const result = await provider.analyzeImage(creds, baseReq);

    expect(result).toBe('A sunny beach.');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs).toHaveProperty('reasoning_effort', 'low');
    expect(callArgs).toHaveProperty('max_completion_tokens', 4096);
    expect(callArgs).not.toHaveProperty('max_tokens');
  });

  it('includes system message when provided', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Tagged.' } }],
    });

    await provider.analyzeImage(creds, { ...baseReq, system: 'You are a tagger.' });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[0]).toMatchObject({ role: 'system', content: 'You are a tagger.' });
  });

  it('returns empty string when choices array is empty', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [] });

    const result = await provider.analyzeImage(creds, baseReq);

    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// OpenAiProvider.embedText — returns embedding from first data element
// ---------------------------------------------------------------------------
describe('OpenAiProvider.embedText', () => {
  const provider = new OpenAiProvider();
  const creds = { apiKey: 'sk-test', baseUrl: undefined };
  let mockEmbeddingsCreate: jest.Mock;

  beforeEach(() => {
    mockEmbeddingsCreate = jest.fn();
    MockOpenAI.mockImplementation(
      () =>
        ({
          chat: {
            completions: {
              create: mockCreate,
            },
          },
          embeddings: {
            create: mockEmbeddingsCreate,
          },
        }) as unknown as OpenAI,
    );
  });

  it('returns the embedding vector from data[0].embedding', async () => {
    const expectedVector = [0.1, 0.2, 0.3, 0.4];
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ embedding: expectedVector }],
    });

    const result = await provider.embedText(creds, 'text-embedding-3-small', 'hello world');

    expect(result).toEqual(expectedVector);
    expect(mockEmbeddingsCreate).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: 'hello world',
    });
  });

  it('passes the model and input correctly', async () => {
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ embedding: [0.5, 0.6] }],
    });

    await provider.embedText(creds, 'text-embedding-3-large', 'test input text');

    expect(mockEmbeddingsCreate).toHaveBeenCalledWith({
      model: 'text-embedding-3-large',
      input: 'test input text',
    });
  });

  it('throws "Invalid API key" on 401', async () => {
    mockEmbeddingsCreate.mockRejectedValueOnce({ status: 401, message: 'Unauthorized' });

    await expect(provider.embedText(creds, 'text-embedding-3-small', 'hello')).rejects.toThrow(
      'Invalid API key',
    );
  });

  it('throws "Model not found: <model>" on 404', async () => {
    mockEmbeddingsCreate.mockRejectedValueOnce({ status: 404, message: 'Not found' });

    await expect(
      provider.embedText(creds, 'text-embedding-3-small', 'hello'),
    ).rejects.toThrow('Model not found: text-embedding-3-small');
  });

  it('throws "Model not found: <model>" on model_not_found code', async () => {
    mockEmbeddingsCreate.mockRejectedValueOnce({ code: 'model_not_found', message: 'Model not found' });

    await expect(
      provider.embedText(creds, 'text-embedding-3-small', 'hello'),
    ).rejects.toThrow('Model not found: text-embedding-3-small');
  });

  it('rethrows with the error message on generic failure', async () => {
    mockEmbeddingsCreate.mockRejectedValueOnce({ message: 'Rate limit exceeded' });

    await expect(provider.embedText(creds, 'text-embedding-3-small', 'hello')).rejects.toThrow(
      'Rate limit exceeded',
    );
  });
});

// ---------------------------------------------------------------------------
// OpenAiProvider.listEmbeddingModels — static list
// ---------------------------------------------------------------------------
describe('OpenAiProvider.listEmbeddingModels', () => {
  const provider = new OpenAiProvider();

  it('returns the OPENAI_EMBEDDING_MODELS list', () => {
    const models = provider.listEmbeddingModels();
    expect(models).toEqual(['text-embedding-3-small', 'text-embedding-3-large']);
  });

  it('returns an array (not frozen — spread copy)', () => {
    const models = provider.listEmbeddingModels();
    expect(Array.isArray(models)).toBe(true);
  });
});
