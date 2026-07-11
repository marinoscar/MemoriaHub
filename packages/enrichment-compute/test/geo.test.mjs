/**
 * Unit tests for @memoriahub/enrichment-compute/geo.
 *
 * mapNominatimResponse / mapGoogleResponse are shared verbatim by BOTH the
 * server-side providers (apps/api/src/media/geo/{nominatim,google}-geo-location.provider.ts,
 * thin delegates) and the CLI node compute module (apps/cli's geocode node
 * compute) so a node and the server produce byte-identical GeoMappedResult
 * values from the same raw provider JSON. fetchNominatim / fetchGoogleReverse
 * are plain-fetch wrappers; these tests stub `globalThis.fetch` so no real
 * network call is made — never a live request to Nominatim/Google.
 *
 * The Nominatim fixture below mirrors an actual `/reverse` response shape for
 * San José, Costa Rica (the coordinate pair used elsewhere in this repo's geo
 * test-connection default, see GeoSettingsController's testProvider).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOMINATIM_SAN_JOSE_CR = {
  place_id: 123456789,
  licence: 'Data © OpenStreetMap contributors, ODbL 1.0',
  osm_type: 'way',
  osm_id: 987654321,
  lat: '9.9325427',
  lon: '-84.0795782',
  display_name: 'San José, Provincia de San José, Costa Rica',
  address: {
    city: 'San José',
    county: 'San José',
    state: 'Provincia de San José',
    'ISO3166-2-lvl4': 'CR-SJ',
    country: 'Costa Rica',
    country_code: 'cr',
  },
  boundingbox: ['9.90', '9.96', '-84.11', '-84.04'],
};

const GOOGLE_SAN_JOSE_CR = {
  status: 'OK',
  results: [
    {
      formatted_address: 'San José, San José Province, Costa Rica',
      address_components: [
        { long_name: 'San José', short_name: 'San José', types: ['locality', 'political'] },
        {
          long_name: 'San José Province',
          short_name: 'San José',
          types: ['administrative_area_level_1', 'political'],
        },
        {
          long_name: 'San José',
          short_name: 'San José',
          types: ['administrative_area_level_2', 'political'],
        },
        { long_name: 'Costa Rica', short_name: 'CR', types: ['country', 'political'] },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// mapNominatimResponse
// ---------------------------------------------------------------------------

test('mapNominatimResponse maps a real-shaped San José, Costa Rica response', async () => {
  const { mapNominatimResponse } = await import('@memoriahub/enrichment-compute/geo');

  const mapped = mapNominatimResponse(NOMINATIM_SAN_JOSE_CR);

  assert.deepEqual(mapped, {
    country: 'Costa Rica',
    countryCode: 'CR',
    admin1: 'Provincia de San José',
    admin2: 'San José',
    locality: 'San José',
    placeName: 'San José, Provincia de San José, Costa Rica',
  });
});

test('mapNominatimResponse returns null when there is no address block', async () => {
  const { mapNominatimResponse } = await import('@memoriahub/enrichment-compute/geo');

  assert.equal(mapNominatimResponse({ display_name: 'somewhere' }), null);
  assert.equal(mapNominatimResponse(null), null);
  assert.equal(mapNominatimResponse(undefined), null);
});

test('mapNominatimResponse falls back through the locality chain: city > town > village > neighbourhood > suburb', async () => {
  const { mapNominatimResponse } = await import('@memoriahub/enrichment-compute/geo');

  assert.equal(
    mapNominatimResponse({ address: { town: 'Fortuna' } }).locality,
    'Fortuna',
  );
  assert.equal(
    mapNominatimResponse({ address: { village: 'Small Village' } }).locality,
    'Small Village',
  );
  assert.equal(
    mapNominatimResponse({ address: { neighbourhood: 'A Neighbourhood' } }).locality,
    'A Neighbourhood',
  );
  assert.equal(
    mapNominatimResponse({ address: { suburb: 'A Suburb' } }).locality,
    'A Suburb',
  );
  // city wins over every other tier when multiple are present
  assert.equal(
    mapNominatimResponse({ address: { city: 'City Wins', town: 'Town Loses' } }).locality,
    'City Wins',
  );
});

test('mapNominatimResponse uppercases the country_code', async () => {
  const { mapNominatimResponse } = await import('@memoriahub/enrichment-compute/geo');

  const mapped = mapNominatimResponse({ address: { country_code: 'cr' } });
  assert.equal(mapped.countryCode, 'CR');
});

// ---------------------------------------------------------------------------
// mapGoogleResponse
// ---------------------------------------------------------------------------

test('mapGoogleResponse maps a real-shaped San José, Costa Rica response', async () => {
  const { mapGoogleResponse } = await import('@memoriahub/enrichment-compute/geo');

  const mapped = mapGoogleResponse(GOOGLE_SAN_JOSE_CR);

  assert.deepEqual(mapped, {
    country: 'Costa Rica',
    countryCode: 'CR',
    admin1: 'San José Province',
    admin2: 'San José',
    locality: 'San José',
    placeName: 'San José, San José Province, Costa Rica',
  });
});

test('mapGoogleResponse returns null for non-OK status', async () => {
  const { mapGoogleResponse } = await import('@memoriahub/enrichment-compute/geo');

  assert.equal(mapGoogleResponse({ status: 'ZERO_RESULTS', results: [] }), null);
  assert.equal(mapGoogleResponse({ status: 'OVER_QUERY_LIMIT', results: [] }), null);
  assert.equal(mapGoogleResponse(null), null);
});

test('mapGoogleResponse returns null when status is OK but results is empty', async () => {
  const { mapGoogleResponse } = await import('@memoriahub/enrichment-compute/geo');

  assert.equal(mapGoogleResponse({ status: 'OK', results: [] }), null);
});

test('mapGoogleResponse falls back to postal_town when locality is absent', async () => {
  const { mapGoogleResponse } = await import('@memoriahub/enrichment-compute/geo');

  const mapped = mapGoogleResponse({
    status: 'OK',
    results: [
      {
        formatted_address: 'Some Town, UK',
        address_components: [
          { long_name: 'Some Town', short_name: 'Some Town', types: ['postal_town'] },
          { long_name: 'United Kingdom', short_name: 'GB', types: ['country'] },
        ],
      },
    ],
  });

  assert.equal(mapped.locality, 'Some Town');
});

// ---------------------------------------------------------------------------
// fetchNominatim
// ---------------------------------------------------------------------------

function stubFetchOnce(handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test('fetchNominatim builds the expected /reverse URL and User-Agent header', async () => {
  const { fetchNominatim } = await import('@memoriahub/enrichment-compute/geo');

  let capturedUrl;
  let capturedHeaders;
  const restore = stubFetchOnce(async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init?.headers;
    return new Response(JSON.stringify(NOMINATIM_SAN_JOSE_CR), { status: 200 });
  });

  try {
    const result = await fetchNominatim('https://nominatim.openstreetmap.org', 9.9325427, -84.0795782);

    assert.equal(
      capturedUrl,
      'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=9.9325427&lon=-84.0795782&zoom=14&addressdetails=1',
    );
    assert.match(capturedHeaders['User-Agent'], /MemoriaHub-Node/);
    assert.deepEqual(result, NOMINATIM_SAN_JOSE_CR);
  } finally {
    restore();
  }
});

test('fetchNominatim throws GeoProviderRateLimitError on HTTP 429', async () => {
  const { fetchNominatim, GeoProviderRateLimitError } = await import('@memoriahub/enrichment-compute/geo');

  const restore = stubFetchOnce(async () => new Response('rate limited', { status: 429 }));

  try {
    await assert.rejects(
      () => fetchNominatim('https://nominatim.openstreetmap.org', 0, 0),
      (err) => {
        assert.ok(err instanceof GeoProviderRateLimitError);
        assert.equal(err.provider, 'nominatim');
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('fetchNominatim throws GeoProviderRateLimitError on HTTP 5xx', async () => {
  const { fetchNominatim, GeoProviderRateLimitError } = await import('@memoriahub/enrichment-compute/geo');

  const restore = stubFetchOnce(async () => new Response('boom', { status: 503 }));

  try {
    await assert.rejects(
      () => fetchNominatim('https://nominatim.openstreetmap.org', 0, 0),
      GeoProviderRateLimitError,
    );
  } finally {
    restore();
  }
});

test('fetchNominatim throws a plain Error on other non-OK statuses', async () => {
  const { fetchNominatim, GeoProviderRateLimitError } = await import('@memoriahub/enrichment-compute/geo');

  const restore = stubFetchOnce(async () => new Response('not found', { status: 404 }));

  try {
    await assert.rejects(
      () => fetchNominatim('https://nominatim.openstreetmap.org', 0, 0),
      (err) => {
        assert.equal(err instanceof GeoProviderRateLimitError, false);
        assert.match(err.message, /404/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('fetchNominatim populates retryAfterMs from the Retry-After header on HTTP 429', async () => {
  const { fetchNominatim } = await import('@memoriahub/enrichment-compute/geo');

  const restore = stubFetchOnce(
    async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }),
  );

  try {
    await assert.rejects(
      () => fetchNominatim('https://nominatim.openstreetmap.org', 0, 0),
      (err) => {
        assert.equal(err.retryAfterMs, 30_000);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('GeoProviderRateLimitError is an instance of the shared ProviderRateLimitError', async () => {
  const { GeoProviderRateLimitError } = await import('@memoriahub/enrichment-compute/geo');
  const { ProviderRateLimitError } = await import('@memoriahub/enrichment-compute/rate-limit');

  const err = new GeoProviderRateLimitError('throttled', 'nominatim', 5000);
  assert.ok(err instanceof ProviderRateLimitError);
  assert.ok(err instanceof GeoProviderRateLimitError);
  assert.equal(err.provider, 'nominatim');
  assert.equal(err.retryAfterMs, 5000);
});

// ---------------------------------------------------------------------------
// fetchGoogleReverse
// ---------------------------------------------------------------------------

test('fetchGoogleReverse builds the expected URL with latlng and key', async () => {
  const { fetchGoogleReverse } = await import('@memoriahub/enrichment-compute/geo');

  let capturedUrl;
  const restore = stubFetchOnce(async (url) => {
    capturedUrl = url;
    return new Response(JSON.stringify(GOOGLE_SAN_JOSE_CR), { status: 200 });
  });

  try {
    const result = await fetchGoogleReverse('test-api-key', 9.9325427, -84.0795782);

    assert.equal(
      capturedUrl,
      'https://maps.googleapis.com/maps/api/geocode/json?latlng=9.9325427,-84.0795782&key=test-api-key',
    );
    assert.deepEqual(result, GOOGLE_SAN_JOSE_CR);
  } finally {
    restore();
  }
});

test('fetchGoogleReverse throws GeoProviderRateLimitError on HTTP 429/5xx', async () => {
  const { fetchGoogleReverse, GeoProviderRateLimitError } = await import('@memoriahub/enrichment-compute/geo');

  const restore = stubFetchOnce(async () => new Response('rate limited', { status: 429 }));

  try {
    await assert.rejects(
      () => fetchGoogleReverse('key', 0, 0),
      (err) => {
        assert.ok(err instanceof GeoProviderRateLimitError);
        assert.equal(err.provider, 'google');
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('fetchGoogleReverse throws GeoProviderRateLimitError on OVER_QUERY_LIMIT / RESOURCE_EXHAUSTED status', async () => {
  const { fetchGoogleReverse, GeoProviderRateLimitError } = await import('@memoriahub/enrichment-compute/geo');

  for (const status of ['OVER_QUERY_LIMIT', 'RESOURCE_EXHAUSTED']) {
    const restore = stubFetchOnce(
      async () => new Response(JSON.stringify({ status, results: [] }), { status: 200 }),
    );
    try {
      await assert.rejects(() => fetchGoogleReverse('key', 0, 0), GeoProviderRateLimitError);
    } finally {
      restore();
    }
  }
});

test('fetchGoogleReverse populates retryAfterMs from the Retry-After header on HTTP 429', async () => {
  const { fetchGoogleReverse } = await import('@memoriahub/enrichment-compute/geo');

  const restore = stubFetchOnce(
    async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '15' } }),
  );

  try {
    await assert.rejects(
      () => fetchGoogleReverse('key', 0, 0),
      (err) => {
        assert.equal(err.retryAfterMs, 15_000);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('fetchGoogleReverse has no retryAfterMs for OVER_QUERY_LIMIT (no header to read)', async () => {
  const { fetchGoogleReverse } = await import('@memoriahub/enrichment-compute/geo');

  const restore = stubFetchOnce(
    async () => new Response(JSON.stringify({ status: 'OVER_QUERY_LIMIT', results: [] }), { status: 200 }),
  );

  try {
    await assert.rejects(
      () => fetchGoogleReverse('key', 0, 0),
      (err) => {
        assert.equal(err.retryAfterMs, undefined);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('fetchGoogleReverse returns the raw JSON for a normal OK response', async () => {
  const { fetchGoogleReverse } = await import('@memoriahub/enrichment-compute/geo');

  const restore = stubFetchOnce(async () => new Response(JSON.stringify(GOOGLE_SAN_JOSE_CR), { status: 200 }));

  try {
    const result = await fetchGoogleReverse('key', 9.9325427, -84.0795782);
    assert.deepEqual(result, GOOGLE_SAN_JOSE_CR);
  } finally {
    restore();
  }
});
