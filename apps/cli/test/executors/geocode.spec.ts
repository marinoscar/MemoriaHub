import { jest } from '@jest/globals';
import { geocodeResultSchema } from '@memoriahub/enrichment-compute/dto';

import { ProviderRateLimitError as ComputeRateLimit } from '@memoriahub/enrichment-compute/rate-limit';
import { makeContext } from './helpers.js';

const fetchGoogleReverse = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const fetchNominatim = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('@memoriahub/enrichment-compute/geo', () => ({
  fetchGoogleReverse,
  fetchNominatim,
  mapGoogleResponse: (raw: { country?: string }) => ({ country: raw.country ?? null, countryCode: 'CR', admin1: 'A', admin2: null, locality: 'L', placeName: 'P' }),
  mapNominatimResponse: () => ({ country: 'N', countryCode: 'NN', admin1: null, admin2: null, locality: null, placeName: null }),
}));

const { geocodeExecutor } = await import('../../src/executors/geocode.executor.js');

describe('geocode executor', () => {
  beforeEach(() => {
    fetchGoogleReverse.mockReset();
    fetchNominatim.mockReset();
  });

  it('is a no-input type', () => {
    expect(geocodeExecutor.type).toBe('geocode');
    expect(geocodeExecutor.input).toBe('none');
  });

  it('asks for the per-job secret with the claim token, and only then calls Google', async () => {
    fetchGoogleReverse.mockResolvedValue({ country: 'Costa Rica' });
    const { context, api } = makeContext({ type: 'geocode', params: { lat: 9.9, lng: -84.1 } });
    const result = await geocodeExecutor.execute(context);
    expect(geocodeResultSchema.parse(result).source).toBe('google');
    expect(api.secretCalls).toEqual([['node-1', 'job-1', 'claim-1']]);
    expect(fetchGoogleReverse).toHaveBeenCalledWith('AIza-test-key-0001', 9.9, -84.1);
  });

  it('never puts the key in the result or in a failure message', async () => {
    fetchGoogleReverse.mockRejectedValue(new Error('boom'));
    const { context } = makeContext({ type: 'geocode', params: { lat: 1, lng: 2 } });
    await expect(geocodeExecutor.execute(context)).rejects.toThrow('boom');
    fetchGoogleReverse.mockResolvedValue({});
    const ok = JSON.stringify(await geocodeExecutor.execute(context));
    expect(ok).not.toContain('AIza');
  });

  it('runs a Nominatim payload without asking for a secret', async () => {
    fetchNominatim.mockResolvedValue({});
    const { context, api } = makeContext({ type: 'geocode', params: { lat: 1, lng: 2, provider: 'nominatim' } });
    const result = await geocodeExecutor.execute(context);
    expect(geocodeResultSchema.parse(result).source).toBe('nominatim');
    expect(api.secretCalls).toEqual([]);
  });

  it('declines a payload with no coordinates, without asking for a secret', async () => {
    const { context, api } = makeContext({ type: 'geocode', params: {} });
    await expect(geocodeExecutor.execute(context)).rejects.toThrow(/no coordinates/);
    expect(api.secretCalls).toEqual([]);
  });

  it('turns a provider throttle into the engine\'s rate-limit error (class name kept, retryAfterMs carried)', async () => {
    fetchGoogleReverse.mockRejectedValue(new ComputeRateLimit('quota', 'google', 12_000));
    const { context } = makeContext({ type: 'geocode', params: { lat: 1, lng: 2 } });
    const error = (await geocodeExecutor.execute(context).catch((e: unknown) => e)) as { name: string; retryAfterMs: number; provider?: string };
    expect(error.retryAfterMs).toBe(12_000);
    expect(error.provider).toBe('google');
    // the platform's class, not the compute package's
    expect(error instanceof ComputeRateLimit).toBe(false);
  });
});
