/**
 * tui/components/Legend.tsx — Color-coded legend for the ContextMeter.
 *
 * Shows a colored swatch, label, count, and percentage for each category.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { METER } from '../theme.js';
import type { RunProgressCounts } from '../../sync/events.js';

interface LegendProps {
  counts: RunProgressCounts;
  total: number;
}

interface LegendEntry {
  swatch: string;
  label: string;
  count: number;
  color: string;
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

export function Legend({ counts, total }: LegendProps): React.ReactElement {
  const entries: LegendEntry[] = [
    { swatch: METER.uploaded,  label: 'uploaded',  count: counts.uploaded,  color: 'green' },
    { swatch: METER.uploading, label: 'uploading', count: counts.uploading, color: 'cyan'  },
    { swatch: METER.queued,    label: 'queued',    count: counts.queued,    color: 'gray'  },
    { swatch: METER.skipped,   label: 'skipped',   count: counts.skipped,   color: 'blue'  },
    { swatch: METER.failed,    label: 'failed',    count: counts.failed,    color: 'red'   },
  ];

  return (
    <Box flexDirection="row" flexWrap="wrap" gap={2}>
      {entries.map(({ swatch, label, count, color }) => (
        <Box key={label} flexDirection="row" gap={1}>
          <Text color={color === 'gray' ? undefined : (color as Parameters<typeof Text>[0]['color'])} dimColor={color === 'gray'}>{swatch}</Text>
          <Text dimColor>{label}</Text>
          <Text>{count}</Text>
          <Text dimColor>({pct(count, total)})</Text>
        </Box>
      ))}
      <Box marginLeft={2}>
        <Text dimColor>{counts.uploaded + counts.uploading + counts.queued + counts.skipped + counts.failed} / {total}</Text>
      </Box>
    </Box>
  );
}
