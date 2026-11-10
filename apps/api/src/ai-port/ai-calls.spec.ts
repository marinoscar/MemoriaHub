import { AiError } from '@marinoscar/platform-api/ai';
import { RateLimitError } from '@marinoscar/platform-api/jobs';

import { aiRateLimit, assertEmbeddingDimensions, asJobError, systemScope, visionCallOptions } from './ai-calls';

describe('ai-calls', () => {
  describe('systemScope', () => {
    it('is a single-organization system scope naming the feature and the job', () => {
      expect(systemScope('media_tagging', 'job-1')).toEqual({ orgId: null, feature: 'media_tagging', jobId: 'job-1' });
      expect(systemScope('memory_titles')).toEqual({ orgId: null, feature: 'memory_titles' });
    });
  });

  describe('rate limits reach the queue as the platform RateLimitError', () => {
    it('AI_RATE_LIMITED -> RateLimitError carrying the provider back-off', () => {
      const err = new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 12_000 });

      const out = asJobError(err);

      expect(out).toBeInstanceOf(RateLimitError);
      expect((out as RateLimitError).retryAfterMs).toBe(12_000);
      expect(aiRateLimit(err)).toBeInstanceOf(RateLimitError);
    });

    it('any other error passes through untouched', () => {
      const keyErr = new AiError('AI_KEY_REQUIRED', 'no key');
      const plain = new Error('boom');

      expect(asJobError(keyErr)).toBe(keyErr);
      expect(asJobError(plain)).toBe(plain);
      expect(aiRateLimit(keyErr)).toBeNull();
      expect(aiRateLimit(plain)).toBeNull();
    });
  });

  describe('visionCallOptions', () => {
    it('uses the per-provider output budgets of the old provider adapters', () => {
      expect(visionCallOptions('anthropic', 'claude-sonnet-4-6').maxOutputTokens).toBe(1024);
      expect(visionCallOptions('openai', 'gpt-4o').maxOutputTokens).toBe(4096);
    });

    it('lets a caller (video tagging) set the budget', () => {
      expect(visionCallOptions('openai', 'gpt-4o', 8192).maxOutputTokens).toBe(8192);
    });

    it('never sends reasoning to Anthropic', () => {
      expect(visionCallOptions('anthropic', 'claude-sonnet-4-6').reasoning).toBeUndefined();
    });
  });

  describe('assertEmbeddingDimensions', () => {
    it('accepts the 1536-d vectors media_item_embedding holds', () => {
      expect(() => assertEmbeddingDimensions(new Array(1536).fill(0), 'text-embedding-3-small')).not.toThrow();
    });

    it('refuses any other size with a plain message', () => {
      expect(() => assertEmbeddingDimensions(new Array(3072).fill(0), 'text-embedding-3-large')).toThrow(
        /3072-d vectors but storage expects 1536-d/,
      );
    });
  });
});
