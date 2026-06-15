import { isEligibleOpenAiModel } from './openai.provider';

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
