/**
 * node/ndjson.ts — Newline-delimited JSON framing for the daemon IPC socket.
 *
 * One JSON object per line in both directions. The parser is a pure,
 * stream-safe line buffer: feed it arbitrary chunk boundaries and it yields
 * complete parsed objects, reporting (never throwing on) malformed lines.
 */

export type NdjsonResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; line: string };

/** Refuse to buffer a single line beyond this size (protocol abuse guard). */
const MAX_LINE_BYTES = 1_000_000;

/** Encode one value as an NDJSON frame (JSON + trailing newline). */
export function encodeNdjson(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

/** Incremental NDJSON parser; safe against chunk splits mid-line. */
export class NdjsonParser {
  private buffer = '';

  /** Feed a chunk; returns every complete frame that became available. */
  push(chunk: Buffer | string): NdjsonResult[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    const results: NdjsonResult[] = [];

    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      // Tolerate CRLF clients.
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim() === '') continue;
      try {
        results.push({ ok: true, value: JSON.parse(line) });
      } catch (err) {
        results.push({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          line,
        });
      }
    }

    // A newline-free line growing without bound would balloon memory.
    if (this.buffer.length > MAX_LINE_BYTES) {
      const overlong = this.buffer;
      this.buffer = '';
      results.push({
        ok: false,
        error: `line exceeds ${MAX_LINE_BYTES} bytes without a newline`,
        line: overlong.slice(0, 200),
      });
    }

    return results;
  }
}
