/**
 * tui/sync-view.tsx — how the sync run is drawn with the platform component kit
 * (`@marinoscar/platform-cli/tui/ui`, RETRO-F4 #582), replacing the 1.3
 * `components/{StatusLine,ContextMeter,Legend,ActiveUploads,EventLog,Summary}`.
 *
 * The kit is app-neutral: this file is the MemoriaHub vocabulary on top of it — the
 * five upload categories with the 1.3 glyphs, the log kinds, the status line items and
 * the end-of-run panel with its Excel report line and key hints.
 */
import { Box, Text, useInput } from './ink.js';
import type { ReactElement } from 'react';
import {
  RunSummary,
  middleTruncate,
  type TuiLogEvent,
  type TuiLogKind,
  type TuiMeterSegment,
  type TuiSummaryFailure,
} from '@marinoscar/platform-cli/tui/ui';

import type { RunProgressCounts, RunStats } from '../sync/events.js';

/** The upload categories, in meter order, with the glyphs the 1.3 meter used. */
export function syncSegments(counts: RunProgressCounts): TuiMeterSegment<keyof RunProgressCounts>[] {
  return [
    { id: 'uploaded', label: 'uploaded', count: counts.uploaded, tone: 'success', glyph: '█', done: true },
    { id: 'uploading', label: 'uploading', count: counts.uploading, tone: 'primary', glyph: '▓' },
    { id: 'queued', label: 'queued', count: counts.queued, tone: 'dim', glyph: '░' },
    { id: 'skipped', label: 'skipped', count: counts.skipped, tone: 'info', glyph: '▒', done: true },
    { id: 'failed', label: 'failed', count: counts.failed, tone: 'error', glyph: '✖', done: true },
  ];
}

export type SyncLogKind = 'done' | 'skipped' | 'failed';

export const SYNC_LOG_KINDS: Readonly<Record<SyncLogKind, TuiLogKind>> = {
  done: { glyph: '✔', tone: 'success' },
  skipped: { glyph: '↷', tone: 'info' },
  failed: { glyph: '✖', tone: 'error' },
};

export type SyncLogEvent = TuiLogEvent<SyncLogKind>;

/** Human-friendly labels for known skip reasons; falls back to the raw value. */
const REASON_LABELS: Record<string, string> = { out_of_range: 'out of date range' };

export function basename(p: string): string {
  return p.split('/').pop() ?? p;
}

/** One finished file as a log line: `✔ name`, `↷ name (reason)`, `✖ name: error — will retry|blocked`. */
export function fileLogEvent(
  event:
    | { kind: 'done'; id: number; path: string }
    | { kind: 'skipped'; id: number; path: string; reason?: string | undefined }
    | { kind: 'failed'; id: number; path: string; error?: string | undefined; willRetry?: boolean | undefined },
): SyncLogEvent {
  const text = basename(event.path);
  switch (event.kind) {
    case 'done':
      return { id: event.id, kind: 'done', text };
    case 'skipped':
      return { id: event.id, kind: 'skipped', text, detail: `(${event.reason ? (REASON_LABELS[event.reason] ?? event.reason) : 'skipped'})` };
    case 'failed':
      return {
        id: event.id,
        kind: 'failed',
        text,
        detail: `${event.error ? `: ${middleTruncate(event.error, 30)}` : ''} ${event.willRetry ? '— will retry' : '— blocked'}`.trim(),
        retrying: event.willRetry === true,
      };
  }
}

export interface SyncFailure {
  fileId: number;
  path: string;
  error: string;
}

export interface SyncSummaryProps {
  runId: number;
  stats: RunStats;
  durationMs: number;
  failures: SyncFailure[];
  /** Excel run-report auto-export state. */
  exporting?: boolean;
  exportPath?: string | null;
  exportError?: string | null;
  onHome: () => void;
  /** Retry failed uploads; `force` also resets files blocked at the attempts cap. */
  onRetry: (force?: boolean) => void;
}

/**
 * The post-run panel. Keys: Enter/q home, r retry failed, f force retry (reset the attempt cap).
 */
export function SyncSummary({
  runId,
  stats,
  durationMs,
  failures,
  exporting,
  exportPath,
  exportError,
  onHome,
  onRetry,
}: SyncSummaryProps): ReactElement {
  useInput((input, key) => {
    if (key.return || input === 'q') onHome();
    if (input === 'r' && failures.length > 0) onRetry(false);
    if (input === 'f' && failures.length > 0) onRetry(true);
  });

  const summaryFailures: TuiSummaryFailure[] = failures.map((f) => ({
    id: f.fileId,
    label: basename(f.path),
    error: f.error,
  }));

  return (
    <RunSummary
      title={`Sync Complete — Run #${runId}`}
      stats={[
        { label: 'Uploaded', value: String(stats.uploaded), tone: 'success' },
        { label: 'Skipped', value: String(stats.skipped), tone: 'dim' },
        { label: 'Failed', value: String(stats.failed), tone: stats.failed > 0 ? 'error' : 'dim' },
      ]}
      durationMs={durationMs}
      failures={summaryFailures}
      footer={
        <Box flexDirection="column">
          <Box flexDirection="column" paddingLeft={1}>
            {exporting && <Text dimColor>Creating Excel report…</Text>}
            {exportPath && <Text>📄 Excel report: {exportPath}</Text>}
            {exportError && <Text>⚠ Excel report failed: {exportError}</Text>}
          </Box>
          <Box flexDirection="row" gap={3} paddingLeft={1}>
            <Text dimColor>[Enter/q] back to home</Text>
            {failures.length > 0 && <Text>[r] retry failed</Text>}
            {failures.length > 0 && <Text dimColor>[f] force retry (reset attempt cap)</Text>}
          </Box>
        </Box>
      }
    />
  );
}
