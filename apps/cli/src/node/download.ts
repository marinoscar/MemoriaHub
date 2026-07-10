/**
 * node/download.ts — Streaming file download helper for worker nodes.
 *
 * Downloads a URL's bytes to a local file with constant memory (streamed, never
 * buffered whole). Used both to fetch job input bytes and to fetch model files.
 */

import * as fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/**
 * Download `url` to `destPath`, streaming the response body to disk. Returns the
 * number of bytes written. Throws on a non-OK HTTP status or transport error.
 */
export async function downloadToFile(url: string, destPath: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  // Node's Readable.fromWeb accepts a web ReadableStream; cast past the DOM/Node
  // type mismatch (fetch body is a web stream at runtime).
  const nodeStream = Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  const out = fs.createWriteStream(destPath);
  await pipeline(nodeStream, out);
  return fs.statSync(destPath).size;
}
