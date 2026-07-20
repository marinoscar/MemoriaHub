/**
 * tui/ScanDashboard.tsx — Ink-based static scan report dashboard.
 *
 * Unlike JobsDashboard (which polls a live endpoint), this renders a single
 * precomputed ScanReport: a header, a KPI band, EXIF/GPS/date coverage meters,
 * and breakdown tables (by folder, by camera, largest files).  It waits for a
 * keypress so the user can read it, then exits.
 *
 * Keys:
 *   q / Esc / Enter — quit
 */

import React from 'react';
import { Box, Text, useApp, useInput } from 'ink';

import type { ScanReport } from '../scan/report.js';
import { formatBytes } from '../format-bytes.js';
import { formatDuration } from '../format-duration.js';
import { BOX_BORDER, METER } from './theme.js';
import { renderTui } from './raw-mode.js';

export interface ScanDashboardProps {
  report: ScanReport;
  serverUrl?: string;
}

// ---------------------------------------------------------------------------
// Entry point used by the scan command
// ---------------------------------------------------------------------------

export async function renderScanDashboard(props: ScanDashboardProps): Promise<void> {
  await renderTui(<ScanDashboard {...props} />);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - (max - 1));
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** A 10-cell coverage meter bar with a "count (pct%)" suffix. */
function CoverageMeter(props: {
  label: string;
  count: number;
  total: number;
  pct: number;
  color: string;
}): React.ReactElement {
  const { label, count, total, pct, color } = props;
  const fill = total > 0 ? Math.round((count / total) * 10) : 0;
  const bar = METER.uploaded.repeat(fill) + METER.queued.repeat(10 - fill);
  return (
    <Box flexDirection="row">
      <Text>{label.padEnd(14)}</Text>
      <Text color={color}>{bar}</Text>
      <Text>{'  '}{count}/{total} </Text>
      <Text dimColor>({pct}%)</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// ScanDashboard component
// ---------------------------------------------------------------------------

/**
 * ScanReportBody — the presentational report (header, KPI band, coverage meters,
 * breakdown tables) WITHOUT any footer or key handling.  Shared by the headless
 * ScanDashboard (scan command) and the app-hosted ScanScreen (interactive menu)
 * so both surfaces render an identical report.
 */
export function ScanReportBody({
  report,
  serverUrl,
}: {
  report: ScanReport;
  serverUrl?: string;
}): React.ReactElement {
  const { scan, kpis, coverage, byFolder, byCamera, largest } = report;

  const serverLabel = serverUrl
    ? (() => { try { return new URL(serverUrl).host; } catch { return serverUrl; } })()
    : undefined;

  const createdLabel = (() => {
    try { return new Date(scan.created_at).toLocaleString(); } catch { return scan.created_at; }
  })();

  return (
    <Box flexDirection="column" gap={1}>

      {/* 1. Header */}
      <Box borderStyle={BOX_BORDER} borderColor="cyan" paddingX={2} paddingY={0} flexDirection="row">
        <Text bold color="cyan">MemoriaHub — Scan Report</Text>
        <Text dimColor>  #{scan.id}</Text>
        <Text dimColor>  {createdLabel}</Text>
        {serverLabel && <Text dimColor>  {serverLabel}</Text>}
      </Box>

      {/* 2. KPI band */}
      <Box
        borderStyle={BOX_BORDER}
        borderColor="cyan"
        flexDirection="row"
        paddingX={2}
        paddingY={1}
        gap={2}
      >
        <Text bold>Files: <Text color="cyan">{kpis.totalFiles}</Text></Text>
        <Text>Photos: <Text color="green">{kpis.photoCount}</Text></Text>
        <Text>Videos: <Text color="blue">{kpis.videoCount}</Text></Text>
        <Text bold>Size: <Text color="cyan">{formatBytes(kpis.totalBytes)}</Text></Text>
        <Text dimColor>({formatBytes(kpis.photoBytes)} photo / {formatBytes(kpis.videoBytes)} video)</Text>
      </Box>

      {/* 3. Coverage meters */}
      <Box
        borderStyle={BOX_BORDER}
        borderColor="cyan"
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <Text bold color="cyan">Metadata Coverage</Text>
        <Box marginTop={1} flexDirection="column">
          <CoverageMeter label="EXIF present" count={coverage.exifCount} total={kpis.totalFiles} pct={coverage.exifPct} color="green" />
          <CoverageMeter label="Location/GPS" count={coverage.gpsCount} total={kpis.totalFiles} pct={coverage.gpsPct} color="cyan" />
          <CoverageMeter label="Capture date" count={coverage.capturedAtCount} total={kpis.totalFiles} pct={coverage.capturedAtPct} color="blue" />
        </Box>
        {coverage.metaErrorCount > 0 && (
          <Box marginTop={1}>
            <Text color="yellow">⚠ {coverage.metaErrorCount} file(s) could not be read for metadata</Text>
          </Box>
        )}
      </Box>

      {/* 4. By folder */}
      <Box
        borderStyle={BOX_BORDER}
        borderColor="cyan"
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <Text bold color="cyan">By Folder</Text>
        <Box flexDirection="row" marginTop={1}>
          <Text bold dimColor>{'Folder'.padEnd(40)}</Text>
          <Text bold dimColor>{'Files'.padEnd(8)}</Text>
          <Text bold dimColor>{'Size'.padEnd(10)}</Text>
        </Box>
        {byFolder.map((f) => (
          <Box key={f.folderId} flexDirection="row">
            <Text>{truncate(f.path, 39).padEnd(40)}</Text>
            <Text>{String(f.count).padEnd(8)}</Text>
            <Text>{formatBytes(f.bytes).padEnd(10)}</Text>
          </Box>
        ))}
      </Box>

      {/* 5. By camera (only when present) */}
      {byCamera.length > 0 && (
        <Box
          borderStyle={BOX_BORDER}
          borderColor="cyan"
          flexDirection="column"
          paddingX={2}
          paddingY={1}
        >
          <Text bold color="cyan">By Camera</Text>
          <Box flexDirection="row" marginTop={1}>
            <Text bold dimColor>{'Make / Model'.padEnd(40)}</Text>
            <Text bold dimColor>{'Files'.padEnd(8)}</Text>
          </Box>
          {byCamera.map((c, i) => (
            <Box key={`${c.label}-${i}`} flexDirection="row">
              <Text>{truncate(c.label, 39).padEnd(40)}</Text>
              <Text>{String(c.count).padEnd(8)}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* 6. Largest files */}
      {largest.length > 0 && (
        <Box
          borderStyle={BOX_BORDER}
          borderColor="cyan"
          flexDirection="column"
          paddingX={2}
          paddingY={1}
        >
          <Text bold color="cyan">Largest Files</Text>
          <Box flexDirection="row" marginTop={1}>
            <Text bold dimColor>{'File'.padEnd(40)}</Text>
            <Text bold dimColor>{'Size'.padEnd(10)}</Text>
          </Box>
          {largest.map((l, i) => (
            <Box key={`${l.path}-${i}`} flexDirection="row">
              <Text>{truncate(basename(l.path), 39).padEnd(40)}</Text>
              <Text>{formatBytes(l.sizeBytes).padEnd(10)}</Text>
            </Box>
          ))}
        </Box>
      )}

    </Box>
  );
}

export function ScanDashboard(props: ScanDashboardProps): React.ReactElement {
  const { report, serverUrl } = props;
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === 'q' || key.escape || key.return) exit();
  });

  const { scan } = report;

  return (
    <Box flexDirection="column" gap={1}>
      <ScanReportBody report={report} serverUrl={serverUrl} />

      {/* Footer */}
      <Box paddingX={2}>
        <Text dimColor>
          scanned in {formatDuration(scan.finished_at && scan.created_at
            ? new Date(scan.finished_at).getTime() - new Date(scan.created_at).getTime()
            : null)}
          {'   ·   '}[q] quit
        </Text>
      </Box>
    </Box>
  );
}
