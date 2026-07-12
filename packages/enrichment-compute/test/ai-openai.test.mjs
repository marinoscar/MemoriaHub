/**
 * Unit tests for @memoriahub/enrichment-compute/ai — callOpenAiVision +
 * classifyOpenAiRateLimit.
 *
 * PARITY RATIONALE: this is the SAME primitive both the server (via
 * AutoTaggingService.computeAutoTagging -> OpenAiProvider.analyzeImage) and a
 * distributed worker node (with a transiently-fetched API key from
 * POST /api/nodes/:id/jobs/:jobId/credentials) call. These tests assert the
 * exact request shape sent to OpenAI so a node and the server are guaranteed
 * to send byte-identical requests — mirrors ai.test.mjs's coverage of
 * callAnthropicVision/classifyAnthropicRateLimit for the Anthropic side.
 *
 * No live network call is made: the OpenAI SDK falls back to the global
 * `fetch` when no custom fetch is configured (see openai's
 * internal/shims.js `getDefaultFetch`), so these tests stub `globalThis.fetch`
 * to capture the outgoing request and return a canned response — never a
 * real API call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubFetchOnce(responseBody, { status = 200 } = {}) {
  const originalFetch = globalThis.fetch;
  const captured = {};

  globalThis.fetch = async (url, init) => {
    captured.url = typeof url === 'string' ? url : url.toString();
    captured.headers = init?.headers;
    captured.body = init?.body ? JSON.parse(init.body) : undefined;

    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    captured,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function makeOpenAiChatCompletionResponse(content) {
  return {
    id: 'chatcmpl-test-01',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-5-mini',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
  };
}

// ---------------------------------------------------------------------------
// Tests — callOpenAiVision request shape
// ---------------------------------------------------------------------------

test('callOpenAiVision sends the exact request shape (model, system, image data-URI + text content blocks, reasoning_effort, max_completion_tokens)', async () => {
  const { callOpenAiVision } = await import('@memoriahub/enrichment-compute/ai');

  const { captured, restore } = stubFetchOnce(makeOpenAiChatCompletionResponse('Hello from the model'));

  try {
    const result = await callOpenAiVision(
      { apiKey: 'sk-test-key' },
      {
        model: 'gpt-5-mini',
        system: 'You are an image analysis assistant.',
        prompt: 'Describe this image.',
        imageBase64: 'ZmFrZS1pbWFnZS1ieXRlcw==',
        mimeType: 'image/jpeg',
      },
    );

    assert.equal(result, 'Hello from the model');

    assert.ok(captured.url.includes('/chat/completions'), `expected /chat/completions in URL, got ${captured.url}`);
    assert.equal(captured.body.model, 'gpt-5-mini');
    assert.equal(captured.body.max_completion_tokens, 4096);
    // reasoning_effort defaults to 'low' unless OPENAI_REASONING_EFFORT is set.
    assert.equal(captured.body.reasoning_effort, 'low');

    assert.equal(captured.body.messages.length, 2);
    const [systemMessage, userMessage] = captured.body.messages;
    assert.equal(systemMessage.role, 'system');
    assert.equal(systemMessage.content, 'You are an image analysis assistant.');

    assert.equal(userMessage.role, 'user');
    assert.equal(userMessage.content.length, 2);

    const [textBlock, imageBlock] = userMessage.content;
    assert.equal(textBlock.type, 'text');
    assert.equal(textBlock.text, 'Describe this image.');

    assert.equal(imageBlock.type, 'image_url');
    assert.equal(imageBlock.image_url.url, 'data:image/jpeg;base64,ZmFrZS1pbWFnZS1ieXRlcw==');
  } finally {
    restore();
  }
});

test('callOpenAiVision omits the system message entirely when `system` is not provided', async () => {
  const { callOpenAiVision } = await import('@memoriahub/enrichment-compute/ai');

  const { captured, restore } = stubFetchOnce(makeOpenAiChatCompletionResponse('ok'));

  try {
    await callOpenAiVision(
      { apiKey: 'sk-test-key' },
      {
        model: 'gpt-5-mini',
        prompt: 'Describe this image.',
        imageBase64: 'ZmFrZQ==',
        mimeType: 'image/png',
      },
    );

    assert.equal(captured.body.messages.length, 1, 'no system message should be present');
    assert.equal(captured.body.messages[0].role, 'user');
    assert.equal(captured.body.messages[0].content[1].image_url.url, 'data:image/png;base64,ZmFrZQ==');
  } finally {
    restore();
  }
});

test('callOpenAiVision returns an empty string when the response has no message content', async () => {
  const { callOpenAiVision } = await import('@memoriahub/enrichment-compute/ai');

  const { restore } = stubFetchOnce({
    id: 'chatcmpl-empty',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-5-mini',
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
  });

  try {
    const result = await callOpenAiVision(
      { apiKey: 'sk-test-key' },
      { model: 'gpt-5-mini', prompt: 'p', imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg' },
    );

    assert.equal(result, '');
  } finally {
    restore();
  }
});

test('callOpenAiVision routes requests through creds.baseUrl when provided', async () => {
  const { callOpenAiVision } = await import('@memoriahub/enrichment-compute/ai');

  const { captured, restore } = stubFetchOnce(makeOpenAiChatCompletionResponse('ok'));

  try {
    await callOpenAiVision(
      { apiKey: 'sk-test-key', baseUrl: 'https://custom-openai-proxy.example.com' },
      { model: 'gpt-5-mini', prompt: 'p', imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg' },
    );

    assert.ok(
      captured.url.startsWith('https://custom-openai-proxy.example.com'),
      `expected custom base URL to be used, got ${captured.url}`,
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Rate-limit classification
// ---------------------------------------------------------------------------

test('callOpenAiVision throws ProviderRateLimitError on HTTP 429, with retryAfterMs from the header', async () => {
  const { callOpenAiVision } = await import('@memoriahub/enrichment-compute/ai');
  const { ProviderRateLimitError } = await import('@memoriahub/enrichment-compute/rate-limit');

  const originalFetch = globalThis.fetch;
  // 'x-should-retry: false' stops the SDK's own retry loop so this test makes
  // exactly one fetch call instead of waiting through maxRetries backoffs.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'too many requests' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'x-should-retry': 'false', 'retry-after': '30' },
    });

  try {
    await assert.rejects(
      () =>
        callOpenAiVision(
          { apiKey: 'sk-test-key' },
          { model: 'gpt-5-mini', prompt: 'p', imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg' },
        ),
      (err) => {
        assert.ok(err instanceof ProviderRateLimitError);
        assert.equal(err.provider, 'openai');
        assert.equal(err.retryAfterMs, 30_000);
        assert.match(err.message, /HTTP 429/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('classifyOpenAiRateLimit returns null for a non-429 OpenAI.APIError', async () => {
  const { classifyOpenAiRateLimit } = await import('@memoriahub/enrichment-compute/ai');
  const OpenAI = (await import('openai')).default;

  const err = new OpenAI.APIError(400, { message: 'bad request' }, 'bad request', new Headers());
  assert.equal(classifyOpenAiRateLimit(err), null);
});

test('classifyOpenAiRateLimit returns null for an error that is not an OpenAI.APIError instance', async () => {
  const { classifyOpenAiRateLimit } = await import('@memoriahub/enrichment-compute/ai');

  assert.equal(classifyOpenAiRateLimit(new Error('some unrelated failure')), null);
  assert.equal(classifyOpenAiRateLimit('not even an error'), null);
});

test('callOpenAiVision rethrows non-rate-limit errors unchanged (e.g. HTTP 400)', async () => {
  const { callOpenAiVision } = await import('@memoriahub/enrichment-compute/ai');
  const { ProviderRateLimitError } = await import('@memoriahub/enrichment-compute/rate-limit');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad request' } }), {
      status: 400,
      headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
    });

  try {
    await assert.rejects(
      () =>
        callOpenAiVision(
          { apiKey: 'sk-test-key' },
          { model: 'gpt-5-mini', prompt: 'p', imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg' },
        ),
      (err) => {
        assert.equal(err instanceof ProviderRateLimitError, false);
        assert.match(err.message, /400/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
