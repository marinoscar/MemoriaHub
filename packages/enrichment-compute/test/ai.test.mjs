/**
 * Unit tests for @memoriahub/enrichment-compute/ai — callAnthropicVision.
 *
 * PARITY RATIONALE: this is the SAME primitive both the server (via
 * AutoTaggingService.computeAutoTagging -> AnthropicProvider.analyzeImage)
 * and a distributed worker node (with a transiently-fetched API key from
 * POST /api/nodes/:id/jobs/:jobId/credentials) call. These tests assert the
 * exact request shape sent to Anthropic so a node and the server are
 * guaranteed to send byte-identical requests.
 *
 * No live network call is made: the Anthropic SDK falls back to the global
 * `fetch` when no custom fetch is configured (see @anthropic-ai/sdk's
 * client.d.ts), so these tests stub `globalThis.fetch` to capture the
 * outgoing request and return a canned response — never a real API call.
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

function makeAnthropicMessageResponse(textBlocks) {
  return {
    id: 'msg_test_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-20241022',
    content: textBlocks.map((text) => ({ type: 'text', text })),
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 123, output_tokens: 45 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('callAnthropicVision sends the exact request shape (model, system, image+text content blocks)', async () => {
  const { callAnthropicVision } = await import('@memoriahub/enrichment-compute/ai');

  const { captured, restore } = stubFetchOnce(makeAnthropicMessageResponse(['Hello from the model']));

  try {
    const result = await callAnthropicVision(
      { apiKey: 'sk-test-key' },
      {
        model: 'claude-3-5-sonnet-20241022',
        system: 'You are an image analysis assistant.',
        prompt: 'Describe this image.',
        imageBase64: 'ZmFrZS1pbWFnZS1ieXRlcw==',
        mimeType: 'image/jpeg',
      },
    );

    assert.equal(result, 'Hello from the model');

    assert.ok(captured.url.includes('/v1/messages'), `expected /v1/messages in URL, got ${captured.url}`);
    assert.equal(captured.body.model, 'claude-3-5-sonnet-20241022');
    assert.equal(captured.body.max_tokens, 1024);
    assert.equal(captured.body.system, 'You are an image analysis assistant.');

    assert.equal(captured.body.messages.length, 1);
    const [message] = captured.body.messages;
    assert.equal(message.role, 'user');
    assert.equal(message.content.length, 2);

    const [imageBlock, textBlock] = message.content;
    assert.equal(imageBlock.type, 'image');
    assert.equal(imageBlock.source.type, 'base64');
    assert.equal(imageBlock.source.media_type, 'image/jpeg');
    assert.equal(imageBlock.source.data, 'ZmFrZS1pbWFnZS1ieXRlcw==');

    assert.equal(textBlock.type, 'text');
    assert.equal(textBlock.text, 'Describe this image.');
  } finally {
    restore();
  }
});

test('callAnthropicVision omits the `system` field entirely when not provided', async () => {
  const { callAnthropicVision } = await import('@memoriahub/enrichment-compute/ai');

  const { captured, restore } = stubFetchOnce(makeAnthropicMessageResponse(['ok']));

  try {
    await callAnthropicVision(
      { apiKey: 'sk-test-key' },
      {
        model: 'claude-3-5-sonnet-20241022',
        prompt: 'Describe this image.',
        imageBase64: 'ZmFrZQ==',
        mimeType: 'image/png',
      },
    );

    assert.equal('system' in captured.body, false, 'system key should be absent when not provided');
    assert.equal(captured.body.messages[0].content[0].source.media_type, 'image/png');
  } finally {
    restore();
  }
});

test('callAnthropicVision joins multiple text content blocks in the response', async () => {
  const { callAnthropicVision } = await import('@memoriahub/enrichment-compute/ai');

  const { restore } = stubFetchOnce(makeAnthropicMessageResponse(['Part one. ', 'Part two.']));

  try {
    const result = await callAnthropicVision(
      { apiKey: 'sk-test-key' },
      {
        model: 'claude-3-5-sonnet-20241022',
        prompt: 'p',
        imageBase64: 'ZmFrZQ==',
        mimeType: 'image/jpeg',
      },
    );

    assert.equal(result, 'Part one. Part two.');
  } finally {
    restore();
  }
});

test('callAnthropicVision routes requests through creds.baseUrl when provided', async () => {
  const { callAnthropicVision } = await import('@memoriahub/enrichment-compute/ai');

  const { captured, restore } = stubFetchOnce(makeAnthropicMessageResponse(['ok']));

  try {
    await callAnthropicVision(
      { apiKey: 'sk-test-key', baseUrl: 'https://custom-anthropic-proxy.example.com' },
      {
        model: 'claude-3-5-sonnet-20241022',
        prompt: 'p',
        imageBase64: 'ZmFrZQ==',
        mimeType: 'image/jpeg',
      },
    );

    assert.ok(
      captured.url.startsWith('https://custom-anthropic-proxy.example.com'),
      `expected custom base URL to be used, got ${captured.url}`,
    );
  } finally {
    restore();
  }
});
