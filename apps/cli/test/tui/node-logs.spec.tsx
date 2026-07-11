/**
 * test/tui/node-logs.spec.tsx
 *
 * Tests for NodeLogs.tsx:
 *   - parseLogLine: pure JSONL-line → renderable-row parsing (no Ink needed).
 *   - Component-level smoke tests using a real temp log directory (via the
 *     `dir` prop) with the actual node/logger.ts read/follow helpers, so we
 *     exercise the same code path the real screen uses — no daemon/network
 *     required.
 *
 * Note on async rendering: Ink re-renders asynchronously in response to
 * setState calls (including the mount-time useEffect that starts followLog
 * and the fs.watch-driven append). We wait a tick with a short setTimeout so
 * React/Ink can flush state updates before asserting, matching the pattern
 * used throughout test/tui/*.spec.tsx.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

import {
  NodeLogs,
  parseLogLine,
  DEFAULT_TAIL_SIZE,
  MIN_TAIL_SIZE,
  MAX_TAIL_SIZE,
} from '../../src/tui/NodeLogs.js';
import { NODE_LOG_FILENAME } from '../../src/node/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function flushAsync(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mh-node-logs-tui-'));
}

function writeLine(dir: string, obj: Record<string, unknown>): void {
  fs.appendFileSync(path.join(dir, NODE_LOG_FILENAME), JSON.stringify(obj) + '\n');
}

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// parseLogLine (pure)
// ---------------------------------------------------------------------------

describe('parseLogLine', () => {
  it('renders a plain info message with a formatted time', () => {
    const parsed = parseLogLine(JSON.stringify({ ts: '2026-07-10T12:00:00.000Z', level: 'info', msg: 'hello' }));
    expect(parsed.level).toBe('info');
    expect(parsed.text).toBe('hello');
    expect(parsed.time).not.toBeNull();
    expect(parsed.malformed).toBe(false);
  });

  it('defaults to level info when the field is missing or unrecognized', () => {
    expect(parseLogLine(JSON.stringify({ msg: 'no level' })).level).toBe('info');
    expect(parseLogLine(JSON.stringify({ level: 'bogus', msg: 'x' })).level).toBe('info');
  });

  it('passes through error, warn, and debug levels', () => {
    expect(parseLogLine(JSON.stringify({ level: 'error', msg: 'boom' })).level).toBe('error');
    expect(parseLogLine(JSON.stringify({ level: 'warn', msg: 'careful' })).level).toBe('warn');
    expect(parseLogLine(JSON.stringify({ level: 'debug', msg: 'trace' })).level).toBe('debug');
  });

  it('renders an event name in brackets when both ev and msg are present', () => {
    const parsed = parseLogLine(JSON.stringify({ ev: 'job.start', msg: 'starting job', level: 'info' }));
    expect(parsed.text).toBe('[job.start] starting job');
  });

  it('falls back to the event name alone when msg is absent', () => {
    const parsed = parseLogLine(JSON.stringify({ ev: 'heartbeat.ok', level: 'info' }));
    expect(parsed.text).toBe('heartbeat.ok');
  });

  it('appends extra payload fields as key=value pairs', () => {
    const parsed = parseLogLine(
      JSON.stringify({ ev: 'job.start', jobId: 'abc123', type: 'face_detection', level: 'info' }),
    );
    expect(parsed.text).toContain('job.start');
    expect(parsed.text).toContain('jobId=abc123');
    expect(parsed.text).toContain('type=face_detection');
  });

  it('renders "(no message)" when there is neither msg nor ev', () => {
    const parsed = parseLogLine(JSON.stringify({ level: 'info', foo: 'bar' }));
    expect(parsed.text).toContain('(no message)');
    expect(parsed.text).toContain('foo=bar');
  });

  it('serializes object-valued extra fields as compact JSON', () => {
    const parsed = parseLogLine(JSON.stringify({ msg: 'payload', nested: { a: 1, b: 'two' } }));
    expect(parsed.text).toContain('nested={"a":1,"b":"two"}');
  });

  it('falls back to raw text and malformed:true for invalid JSON', () => {
    const parsed = parseLogLine('not json at all {');
    expect(parsed.malformed).toBe(true);
    expect(parsed.level).toBe('info');
    expect(parsed.text).toBe('not json at all {');
  });

  it('falls back to raw text for valid-JSON-but-non-object values (e.g. an array or number)', () => {
    expect(parseLogLine('[1,2,3]').malformed).toBe(true);
    expect(parseLogLine('42').malformed).toBe(true);
  });

  it('returns null time for a missing or unparseable ts field', () => {
    expect(parseLogLine(JSON.stringify({ msg: 'x' })).time).toBeNull();
    expect(parseLogLine(JSON.stringify({ ts: 'not-a-date', msg: 'x' })).time).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Component smoke tests (real temp log dir, real logger.ts helpers)
// ---------------------------------------------------------------------------

describe('NodeLogs component', () => {
  it('shows the exact "No log lines yet" message (matching the CLI) when the log is empty', () => {
    const dir = mkTmpDir();
    const { lastFrame, unmount } = render(<NodeLogs onBack={() => {}} dir={dir} />);
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('No log lines yet');
    expect(plain).toContain(path.join(dir, NODE_LOG_FILENAME));
    unmount();
  });

  it('renders pre-existing lines on mount via readLastLines', () => {
    const dir = mkTmpDir();
    writeLine(dir, { ts: new Date().toISOString(), level: 'info', msg: 'first line' });
    writeLine(dir, { ts: new Date().toISOString(), level: 'error', msg: 'second line failed' });

    const { lastFrame, unmount } = render(<NodeLogs onBack={() => {}} dir={dir} />);
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('first line');
    expect(plain).toContain('second line failed');
    unmount();
  });

  it('live-tails newly appended lines via followLog', async () => {
    const dir = mkTmpDir();
    writeLine(dir, { ts: new Date().toISOString(), level: 'info', msg: 'initial' });

    const { lastFrame, unmount } = render(<NodeLogs onBack={() => {}} dir={dir} />);
    await flushAsync();

    writeLine(dir, { ts: new Date().toISOString(), level: 'warn', msg: 'appended later' });
    // fs.watch delivery + the follow drain loop are async; give it a beat.
    await flushAsync(300);

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('appended later');
    unmount();
  });

  it('stops following on unmount (no leaked fs.watch handle / no crash on late writes)', async () => {
    const dir = mkTmpDir();
    const { unmount } = render(<NodeLogs onBack={() => {}} dir={dir} />);
    await flushAsync();
    unmount();
    // A write after unmount must not throw synchronously or asynchronously.
    expect(() => writeLine(dir, { level: 'info', msg: 'after unmount' })).not.toThrow();
    await flushAsync(200);
  });

  it('calls onBack on q and Escape', async () => {
    const dir = mkTmpDir();
    const onBack = jest.fn();
    const { stdin, unmount } = render(<NodeLogs onBack={onBack} dir={dir} />);
    stdin.write('q');
    await flushAsync();
    expect(onBack).toHaveBeenCalledTimes(1);
    stdin.write('\x1B');
    await flushAsync();
    expect(onBack).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('clears the visible pane on "c" without touching the file', async () => {
    const dir = mkTmpDir();
    writeLine(dir, { level: 'info', msg: 'will be hidden' });
    const { lastFrame, stdin, unmount } = render(<NodeLogs onBack={() => {}} dir={dir} />);
    expect(stripAnsi(lastFrame()!)).toContain('will be hidden');

    stdin.write('c');
    await flushAsync();
    const plain = stripAnsi(lastFrame()!);
    expect(plain).not.toContain('will be hidden');
    expect(plain).toContain('No log lines yet');

    // File on disk is untouched.
    const onDisk = fs.readFileSync(path.join(dir, NODE_LOG_FILENAME), 'utf-8');
    expect(onDisk).toContain('will be hidden');
    unmount();
  });

  it('adjusts the tail-size window with + and - and shows it in the header', async () => {
    const dir = mkTmpDir();
    const { lastFrame, stdin, unmount } = render(<NodeLogs onBack={() => {}} dir={dir} />);
    expect(stripAnsi(lastFrame()!)).toContain(`tail: ${DEFAULT_TAIL_SIZE} lines`);

    stdin.write('+');
    await flushAsync();
    expect(stripAnsi(lastFrame()!)).toContain(`tail: ${DEFAULT_TAIL_SIZE + 10} lines`);

    stdin.write('-');
    await flushAsync();
    stdin.write('-');
    await flushAsync();
    expect(stripAnsi(lastFrame()!)).toContain(`tail: ${DEFAULT_TAIL_SIZE - 10} lines`);
    unmount();
  });

  it('clamps tail size to [MIN_TAIL_SIZE, MAX_TAIL_SIZE]', async () => {
    const dir = mkTmpDir();
    const { lastFrame, stdin, unmount } = render(<NodeLogs onBack={() => {}} dir={dir} />);

    for (let i = 0; i < 20; i++) {
      stdin.write('-');
      await flushAsync(10);
    }
    expect(stripAnsi(lastFrame()!)).toContain(`tail: ${MIN_TAIL_SIZE} lines`);

    for (let i = 0; i < 80; i++) {
      stdin.write('+');
      await flushAsync(10);
    }
    expect(stripAnsi(lastFrame()!)).toContain(`tail: ${MAX_TAIL_SIZE} lines`);
    unmount();
  });
});
