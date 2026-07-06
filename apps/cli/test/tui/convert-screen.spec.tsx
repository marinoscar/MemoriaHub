/**
 * test/tui/convert-screen.spec.tsx
 *
 * Tests for ConvertScreen (the app-hosted "Convert videos to MP4" screen).
 * The engine is injected via `_engineForTesting`, mirroring scan-screen.spec.tsx.
 * When injected, the screen only subscribes to engine events — the test drives
 * the phase transitions by emitting events directly.
 */

import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { ConvertScreen } from '../../src/tui/ConvertScreen.js';
import { ConvertEngine } from '../../src/convert/convert-engine.js';
import { CONVERT_EV, type ConvertTotals } from '../../src/convert/events.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { SettingsRepo } from '../../src/repo/settings.js';
import { openDb } from '../../src/db/database.js';
import type BetterSqlite3 from 'better-sqlite3';

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function flushAsync(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeEngine(db: BetterSqlite3.Database): ConvertEngine {
  return new ConvertEngine({ folders: new FolderRepo(db), settings: new SettingsRepo(db) });
}

function totals(over: Partial<ConvertTotals> = {}): ConvertTotals {
  return {
    total: 0, converted: 0, skipped: 0, errors: 0, deleted: 0,
    remuxed: 0, reencoded: 0, bytesIn: 0, bytesOut: 0, ...over,
  };
}

describe('ConvertScreen', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    cleanup();
    db.close();
  });

  it('shows the confirm plan after the dry-run pass reports convertible files', async () => {
    const engine = makeEngine(db);
    const { lastFrame } = render(
      <ConvertScreen db={db} all onHome={() => {}} onBack={() => {}} _engineForTesting={engine} />,
    );

    // Dry-run plan pass completes with 3 convertible files.
    engine.emit(CONVERT_EV.CONVERT_DONE, { totals: totals({ total: 3 }) });
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Plan');
    expect(plain).toContain('3');
    expect(plain).toContain('[y]');
  });

  it('shows "empty" when the plan finds no convertible files', async () => {
    const engine = makeEngine(db);
    const { lastFrame } = render(
      <ConvertScreen db={db} all onHome={() => {}} onBack={() => {}} _engineForTesting={engine} />,
    );

    engine.emit(CONVERT_EV.CONVERT_DONE, { totals: totals({ total: 0 }) });
    await flushAsync();

    expect(stripAnsi(lastFrame()!)).toContain('No convertible video files found');
  });

  it('renders live progress and then the done summary', async () => {
    const engine = makeEngine(db);
    const { lastFrame, stdin } = render(
      <ConvertScreen db={db} all onHome={() => {}} onBack={() => {}} _engineForTesting={engine} />,
    );

    // Plan → confirm.
    engine.emit(CONVERT_EV.CONVERT_DONE, { totals: totals({ total: 2 }) });
    await flushAsync();

    // Confirm with 'y' → running.
    stdin.write('y');
    await flushAsync();

    engine.emit(CONVERT_EV.CONVERT_PROGRESS, { processed: 1, total: 2 });
    await flushAsync();
    expect(stripAnsi(lastFrame()!)).toContain('1/2');

    engine.emit(CONVERT_EV.CONVERT_DONE, {
      totals: totals({ total: 2, converted: 2, remuxed: 2 }),
    });
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Convert complete');
    expect(plain).toContain('2 converted');
  });

  it('shows the error phase (with install hint) when ERROR is emitted', async () => {
    const engine = makeEngine(db);
    const { lastFrame } = render(
      <ConvertScreen db={db} all onHome={() => {}} onBack={() => {}} _engineForTesting={engine} />,
    );

    engine.emit(CONVERT_EV.ERROR, {
      message: 'ffmpeg was not found on your PATH. Install ffmpeg with: brew install ffmpeg',
    });
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Convert failed');
    expect(plain).toContain('ffmpeg');
  });
});
