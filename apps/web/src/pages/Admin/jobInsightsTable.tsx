/**
 * Job Queue Insights — the per-type DataTable declaration (issue #259).
 *
 * The row model is a JOIN of four independent per-type arrays the insights
 * endpoint returns (`live.byType`, `history.byType`, `eta.perType`,
 * `lifetime.byType`), so {@link buildPerTypeRows} lives here beside the columns
 * that read it — the two are one contract and were previously buried mid-page.
 *
 * ## No pagination, no filters, no sort
 *
 * `GET /api/admin/jobs/insights` is a single on-demand aggregate: it returns
 * every job type in one payload, unpaginated, with no query params beyond
 * `windowDays`. There is nothing for a server-side page/filter/sort control to
 * talk to, so none is declared — the `sortable`-defaults-to-false rule (§4)
 * applied to a whole table. The row count is bounded by the number of enrichment
 * job types (~30), comfortably under the MIT DataGrid's 100-row page ceiling.
 */

import { Typography } from '@mui/material';
import type { DataTableColumn } from '../../components/datatable';
import { formatCompactNumber, formatDuration } from '../../utils/formatBytes';
import type {
  JobInsightsLiveByType,
  JobInsightsHistoryByType,
  JobInsightsEtaPerType,
  JobLifetimeByType,
} from '../../services/jobInsights';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const JOB_INSIGHTS_TABLE_ID = 'admin-job-insights';

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

export interface PerTypeRow {
  type: string;
  queued: number;
  avgMs: number | null;
  p95Ms: number | null;
  throughputPerMin: number | null;
  etcMs: number | null;
  lifetimeTotal: number;
}

/**
 * Join the four per-type arrays into one row per job type, ordered by backlog
 * (queued descending) then alphabetically — the order an operator scans in.
 */
export function buildPerTypeRows(
  liveByType: JobInsightsLiveByType[],
  historyByType: JobInsightsHistoryByType[],
  etaPerType: JobInsightsEtaPerType[],
  lifetimeByType: JobLifetimeByType[],
): PerTypeRow[] {
  const allTypes = new Set<string>();
  liveByType.forEach((r) => allTypes.add(r.type));
  historyByType.forEach((r) => allTypes.add(r.type));
  etaPerType.forEach((r) => allTypes.add(r.type));
  lifetimeByType.forEach((r) => allTypes.add(r.type));

  const rows: PerTypeRow[] = Array.from(allTypes).map((type) => {
    const live = liveByType.find((r) => r.type === type);
    const hist = historyByType.find((r) => r.type === type);
    const eta = etaPerType.find((r) => r.type === type);
    const life = lifetimeByType.find((r) => r.type === type);

    const queued = (live?.pending ?? 0) + (live?.running ?? 0);

    return {
      type,
      queued,
      avgMs: hist?.avgMs ?? null,
      p95Ms: hist?.p95Ms ?? null,
      throughputPerMin: hist?.throughputPerMin ?? null,
      etcMs: eta?.etcMs ?? null,
      lifetimeTotal: life?.total ?? 0,
    };
  });

  rows.sort((a, b) => {
    if (b.queued !== a.queued) return b.queued - a.queued;
    return a.type.localeCompare(b.type);
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

function numberCell(text: string, muted = false) {
  return (
    <Typography variant="body2" sx={muted ? { color: 'text.secondary' } : undefined}>
      {text}
    </Typography>
  );
}

/** Throughput, as the page has always rendered it: `"12.4/min"`, else an em dash. */
export function formatThroughput(perMin: number | null): string {
  return perMin !== null && perMin > 0 ? `${perMin.toFixed(1)}/min` : '—';
}

/**
 * The seven per-type columns.
 *
 * Priorities:
 *   - primary   — Type, Queued  (the backlog question a card must answer first)
 *   - secondary — Avg Duration, ETC
 *   - detail    — p95, Throughput, All-time
 */
export const JOB_INSIGHTS_COLUMNS: DataTableColumn<PerTypeRow>[] = [
  {
    id: 'type',
    label: 'Type',
    priority: 'primary',
    value: (row) => row.type,
    render: (row) => (
      <Typography variant="body2" sx={{ fontWeight: 500 }} noWrap>
        {row.type}
      </Typography>
    ),
    minWidth: 200,
    flex: 1.2,
  },
  {
    id: 'queued',
    label: 'Queued',
    priority: 'primary',
    align: 'right',
    value: (row) => row.queued,
    render: (row) => numberCell(row.queued > 0 ? String(row.queued) : '—'),
    width: 110,
  },
  {
    id: 'avgMs',
    label: 'Avg Duration',
    priority: 'secondary',
    align: 'right',
    value: (row) => row.avgMs,
    render: (row) => numberCell(formatDuration(row.avgMs)),
    width: 140,
  },
  {
    id: 'etcMs',
    label: 'ETC',
    priority: 'secondary',
    align: 'right',
    value: (row) => row.etcMs,
    render: (row) => numberCell(formatDuration(row.etcMs)),
    width: 120,
  },
  {
    id: 'p95Ms',
    label: 'p95',
    priority: 'detail',
    align: 'right',
    value: (row) => row.p95Ms,
    render: (row) => numberCell(formatDuration(row.p95Ms)),
    width: 110,
  },
  {
    id: 'throughputPerMin',
    label: 'Throughput',
    priority: 'detail',
    align: 'right',
    value: (row) => row.throughputPerMin,
    render: (row) => numberCell(formatThroughput(row.throughputPerMin)),
    width: 130,
  },
  {
    id: 'lifetimeTotal',
    label: 'All-time',
    priority: 'detail',
    align: 'right',
    value: (row) => row.lifetimeTotal,
    render: (row) =>
      numberCell(row.lifetimeTotal > 0 ? formatCompactNumber(row.lifetimeTotal) : '—', true),
    width: 120,
  },
];
