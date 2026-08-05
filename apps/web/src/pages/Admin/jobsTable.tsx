/**
 * Job Queue — the DataTable declaration and its query mapping (issue #258).
 *
 * Split out of `JobsPage.tsx` so the two halves that are worth testing in
 * isolation actually can be: the column set (13 columns across the three
 * `priority` bands) and the pure model → query params mapping that replaced the
 * page's hand-rolled Status / Type / Processed selects and "Backing off"
 * switch.
 *
 * ## The filter contract this page has to hit exactly
 *
 * `GET /api/admin/jobs` accepts four filter params, and three of them are NOT a
 * plain "column equals value":
 *
 * | Param             | Shape                                                     |
 * | ----------------- | --------------------------------------------------------- |
 * | `status`          | one of four enum values                                    |
 * | `type`            | one job type, from the live `byType` breakdown             |
 * | `processedWithin` | `4h`/`24h`/`7d`/`30d` — a window over `COALESCE(finishedAt, createdAt)`, not a date field |
 * | `scheduled=true`  | pending jobs currently in backoff; the API FORCES `status=pending` when it is set |
 *
 * The last two have no cell to live in, so they are declared `filterOnly`
 * (docs/specs/datatable.md §18.1). `scheduled` and `status` are additionally
 * mutually exclusive — see {@link normalizeJobFilters}.
 *
 * Every filterable column pins `filterable: ['is']`. The enum default set is
 * `is / isNot / isAnyOf`, and this endpoint can express none of the other two:
 * offering them would be exactly the "looks live, does nothing" affordance the
 * contract refuses for `sortable`.
 *
 * ## Nothing is `sortable`
 *
 * `GET /api/admin/jobs` takes no `sortBy` / `sortOrder`. Sorting is always
 * server-side in this component, so no column opts in and the page passes no
 * `sort` config — rather than painting interactive headers that would silently
 * do nothing.
 */

import { Box, Chip, Tooltip, Typography } from '@mui/material';
import { Schedule as ScheduleIcon } from '@mui/icons-material';
import type {
  DataTableColumn,
  DataTableFilterModel,
} from '../../components/datatable';
import type {
  EnrichmentJobDto,
  JobProcessedWindow,
  JobStatus,
} from '../../services/jobs';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Persistence key for the user's column/density choices
 * (`user_settings.dataTables['admin-jobs']`). Chosen by the page and never
 * derived from the route — it must survive a URL change.
 */
export const JOB_TABLE_ID = 'admin-jobs';

const JOB_STATUSES: JobStatus[] = ['pending', 'running', 'succeeded', 'failed'];
const JOB_PROCESSED_WINDOWS: JobProcessedWindow[] = ['4h', '24h', '7d', '30d'];

// ---------------------------------------------------------------------------
// Cell helpers — only `shortId` and `downloadJobJson` are used outside this
// module (the page's snackbars and its row-action list).
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<JobStatus, 'default' | 'info' | 'success' | 'error' | 'warning'> = {
  pending: 'default',
  running: 'info',
  succeeded: 'success',
  failed: 'error',
};

