/**
 * test/node/logger.spec.ts
 *
 * Unit tests for node/logger.ts — JSONL writing, secret redaction, size-based
 * rotation, and the readLastLines tail helper. All I/O happens in a temp dir
 * passed via the logger's `dir` option, so no real ~/.memoriahub is touched.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createNodeLogger,
  readLastLines,
  redactSensitive,
  NODE_LOG_FILENAME,
} from '../../src/node/logger.js';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mh-node-logger-'));
}

function readLog(dir: string, suffix = ''): string[] {
  const p = path.join(dir, NODE_LOG_FILENAME + suffix);
  return fs
    .readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

describe('redactSensitive', () => {
  it('redacts pat, token, apiKey, secret, credential, and password fields recursively', () => {
    const scrubbed = redactSensitive({
      pat: 'mhp_supersecret',
      accessToken: 'tok',
      nested: { apiKey: 'k', api_key: 'k2', deeper: { clientSecret: 's', credential: 'c' } },
      password: 'pw',
      list: [{ token: 't' }],
    }) as Record<string, any>;

    expect(scrubbed['pat']).toBe('[REDACTED]');
    expect(scrubbed['accessToken']).toBe('[REDACTED]');
    expect(scrubbed['nested'].apiKey).toBe('[REDACTED]');
    expect(scrubbed['nested'].api_key).toBe('[REDACTED]');
    expect(scrubbed['nested'].deeper.clientSecret).toBe('[REDACTED]');
    expect(scrubbed['nested'].deeper.credential).toBe('[REDACTED]');
    expect(scrubbed['password']).toBe('[REDACTED]');
    expect(scrubbed['list'][0].token).toBe('[REDACTED]');
  });

  it('does NOT redact benign fields whose names merely contain "pat" as a substring', () => {
    const scrubbed = redactSensitive({
      path: '/a/b/c',
      pattern: 'x*',
      dispatch: 'yes',
      jobId: 'j1',
    }) as Record<string, unknown>;

    expect(scrubbed['path']).toBe('/a/b/c');
    expect(scrubbed['pattern']).toBe('x*');
    expect(scrubbed['dispatch']).toBe('yes');
    expect(scrubbed['jobId']).toBe('j1');
  });

  it('survives circular references without throwing', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj['self'] = obj;
    const scrubbed = redactSensitive(obj) as Record<string, unknown>;
    expect(scrubbed['a']).toBe(1);
    expect(scrubbed['self']).toBe('[Circular]');
  });
});

describe('createNodeLogger', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes one JSON object per line with ts and level', () => {
    const logger = createNodeLogger({ dir });
    logger.info('hello', { jobId: 'j1' });
    logger.log('error', { ev: 'job:error', jobId: 'j2', error: 'boom' });

    const lines = readLog(dir).map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'hello', jobId: 'j1' });
    expect(typeof lines[0].ts).toBe('string');
    expect(lines[1]).toMatchObject({ level: 'error', ev: 'job:error', error: 'boom' });
  });

  it('redacts sensitive fields before they reach disk', () => {
    const logger = createNodeLogger({ dir });
    logger.info('claim', { pat: 'mhp_secret', inputUrl: 'https://x/y', nested: { token: 't' } });

    const raw = fs.readFileSync(path.join(dir, NODE_LOG_FILENAME), 'utf-8');
    expect(raw).not.toContain('mhp_secret');
    const line = JSON.parse(readLog(dir)[0]);
    expect(line.pat).toBe('[REDACTED]');
    expect(line.nested.token).toBe('[REDACTED]');
    expect(line.inputUrl).toBe('https://x/y');
  });

  it('rotates node.log to node.log.1 when maxBytes is exceeded', () => {
    const logger = createNodeLogger({ dir, maxBytes: 1024 });
    // ~100 bytes per line → comfortably crosses 1024 after ~15 writes.
    for (let i = 0; i < 30; i++) {
      logger.info(`line-${i}`, { filler: 'x'.repeat(60) });
    }

    const rotated = path.join(dir, NODE_LOG_FILENAME + '.1');
    expect(fs.existsSync(rotated)).toBe(true);
    // Both generations parse as JSONL and together hold all 30 lines.
    const all = [...readLog(dir, '.1'), ...readLog(dir)].map((l) => JSON.parse(l));
    // A single rollover generation means the oldest lines may be gone after
    // two rotations, but everything still on disk must be intact JSON.
    expect(all.length).toBeGreaterThan(0);
    for (const entry of all) expect(typeof entry.ts).toBe('string');
    // The active file was restarted, so it is smaller than the cap.
    expect(fs.statSync(path.join(dir, NODE_LOG_FILENAME)).size).toBeLessThanOrEqual(1024);
  });

  it('readLastLines spans the rotated generation and preserves order', () => {
    const logger = createNodeLogger({ dir, maxBytes: 512 });
    for (let i = 0; i < 12; i++) {
      logger.info(`entry-${i}`, { filler: 'y'.repeat(40) });
    }
    const last = readLastLines(6, dir).map((l) => JSON.parse(l).msg as string);
    expect(last).toHaveLength(6);
    // Newest line last, contiguous run of the most recent entries.
    expect(last[last.length - 1]).toBe('entry-11');
    const indices = last.map((m) => parseInt(m.split('-')[1]!, 10));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBe(indices[i - 1]! + 1);
    }
  });
});
