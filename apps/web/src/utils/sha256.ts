/**
 * Streaming SHA-256 hasher for File objects.
 *
 * Uses hash-wasm (WebAssembly SHA-256) fed in chunks so that large video
 * files never load fully into memory. The output is a lowercase hex string
 * that matches Node's `crypto.createHash('sha256').update(buffer).digest('hex')`
 * for the same bytes — required because the server compares hex SHA-256.
 *
 * Why hash-wasm and not Web Crypto?
 *   `crypto.subtle.digest` requires the entire ArrayBuffer up-front — it does
 *   not support streaming. hash-wasm exposes an incremental API (`init` /
 *   `update` / `digest`) that lets us feed the file in fixed-size slices.
 *
 * Known-vector sanity check (SHA-256 of empty string):
 *   sha256File(new File([], '...')) → 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
 */

import { createSHA256 } from 'hash-wasm';

/** 8 MB read window — balances memory use against syscall overhead. */
const CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Compute the lowercase hex SHA-256 digest of a File, reading it in
 * CHUNK_SIZE slices so the entire file is never held in memory at once.
 *
 * Throws only if hash-wasm itself fails to initialise; callers should
 * catch and fall back to uploading without a hash.
 */
export async function sha256File(file: File): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();

  let offset = 0;
  while (offset < file.size) {
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    // FileReader/ArrayBuffer — compatible with all modern browsers and jsdom
    const buffer = await slice.arrayBuffer();
    hasher.update(new Uint8Array(buffer));
    offset += CHUNK_SIZE;
  }

  return hasher.digest('hex');
}
