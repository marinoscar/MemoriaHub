/**
 * test/tui/context-meter.spec.tsx
 *
 * Tests for the ContextMeter Ink component.
 *
 * Uses ink-testing-library which renders to a string buffer.
 * We assert on lastFrame() output rather than DOM-style queries.
 */

import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { ContextMeter } from '../../src/tui/components/ContextMeter.js';

afterEach(() => {
  cleanup();
});

// Stripe ANSI escape codes to get plain text for assertions.
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

describe('ContextMeter', () => {
  // -------------------------------------------------------------------------
  // Basic render
  // -------------------------------------------------------------------------

  it('renders without crashing for typical counts', () => {
    const { lastFrame } = render(
      <ContextMeter
        counts={{ uploaded: 30, uploading: 3, queued: 50, skipped: 10, failed: 7 }}
        total={100}
      />,
    );
    expect(lastFrame()).toBeTruthy();
    expect(lastFrame()!.length).toBeGreaterThan(0);
  });

  it('renders without crashing for zero-total case', () => {
    const { lastFrame } = render(
      <ContextMeter
        counts={{ uploaded: 0, uploading: 0, queued: 0, skipped: 0, failed: 0 }}
        total={0}
      />,
    );
    expect(lastFrame()).toBeTruthy();
    expect(lastFrame()!.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Percentage label
  // -------------------------------------------------------------------------

  it('shows 0% when no files are done yet', () => {
    const { lastFrame } = render(
      <ContextMeter
        counts={{ uploaded: 0, uploading: 0, queued: 10, skipped: 0, failed: 0 }}
        total={10}
      />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('0%');
  });

  it('shows 100% when all files are uploaded', () => {
    const { lastFrame } = render(
      <ContextMeter
        counts={{ uploaded: 100, uploading: 0, queued: 0, skipped: 0, failed: 0 }}
        total={100}
      />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('100%');
  });

  it('shows 50% when half are done (uploaded+skipped+failed)', () => {
    const { lastFrame } = render(
      <ContextMeter
        counts={{ uploaded: 50, uploading: 0, queued: 50, skipped: 0, failed: 0 }}
        total={100}
      />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('50%');
  });

  // -------------------------------------------------------------------------
  // Category counts in the label line
  // -------------------------------------------------------------------------

  it('displays uploaded count in the label row', () => {
    const { lastFrame } = render(
      <ContextMeter
        counts={{ uploaded: 42, uploading: 1, queued: 5, skipped: 2, failed: 0 }}
        total={50}
      />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('42');
  });

  it('displays failed count in the label row', () => {
    const { lastFrame } = render(
      <ContextMeter
        counts={{ uploaded: 10, uploading: 0, queued: 0, skipped: 0, failed: 7 }}
        total={17}
      />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('7');
  });

  it('displays uploading count in the label row', () => {
    const { lastFrame } = render(
      <ContextMeter
        counts={{ uploaded: 0, uploading: 3, queued: 7, skipped: 0, failed: 0 }}
        total={10}
      />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('3');
  });

  // -------------------------------------------------------------------------
  // Meter bar character count
  // -------------------------------------------------------------------------

  it('meter bar contains exactly 56 block characters (METER_WIDTH)', () => {
    const { lastFrame } = render(
      <ContextMeter
        counts={{ uploaded: 30, uploading: 5, queued: 20, skipped: 10, failed: 5 }}
        total={70}
      />,
    );
    const plain = stripAnsi(lastFrame()!);

    // Count the block/fill characters from the meter
    const blockChars = ['█', '▓', '░', '▒', '✖'];
    let cellCount = 0;
    for (const ch of plain) {
      if (blockChars.includes(ch)) cellCount++;
    }
    // Should match METER_WIDTH = 56
    expect(cellCount).toBe(56);
  });

  it('zero-total case still renders 56 cells (all as queued placeholder)', () => {
    const { lastFrame } = render(
      <ContextMeter
        counts={{ uploaded: 0, uploading: 0, queued: 0, skipped: 0, failed: 0 }}
        total={0}
      />,
    );
    const plain = stripAnsi(lastFrame()!);

    const blockChars = ['█', '▓', '░', '▒', '✖'];
    let cellCount = 0;
    for (const ch of plain) {
      if (blockChars.includes(ch)) cellCount++;
    }
    expect(cellCount).toBe(56);
  });

  // -------------------------------------------------------------------------
  // Label keywords present
  // -------------------------------------------------------------------------

  it('label row contains "uploaded", "uploading", "queued", "skipped", "failed" keywords', () => {
    const { lastFrame } = render(
      <ContextMeter
        counts={{ uploaded: 1, uploading: 1, queued: 1, skipped: 1, failed: 1 }}
        total={5}
      />,
    );
    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('uploaded');
    expect(plain).toContain('uploading');
    expect(plain).toContain('queued');
    expect(plain).toContain('skipped');
    expect(plain).toContain('failed');
  });
});
