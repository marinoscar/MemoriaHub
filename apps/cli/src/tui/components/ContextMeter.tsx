/**
 * tui/components/ContextMeter.tsx — Claude-Code-style block-grid progress meter.
 *
 * Allocates cells across 5 categories (uploaded, uploading, queued, skipped,
 * failed) using largest-remainder rounding so the total always equals WIDTH.
 * Each cell is one character from METER.  Colors match the theme palette.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { colors, METER } from '../theme.js';
import type { RunProgressCounts } from '../../sync/events.js';

// ---------------------------------------------------------------------------
// Cell-allocation via largest-remainder (Hamilton/Hare) method
// ---------------------------------------------------------------------------

const METER_WIDTH = 56; // characters per row; even number for clean display

interface Allocation {
  uploaded:  number;
  uploading: number;
  queued:    number;
  skipped:   number;
  failed:    number;
}

type AllocKey = keyof Allocation;
const KEYS: AllocKey[] = ['uploaded', 'uploading', 'queued', 'skipped', 'failed'];

function allocateCells(counts: RunProgressCounts, total: number): Allocation {
  const width = METER_WIDTH;

  if (total === 0) {
    return { uploaded: 0, uploading: 0, queued: width, skipped: 0, failed: 0 };
  }

  // Exact (fractional) shares
  const exact: Record<AllocKey, number> = {
    uploaded:  (counts.uploaded  / total) * width,
    uploading: (counts.uploading / total) * width,
    queued:    (counts.queued    / total) * width,
    skipped:   (counts.skipped   / total) * width,
    failed:    (counts.failed    / total) * width,
  };

  // Floor each share
  const floors: Record<AllocKey, number> = {} as Record<AllocKey, number>;
  let allocated = 0;
  for (const k of KEYS) {
    floors[k] = Math.floor(exact[k]);
    allocated += floors[k];
  }

  // Distribute remaining cells to highest remainders
  let remaining = width - allocated;
  const remainders = KEYS
    .map((k) => ({ k, rem: exact[k] - floors[k] }))
    .sort((a, b) => b.rem - a.rem);

  for (const { k } of remainders) {
    if (remaining <= 0) break;
    floors[k]++;
    remaining--;
  }

  return floors as Allocation;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ContextMeterProps {
  counts: RunProgressCounts;
  total: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ContextMeter({ counts, total }: ContextMeterProps): React.ReactElement {
  const alloc = allocateCells(counts, total);

  // Build the cell string: each category gets its block character repeated
  const segments: Array<{ text: string; color: (s: string) => string }> = [
    { text: METER.uploaded.repeat(alloc.uploaded),   color: colors.uploaded },
    { text: METER.uploading.repeat(alloc.uploading), color: colors.uploading },
    { text: METER.queued.repeat(alloc.queued),       color: colors.queued },
    { text: METER.skipped.repeat(alloc.skipped),     color: colors.skipped },
    { text: METER.failed.repeat(alloc.failed),       color: colors.failed },
  ];

  const pct = total > 0
    ? Math.round(((counts.uploaded + counts.skipped + counts.failed) / total) * 100)
    : 0;

  return (
    <Box flexDirection="column">
      {/* Meter bar */}
      <Box>
        {segments.map((seg, i) =>
          seg.text.length > 0 ? (
            <Text key={i}>{seg.color(seg.text)}</Text>
          ) : null,
        )}
      </Box>
      {/* Percentage label */}
      <Box marginTop={0}>
        <Text dimColor>{pct}% complete  </Text>
        <Text color="green">{counts.uploaded} uploaded  </Text>
        <Text color="cyan">{counts.uploading} uploading  </Text>
        <Text dimColor>{counts.queued} queued  </Text>
        <Text color="blue">{counts.skipped} skipped  </Text>
        <Text color="red">{counts.failed} failed</Text>
      </Box>
    </Box>
  );
}