function StatusChip({ status }: { status: JobStatus }) {
  return (
    <Chip
      label={status}
      color={STATUS_COLORS[status] ?? 'default'}
      size="small"
      variant="outlined"
    />
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '—';
}

/** True when a pending job is actively backing off (`scheduledFor` is future). */
function isBackingOff(job: EnrichmentJobDto): boolean {
  return (
    job.status === 'pending' &&
    job.scheduledFor != null &&
    new Date(job.scheduledFor) > new Date()
  );
}

/** Human-readable relative time label, e.g. "in 2m" or "in 45s". */
function relativeTime(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return 'soon';
  const secs = Math.round(diffMs / 1000);
  if (secs < 60) return `in ${secs}s`;
  const mins = Math.round(secs / 60);
  return `in ${mins}m`;
}

/** The per-row "Download JSON" action. */
export function downloadJobJson(job: EnrichmentJobDto): void {
  const blob = new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `enrichment-job-${job.id}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** The scalar behind the Node column — also what a CSV export writes. */
function nodeValue(job: EnrichmentJobDto): string | null {
  if (job.executor === 'node') return job.claimedByNode?.name ?? 'node';
  if (job.executor === 'server') return 'server';
  return null;
}

const MUTED_DASH = (
  <Typography variant="body2" color="text.disabled">
    —
  </Typography>
);

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * The 12 data columns + 2 filter-only ones. (The 13th column an operator sees
 * on desktop is the synthetic Actions column the DataTable adds for
 * `rowActions`.)
 *
 * Priorities are issue #258's, verbatim:
 *   - primary   — Type, Status
 *   - secondary — Reason, Created  (+ Actions, which the component appends)
 *   - detail    — Node, Model, Priority, Attempts, Last error, Media item,
 *                 Started, Finished
 *
 * So a phone card leads with the type and the status chip and folds the other
 * eight behind "More details"; a tablet keeps the four and reaches the rest
 * through the row expander; a desktop shows everything, and the column picker
 * (persisted per user under {@link JOB_TABLE_ID}) is how an operator trims it.
 *
 * @param typeOptions job types from the live `stats.byType` breakdown; the Type
 *   filter can only offer values the queue actually contains.
 */
export function buildJobColumns(typeOptions: string[]): DataTableColumn<EnrichmentJobDto>[] {
  return [
    // --- primary ------------------------------------------------------------
    {
      id: 'type',
      label: 'Type',
      priority: 'primary',
      value: (job) => job.type,
      filterable: ['is'],
      filterType: 'enum',
      enumValues: typeOptions.map((type) => ({ value: type, label: type })),
      minWidth: 190,
      flex: 1.2,
    },
    {
      id: 'status',
      label: 'Status',
      priority: 'primary',
      value: (job) => job.status,
      render: (job) => (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, alignItems: 'flex-start' }}>
          <StatusChip status={job.status} />
          {isBackingOff(job) && (
            <Tooltip
              title={`Retries ${relativeTime(job.scheduledFor!)}${
                job.rateLimitHits > 0
                  ? ` · ${job.rateLimitHits} rate-limit hit${job.rateLimitHits !== 1 ? 's' : ''}`
                  : ''
              }`}
              arrow
            >
              <Chip
                icon={<ScheduleIcon />}
                label="backing off"
                color="info"
                size="small"
                variant="outlined"
                sx={{ cursor: 'help' }}
              />
            </Tooltip>
          )}
        </Box>
      ),
      filterable: ['is'],
      filterType: 'enum',
      enumValues: JOB_STATUSES.map((status) => ({
        value: status,
        label: status.charAt(0).toUpperCase() + status.slice(1),
      })),
      width: 150,
    },

    // --- secondary ----------------------------------------------------------
    {
      id: 'reason',
      label: 'Reason',
      priority: 'secondary',
      value: (job) => job.reason,
      width: 120,
    },
    {
      id: 'createdAt',
      label: 'Created',
      priority: 'secondary',
      value: (job) => job.createdAt,
      render: (job) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatDate(job.createdAt)}
        </Typography>
      ),
      minWidth: 180,
    },

    // --- detail -------------------------------------------------------------
    {
      id: 'node',
      label: 'Node',
      priority: 'detail',
      value: nodeValue,
      render: (job) =>
        job.executor === 'node' && job.claimedByNode ? (
          <Tooltip title={`Node ${job.claimedByNode.id}`} arrow>
            <Box sx={{ cursor: 'help', minWidth: 0 }}>
              <Typography variant="body2" noWrap>
                {job.claimedByNode.name}
              </Typography>
              <Typography
                variant="caption"
                sx={{ color: 'text.secondary', display: 'block' }}
                noWrap
              >
                {job.claimedByNode.hostname}
              </Typography>
            </Box>
          </Tooltip>
        ) : job.executor === 'server' ? (
          <Typography variant="body2" color="text.secondary">
            server
          </Typography>
        ) : (
          MUTED_DASH
        ),
      minWidth: 150,
    },
    {
      id: 'modelVersion',
      label: 'Model',
      priority: 'detail',
      value: (job) => job.modelVersion,
      render: (job) =>
        job.modelVersion ? (
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" noWrap>
              {job.modelVersion}
            </Typography>
            {job.providerKey && (
              <Typography
                variant="caption"
                sx={{ color: 'text.secondary', display: 'block' }}
                noWrap
              >
                {job.providerKey}
              </Typography>
            )}
          </Box>
        ) : (
          MUTED_DASH
        ),
      minWidth: 170,
    },
    {
      id: 'priority',
      label: 'Priority',
      priority: 'detail',
      align: 'right',
      value: (job) => job.priority,
      width: 100,
    },
    {
      id: 'attempts',
      label: 'Attempts',
      priority: 'detail',
      align: 'right',
      value: (job) => job.attempts,
      width: 110,
    },
    {
      id: 'lastError',
      label: 'Last error',
      priority: 'detail',
      value: (job) => job.lastError,
      // The reason this column no longer blows a row up to five lines: the grid
      // clips it to one line + tooltip, and the card turns the value itself
      // into a tap-to-expand control (there is no hover on a phone).
      truncate: true,
      render: (job) =>
        job.lastError ? (
          <Typography variant="body2" color="error.main">
            {job.lastError}
          </Typography>
        ) : (
          MUTED_DASH
        ),
      minWidth: 200,
      flex: 2,
    },
    {
      id: 'mediaItemId',
      label: 'Media item',
      priority: 'detail',
      value: (job) => job.mediaItemId,
      render: (job) =>
        job.mediaItemId ? (
          <Tooltip title={job.mediaItemId} arrow>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ fontFamily: 'monospace', cursor: 'help' }}
            >
              {shortId(job.mediaItemId)}&hellip;
            </Typography>
          </Tooltip>
        ) : (
          <Tooltip title="System job — not scoped to a media item" arrow>
            <Typography variant="body2" color="text.disabled" sx={{ cursor: 'help' }}>
              Global
            </Typography>
          </Tooltip>
        ),
      width: 140,
    },
    {
      id: 'startedAt',
      label: 'Started',
      priority: 'detail',
      value: (job) => job.startedAt,
      render: (job) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatDate(job.startedAt)}
        </Typography>
      ),
      minWidth: 180,
    },
    {
      id: 'finishedAt',
      label: 'Finished',
      priority: 'detail',
      value: (job) => job.finishedAt,
      render: (job) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatDate(job.finishedAt)}
        </Typography>
      ),
      minWidth: 180,
    },

    // --- filter-only (no cell; see the module docblock) ----------------------
    {
      id: 'processedWithin',
      label: 'Processed within',
      // Ignored for a `filterOnly` column, but `priority` is required.
      priority: 'detail',
      filterOnly: true,
      filterable: ['is'],
      filterType: 'enum',
      // Deliberately NOT `filterType: 'date'`. This is a discrete window over
      // `COALESCE(finishedAt, createdAt)` that the server computes, not a range
      // over either timestamp — `before`/`after`/`between` would produce a query
      // the endpoint cannot answer. The absence of this filter IS the API's
      // `all`, so `all` is not offered as a value.
      enumValues: [
        { value: '4h', label: 'Last 4 hours' },
        { value: '24h', label: 'Last 24 hours' },
        { value: '7d', label: 'Last 7 days' },
        { value: '30d', label: 'Last 30 days' },
      ],
    },
    {
      id: 'backingOff',
      label: 'Backing off',
      priority: 'detail',
      filterOnly: true,
      filterable: ['is'],
      // A single-option enum rather than `filterType: 'boolean'`: the boolean
      // editor offers Yes/No, and "No" has no server semantics here (there is
      // no `scheduled=false`). One expressible value, one option.
      filterType: 'enum',
      enumValues: [{ value: 'true', label: 'Yes — in retry delay' }],
    },
  ];
}

// ---------------------------------------------------------------------------
// Model → query params
// ---------------------------------------------------------------------------

/** The subset of `ListJobsParams` the filter model produces. */
export interface JobFilterQuery {
  status?: JobStatus;
  type?: string;
  scheduled?: boolean;
  processedWithin?: JobProcessedWindow;
}

/**
 * Which filters cannot coexist, keyed by column id.
 *
 * `status` and `backingOff` are one control wearing two hats: `scheduled=true`
 * forces `status=pending` server-side, so "failed AND backing off" is not a
 * query this endpoint can answer. Two ids sharing a group means the model may
 * hold at most one of them.
 */
const EXCLUSIVE_GROUPS: Record<string, string> = {
  status: 'queue-slice',
  backingOff: 'queue-slice',
};

function groupOf(columnId: string): string {
  return EXCLUSIVE_GROUPS[columnId] ?? columnId;
}

/**
 * Reduce an emitted model to one that this endpoint can actually answer.
 *
 * Two rules, both "last wins", both applied over the whole model because the
 * DataTable hands back the entire next model on every change (never a delta):
 *
 * 1. **One filter per column.** Every param here is single-valued; a second
 *    `type` filter could only shadow the first.
 * 2. **One filter per exclusive group.** Adding "Backing off" drops an active
 *    Status filter and vice versa — exactly what the old page's two controls
 *    did to each other by hand.
 *
 * Because `filters` is controlled, the normalized model is what the chip strip
 * renders: the dropped filter visibly disappears instead of lingering as a chip
 * with no effect on the query.
 */
export function normalizeJobFilters(model: DataTableFilterModel): DataTableFilterModel {
  const claimed = new Set<string>();
  const out: DataTableFilterModel = [];
  for (let index = model.length - 1; index >= 0; index -= 1) {
    const filter = model[index];
    const group = groupOf(filter.columnId);
    if (claimed.has(group)) continue;
    claimed.add(group);
    out.unshift(filter);
  }
  return out.length === model.length ? model : out;
}

/**
 * Map the normalized filter model onto `GET /api/admin/jobs` query params.
 *
 * Pure, and the single place this page's endpoint semantics live. Unknown
 * columns, unknown operators and unrecognized enum values are ignored rather
 * than forwarded — a filter restored from a stale URL should drop, not produce
 * a 400.
 */
export function toJobQuery(model: DataTableFilterModel): JobFilterQuery {
  const query: JobFilterQuery = {};

  for (const filter of model) {
    // Every filterable column here pins `['is']`; anything else came from
    // somewhere that is not this table's own UI.
    if (filter.operator !== 'is') continue;
    const raw = Array.isArray(filter.value) ? filter.value[0] : filter.value;
    if (raw === null || raw === undefined || raw === '') continue;
    const value = String(raw);

    switch (filter.columnId) {
      case 'status':
        if ((JOB_STATUSES as string[]).includes(value)) query.status = value as JobStatus;
        break;
      case 'type':
        query.type = value;
        break;
      case 'processedWithin':
        if ((JOB_PROCESSED_WINDOWS as string[]).includes(value)) {
          query.processedWithin = value as JobProcessedWindow;
        }
        break;
      case 'backingOff':
        if (value === 'true') query.scheduled = true;
        break;
      default:
        break;
    }
  }

  // `scheduled=true` FORCES `status=pending` on the API side. Sending a status
  // alongside it would be a contradiction the server silently resolves, so the
  // status param is dropped instead. `normalizeJobFilters` already makes the
  // two mutually exclusive in the model; this keeps the invariant true for a
  // model that arrived some other way (a hand-edited URL, a future caller).
  if (query.scheduled) delete query.status;

  return query;
}
