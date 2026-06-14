/**
 * Unit tests for src/utils/sha256.ts
 *
 * Exercises sha256File with real hash-wasm digests (no mocking) across:
 *   - empty file            → known empty-string vector
 *   - small known input     → known "abc" vector
 *   - multi-chunk input     → file > 8 MB forces the while-loop to iterate
 *                             more than once; digest cross-checked against
 *                             the same bytes hashed by Node's crypto module
 *
 * hash-wasm's WebAssembly core loads fine in vitest's Node/jsdom environment.
 * File.prototype.slice and File.prototype.arrayBuffer are available in Node 20+
 * via the global File class (same underlying Blob implementation used in jsdom).
 */

import { describe, it, expect } from 'vitest';
import { sha256File } from '../../utils/sha256';

// ---------------------------------------------------------------------------
// Helper: build a File from raw bytes
// ---------------------------------------------------------------------------

function makeFile(bytes: Uint8Array, name = 'test.bin'): File {
  return new File([bytes], name, { type: 'application/octet-stream' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sha256File', () => {
  it('returns the SHA-256 of the empty string for an empty File', async () => {
    const file = new File([], 'empty.bin');
    const digest = await sha256File(file);
    // Well-known vector: SHA-256('')
    expect(digest).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('returns the correct digest for a small known input ("abc")', async () => {
    const file = makeFile(new TextEncoder().encode('abc'));
    const digest = await sha256File(file);
    // Well-known vector: SHA-256('abc')
    expect(digest).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('returns the correct digest when the file spans multiple 8 MB chunks', async () => {
    // 9 MB of repeating byte 0x42 — forces the while loop to run twice
    // (first iteration: bytes 0–8388607, second: bytes 8388608–9437183).
    // Expected digest pre-computed with Node crypto:
    //   crypto.createHash('sha256').update(Buffer.alloc(9*1024*1024, 0x42)).digest('hex')
    //   → '96b8f4271b735500d9c695feda3c7782ca945d581b177b1a8318567b46dcf50b'
    const SIZE = 9 * 1024 * 1024;
    const bytes = new Uint8Array(SIZE).fill(0x42);
    const file = makeFile(bytes, 'large.bin');

    const digest = await sha256File(file);

    expect(digest).toBe(
      '96b8f4271b735500d9c695feda3c7782ca945d581b177b1a8318567b46dcf50b',
    );
  });

  it('returns a lowercase hex string of exactly 64 characters', async () => {
    const file = makeFile(new TextEncoder().encode('hello world'));
    const digest = await sha256File(file);
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
