/**
 * test/tui/sync-meter.spec.tsx  (was context-meter.spec.tsx; RETRO-F4, #582)
 *
 * The 1.3 `ContextMeter` + `Legend` are the platform `SegmentMeter` + `MeterLegend`
 * now; the cell allocation (largest remainder) is the platform's, the five upload
 * categories and their glyphs are `syncSegments` (tui/sync-view.tsx). Every 1.3
 * assertion is kept, with the meter width the platform's default (56 cells) and the
 * labels read from the legend, which prints them with counts and shares.
 */
import { render, cleanup } from 'ink-testing-library';
import { MeterLegend, SegmentMeter } from '@marinoscar/platform-cli/tui/ui';

import { syncSegments } from '../../src/tui/sync-view.js';

afterEach(() => {
  cleanup();
});

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

type Counts = { uploaded: number; uploading: number; queued: number; skipped: number; failed: number };

function meter(counts: Counts, total: number): string {
  const segments = syncSegments(counts);
  const { lastFrame } = render(
    <>
      <SegmentMeter segments={segments} total={total} />
      <MeterLegend segments={segments} total={total} />
    </>,
  );
  return stripAnsi(lastFrame()!);
}

describe('sync meter (SegmentMeter + MeterLegend over syncSegments)', () => {
  it('renders without crashing for typical counts', () => {
    expect(meter({ uploaded: 30, uploading: 3, queued: 50, skipped: 10, failed: 7 }, 100).length).toBeGreaterThan(0);
  });

  it('renders without crashing for the zero-total case', () => {
    expect(meter({ uploaded: 0, uploading: 0, queued: 0, skipped: 0, failed: 0 }, 1).length).toBeGreaterThan(0);
  });

  it('shows 0% when no files are done yet', () => {
    expect(meter({ uploaded: 0, uploading: 0, queued: 10, skipped: 0, failed: 0 }, 10)).toContain('0%');
  });

  it('shows 100% when all files are uploaded', () => {
    expect(meter({ uploaded: 100, uploading: 0, queued: 0, skipped: 0, failed: 0 }, 100)).toContain('100%');
  });

  it('shows 50% when half are done (uploaded+skipped+failed)', () => {
    expect(meter({ uploaded: 50, uploading: 0, queued: 50, skipped: 0, failed: 0 }, 100)).toContain('50%');
  });

  it('displays each category count in the legend', () => {
    const plain = meter({ uploaded: 42, uploading: 3, queued: 5, skipped: 2, failed: 7 }, 59);
    for (const n of ['42', '3', '5', '2', '7']) expect(plain).toContain(n);
  });

  it('meter bar contains exactly 56 cells (the default width)', () => {
    const segments = syncSegments({ uploaded: 30, uploading: 5, queued: 20, skipped: 10, failed: 5 });
    const { lastFrame } = render(<SegmentMeter segments={segments} total={70} />);
    const bar = stripAnsi(lastFrame()!).split('\n')[0]!.replace(/\s+\d+%.*$/, '');
    expect([...bar].filter((ch) => ['█', '▓', '░', '▒', '✖'].includes(ch))).toHaveLength(56);
  });

  it('the legend carries the "uploaded", "uploading", "queued", "skipped", "failed" keywords', () => {
    const plain = meter({ uploaded: 1, uploading: 1, queued: 1, skipped: 1, failed: 1 }, 5);
    for (const word of ['uploaded', 'uploading', 'queued', 'skipped', 'failed']) expect(plain).toContain(word);
  });
});
