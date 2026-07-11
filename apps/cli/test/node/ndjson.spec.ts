/**
 * test/node/ndjson.spec.ts
 *
 * Unit tests for node/ndjson.ts — the NDJSON framing parser used on both
 * sides of the daemon IPC socket. Pure function-in/value-out.
 */

import { NdjsonParser, encodeNdjson } from '../../src/node/ndjson.js';

describe('encodeNdjson', () => {
  it('serializes one value per line with a trailing newline', () => {
    expect(encodeNdjson({ cmd: 'status' })).toBe('{"cmd":"status"}\n');
  });
});

describe('NdjsonParser', () => {
  it('parses multiple complete frames from one chunk', () => {
    const parser = new NdjsonParser();
    const results = parser.push('{"a":1}\n{"b":2}\n');
    expect(results).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { b: 2 } },
    ]);
  });

  it('buffers a frame split across arbitrary chunk boundaries', () => {
    const parser = new NdjsonParser();
    expect(parser.push('{"kind":"sta')).toEqual([]);
    expect(parser.push('tus","concurrency":')).toEqual([]);
    const results = parser.push('3}\n');
    expect(results).toEqual([{ ok: true, value: { kind: 'status', concurrency: 3 } }]);
  });

  it('reports malformed lines without throwing and keeps parsing', () => {
    const parser = new NdjsonParser();
    const results = parser.push('not json at all\n{"ok":true}\n');
    expect(results).toHaveLength(2);
    expect(results[0]!.ok).toBe(false);
    if (!results[0]!.ok) {
      expect(results[0]!.line).toBe('not json at all');
      expect(results[0]!.error.length).toBeGreaterThan(0);
    }
    expect(results[1]).toEqual({ ok: true, value: { ok: true } });
  });

  it('tolerates CRLF line endings and skips blank lines', () => {
    const parser = new NdjsonParser();
    const results = parser.push('{"x":1}\r\n\n\r\n{"y":2}\n');
    expect(results).toEqual([
      { ok: true, value: { x: 1 } },
      { ok: true, value: { y: 2 } },
    ]);
  });

  it('accepts Buffer chunks', () => {
    const parser = new NdjsonParser();
    const results = parser.push(Buffer.from('{"buf":true}\n', 'utf-8'));
    expect(results).toEqual([{ ok: true, value: { buf: true } }]);
  });

  it('caps an unbounded newline-free line instead of buffering forever', () => {
    const parser = new NdjsonParser();
    const huge = 'a'.repeat(1_000_001);
    const results = parser.push(huge);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    // Buffer was reset — a subsequent well-formed frame still parses.
    expect(parser.push('{"next":1}\n')).toEqual([{ ok: true, value: { next: 1 } }]);
  });
});
