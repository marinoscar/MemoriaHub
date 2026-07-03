/**
 * tui/ReportView.tsx — Generic report table renderer.
 *
 * Looks up a report from the shared registry, runs its `compute({ db })`, and
 * renders the resulting {columns, rows, summary?} as a simple padded text
 * table inside the standard cyan bordered box. Mirrors the column-padding
 * approach of the old StatusScreen. Esc/q → onBack.
 *
 * Props: { db, reportId, onBack }
 */

import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type BetterSqlite3 from 'better-sqlite3';

import { getReport } from '../reports/registry.js';
import type { ReportTable } from '../reports/types.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ReportViewProps {
  db: BetterSqlite3.Database;
  reportId: string;
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute a left-pad width per column from header + all cell values. */
function columnWidths(table: ReportTable): number[] {
  return table.columns.map((col, i) => {
    let w = String(col).length;
    for (const row of table.rows) {
      const cell = row[i];
      const len = cell === undefined || cell === null ? 0 : String(cell).length;
      if (len > w) w = len;
    }
    // A little breathing room between columns.
    return w + 2;
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReportView({ db, reportId, onBack }: ReportViewProps): React.ReactElement {
  const report = getReport(reportId);

  useInput((input, key) => {
    if (key.escape || input === 'q') onBack();
  });

  // Compute the table unconditionally (hooks must not be gated); when the
  // report is missing we simply don't use it.
  const table = useMemo<ReportTable | null>(
    () => (report ? report.compute({ db }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, reportId],
  );

  if (!report || !table) {
    return (
      <Box
        borderStyle={BOX_BORDER}
        borderColor="cyan"
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <Text dimColor>Unknown report: {reportId}</Text>
        <Box marginTop={1}>
          <Text dimColor>[Esc] back</Text>
        </Box>
      </Box>
    );
  }

  const widths = columnWidths(table);

  return (
    <Box
      borderStyle={BOX_BORDER}
      borderColor="cyan"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="cyan">{report.label}</Text>

      {/* Header row */}
      <Box flexDirection="row" marginTop={1}>
        {table.columns.map((col, i) => (
          <Text key={i} bold dimColor>{String(col).padEnd(widths[i])}</Text>
        ))}
      </Box>

      {/* Data rows */}
      {table.rows.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No data.</Text>
        </Box>
      ) : (
        table.rows.map((row, ri) => (
          <Box key={ri} flexDirection="row">
            {table.columns.map((_col, ci) => {
              const cell = row[ci];
              const str = cell === undefined || cell === null ? '' : String(cell);
              return <Text key={ci}>{str.padEnd(widths[ci])}</Text>;
            })}
          </Box>
        ))
      )}

      {/* Summary */}
      {table.summary && (
        <Box marginTop={1}>
          <Text dimColor>{table.summary}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>[Esc/q] back</Text>
      </Box>
    </Box>
  );
}
