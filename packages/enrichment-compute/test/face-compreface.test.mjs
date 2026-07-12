/**
 * Unit tests for @memoriahub/enrichment-compute/face-compreface.
 *
 * detectComprefaceFaces / testComprefaceStatus are extracted VERBATIM from
 * apps/api/src/face/providers/compreface.provider.ts so the server's
 * ComprefaceProvider AND a worker node opting into CompreFace as its
 * face-detection provider send byte-identical HTTP requests and parse
 * responses identically. These tests stub `globalThis.fetch` — no real
 * network call is made.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubFetchOnce(handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function makeDetectResponse(faces) {
  return {
    result: faces.map((f) => ({
      box: {
        x_min: f.x_min,
        y_min: f.y_min,
        x_max: f.x_max,
        y_max: f.y_max,
        probability: f.probability,
      },
      ...(f.embedding !== undefined && { embedding: f.embedding }),
    })),
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('COMPREFACE_MODEL_VERSION / COMPREFACE_PROVIDER_KEY match the server provider', async () => {
  const { COMPREFACE_MODEL_VERSION, COMPREFACE_PROVIDER_KEY } = await import(
    '@memoriahub/enrichment-compute/face-compreface'
  );
  assert.equal(COMPREFACE_MODEL_VERSION, 'compreface-arcface-mobilefacenet-128');
  assert.equal(COMPREFACE_PROVIDER_KEY, 'compreface');
});

// ---------------------------------------------------------------------------
// detectComprefaceFaces
// ---------------------------------------------------------------------------

test('detectComprefaceFaces POSTs to {baseUrl}/find_faces with expected query params', async () => {
  const { detectComprefaceFaces } = await import('@memoriahub/enrichment-compute/face-compreface');

  let capturedUrl;
  let capturedInit;
  const restore = stubFetchOnce(async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(JSON.stringify(makeDetectResponse([])), { status: 200 });
  });

  try {
    await detectComprefaceFaces('http://compreface-core:3000', Buffer.from('fake-image'));
    assert.match(capturedUrl, /\/find_faces/);
    assert.match(capturedUrl, /face_plugins=calculator/);
    assert.match(capturedUrl, /det_prob_threshold=0\.8/);
    assert.equal(capturedInit.method, 'POST');
    assert.ok(capturedInit.body instanceof FormData);
  } finally {
    restore();
  }
});

test('detectComprefaceFaces does NOT send an x-api-key header', async () => {
  const { detectComprefaceFaces } = await import('@memoriahub/enrichment-compute/face-compreface');

  let capturedInit;
  const restore = stubFetchOnce(async (_url, init) => {
    capturedInit = init;
    return new Response(JSON.stringify(makeDetectResponse([])), { status: 200 });
  });

  try {
    await detectComprefaceFaces('http://compreface-core:3000', Buffer.from('fake-image'));
    const headers = capturedInit?.headers;
    if (headers) {
      assert.equal(
        Object.keys(headers).some((k) => k.toLowerCase() === 'x-api-key'),
        false,
      );
    }
  } finally {
    restore();
  }
});

test('detectComprefaceFaces maps box fields to {x,y,w,h} and confidence from probability', async () => {
  const { detectComprefaceFaces } = await import('@memoriahub/enrichment-compute/face-compreface');

  const restore = stubFetchOnce(async () =>
    new Response(
      JSON.stringify(
        makeDetectResponse([{ x_min: 10, y_min: 20, x_max: 110, y_max: 120, probability: 0.87 }]),
      ),
      { status: 200 },
    ),
  );

  try {
    const results = await detectComprefaceFaces('http://compreface-core:3000', Buffer.from('img'));
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].boundingBox, { x: 10, y: 20, w: 100, h: 100 });
    assert.ok(Math.abs(results[0].confidence - 0.87) < 1e-9);
  } finally {
    restore();
  }
});

test('detectComprefaceFaces L2-normalizes the embedding when present', async () => {
  const { detectComprefaceFaces } = await import('@memoriahub/enrichment-compute/face-compreface');

  const restore = stubFetchOnce(async () =>
    new Response(
      JSON.stringify(
        makeDetectResponse([
          { x_min: 0, y_min: 0, x_max: 10, y_max: 10, probability: 0.9, embedding: [3, 4] },
        ]),
      ),
      { status: 200 },
    ),
  );

  try {
    const results = await detectComprefaceFaces('http://compreface-core:3000', Buffer.from('img'));
    const emb = results[0].embedding;
    assert.ok(Math.abs(emb[0] - 0.6) < 1e-9);
    assert.ok(Math.abs(emb[1] - 0.8) < 1e-9);
  } finally {
    restore();
  }
});

test('detectComprefaceFaces returns [] when result is empty', async () => {
  const { detectComprefaceFaces } = await import('@memoriahub/enrichment-compute/face-compreface');

  const restore = stubFetchOnce(async () => new Response(JSON.stringify({ result: [] }), { status: 200 }));

  try {
    const results = await detectComprefaceFaces('http://compreface-core:3000', Buffer.from('img'));
    assert.deepEqual(results, []);
  } finally {
    restore();
  }
});

test('detectComprefaceFaces returns [] on HTTP 400 "no face" response', async () => {
  const { detectComprefaceFaces } = await import('@memoriahub/enrichment-compute/face-compreface');

  const restore = stubFetchOnce(async () =>
    new Response('{"message":"400 Bad Request: No face is found in the given image"}', { status: 400 }),
  );

  try {
    const results = await detectComprefaceFaces('http://compreface-core:3000', Buffer.from('img'));
    assert.deepEqual(results, []);
  } finally {
    restore();
  }
});

test('detectComprefaceFaces throws on a different HTTP 400 error message', async () => {
  const { detectComprefaceFaces } = await import('@memoriahub/enrichment-compute/face-compreface');

  const restore = stubFetchOnce(async () =>
    new Response('{"message":"Bad image format"}', { status: 400 }),
  );

  try {
    await assert.rejects(() =>
      detectComprefaceFaces('http://compreface-core:3000', Buffer.from('img')),
    );
  } finally {
    restore();
  }
});

test('detectComprefaceFaces throws on HTTP 500', async () => {
  const { detectComprefaceFaces } = await import('@memoriahub/enrichment-compute/face-compreface');

  const restore = stubFetchOnce(async () => new Response('Internal Server Error', { status: 500 }));

  try {
    await assert.rejects(
      () => detectComprefaceFaces('http://compreface-core:3000', Buffer.from('img')),
      /500/,
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// testComprefaceStatus
// ---------------------------------------------------------------------------

test('testComprefaceStatus calls GET {baseUrl}/status', async () => {
  const { testComprefaceStatus } = await import('@memoriahub/enrichment-compute/face-compreface');

  let capturedUrl;
  let capturedInit;
  const restore = stubFetchOnce(async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(JSON.stringify({ status: 'OK' }), { status: 200 });
  });

  try {
    const result = await testComprefaceStatus('http://compreface-core:3000');
    assert.equal(capturedUrl, 'http://compreface-core:3000/status');
    assert.equal(capturedInit.method, 'GET');
    assert.deepEqual(result, { ok: true });
  } finally {
    restore();
  }
});

test('testComprefaceStatus returns ok:false when body.status !== "OK"', async () => {
  const { testComprefaceStatus } = await import('@memoriahub/enrichment-compute/face-compreface');

  const restore = stubFetchOnce(async () => new Response(JSON.stringify({ status: 'LOADING' }), { status: 200 }));

  try {
    const result = await testComprefaceStatus('http://compreface-core:3000');
    assert.equal(result.ok, false);
    assert.match(result.error, /LOADING/);
  } finally {
    restore();
  }
});

test('testComprefaceStatus returns ok:false on non-200 HTTP status', async () => {
  const { testComprefaceStatus } = await import('@memoriahub/enrichment-compute/face-compreface');

  const restore = stubFetchOnce(async () => new Response('', { status: 503 }));

  try {
    const result = await testComprefaceStatus('http://compreface-core:3000');
    assert.equal(result.ok, false);
    assert.match(result.error, /503/);
  } finally {
    restore();
  }
});

test('testComprefaceStatus returns ok:false on a network error (fetch throws)', async () => {
  const { testComprefaceStatus } = await import('@memoriahub/enrichment-compute/face-compreface');

  const restore = stubFetchOnce(async () => {
    throw new Error('ECONNREFUSED');
  });

  try {
    const result = await testComprefaceStatus('http://compreface-core:3000');
    assert.equal(result.ok, false);
    assert.match(result.error, /ECONNREFUSED/);
  } finally {
    restore();
  }
});
