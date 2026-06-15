import { isEligibleOpenAiModel } from './openai.provider';

describe('isEligibleOpenAiModel', () => {
  // ---- models that SHOULD be included ----
  it.each([
    ['gpt-5.5', true],
    ['gpt-6', true],
    ['gpt-5.5-turbo', true],
    ['gpt-7.0', true],
  ])('returns true for %s', (id, expected) => {
    expect(isEligibleOpenAiModel(id)).toBe(expected);
  });

  // ---- models that SHOULD be excluded ----
  it.each([
    // GPT versions not strictly greater than 5.4
    ['gpt-5.4', false],
    ['gpt-5', false],       // 5.0 — minor defaults to 0, not > 4
    ['gpt-4o', false],
    ['gpt-3.5-turbo', false],
    // Non-text / non-chat modalities
    ['text-embedding-3-large', false],
    ['gpt-5.5-audio', false],
    ['gpt-realtime', false],
    ['dall-e-3', false],
  ])('returns false for %s', (id, expected) => {
    expect(isEligibleOpenAiModel(id)).toBe(expected);
  });
});
