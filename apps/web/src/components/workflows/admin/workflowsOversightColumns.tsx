/**
 * Workflow oversight — the DataTable column declaration (issue #261, epic #238).
 *
 * Split out of `WorkflowsOversightTable.tsx` for the reason every migration
 * since the pilot has (docs/specs/datatable.md §18): the column set is the half
 * worth testing on its own, and keeping it out of the component keeps the
 * component down to "hand the shared table its props".
 *
 * ## Priorities
 *
 *   - primary   — Workflow (name), Status (enabled/disabled)
 *   - secondary — Circle, Trigger, Last run
 *   - detail    — Subject, Matched (lifetime), Actioned (lifetime)
 *
 * `name` leads because it is the only row-unique column here: the first
 * `primary` column names every per-row control ("Row actions for Screenshot
 * cleanup", §17.6), and leading with Circle or Subject would name a dozen
 * controls "Family circle" or "Media item" (§13.1's row-unique rule).
 *
 * `enabled` is `primary` because enabled-vs-disabled is the state this page
 * exists to change — the same reasoning that makes `status` primary on every
 * other migrated surface.
 *
 * ## Nothing is `sortable` or `filterable`
 *
 * `GET /api/admin/workflows` accepts `circleId`, `trigger` and `enabled`, but
 * the page has never surfaced a control for any of them and adding three is a
 * feature, not a migration. It accepts no `sortBy` at all, so per the
 * `sortable`-defaults-to-false rule (§4) no column opts in and the component
 * passes no `sort` config, rather than painting headers that would silently do
 * nothing.
 */

import { Box, Chip, Stack, Typography } from '@mui/material';
import type { AdminWorkflowListItem } from '../../../services/adminWorkflows';
import {
  triggerLabel,
  runStatusColor,
  runStatusLabel,
  formatRelativeTime,
  formatCount,
} from '../../../utils/workflowFormat';
import type { WorkflowSubjectType } from '../../../types/workflows';
import type { DataTableColumn } from '../../datatable';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Persistence key for the user's column/density choices
 * (`user_settings.dataTables['admin-workflows']`). Chosen here and never
 * derived from the route — it must survive a URL change.
 */
export const WORKFLOWS_OVERSIGHT_TABLE_ID = 'admin-workflows';

const SUBJECT_LABELS: Record<WorkflowSubjectType, string> = {
  media_item: 'Media item',
};

export function subjectLabel(subject: WorkflowSubjectType): string {
  return SUBJECT_LABELS[subject] ?? subject;
}

/** One-line summary of a workflow's most recent run, or null when never run. */
export function lastRunSummary(item: AdminWorkflowListItem): string | null {
  const run = item.lastRun;
  if (!run) return null;
  const parts = [`${formatCount(run.succeededCount)} ok`];
  if (run.failedCount > 0) parts.push(`${formatCount(run.failedCount)} failed`);
  if (run.skippedCount > 0) parts.push(`${formatCount(run.skippedCount)} skipped`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export function buildWorkflowOversightColumns(): DataTableColumn<AdminWorkflowListItem>[] {
  return [
    // --- primary ------------------------------------------------------------
    {
      id: 'name',
      label: 'Workflow',
      priority: 'primary',
      value: (item) => item.name,
      render: (item) => (
        <Typography variant="body2" sx={{ fontWeight: 500 }} noWrap title={item.name}>
          {item.name}
        </Typography>
      ),
      minWidth: 180,
      flex: 1.2,
      // The row's identity: hiding it would leave every per-row control named
      // after the row id instead (§17.6).
      hideable: false,
    },
    {
      id: 'enabled',
      label: 'Status',
      priority: 'primary',
      value: (item) => (item.enabled ? 'Enabled' : 'Disabled'),
      render: (item) => (
        <Chip
          size="small"
          label={item.enabled ? 'Enabled' : 'Disabled'}
          color={item.enabled ? 'success' : 'default'}
          variant={item.enabled ? 'filled' : 'outlined'}
        />
      ),
      width: 130,
    },

    // --- secondary ----------------------------------------------------------
    {
      id: 'circle',
      label: 'Circle',
      priority: 'secondary',
      value: (item) => item.circle?.name ?? null,
      render: (item) => (
        <Typography variant="body2" sx={{ color: 'text.secondary' }} noWrap>
          {item.circle?.name ?? '—'}
        </Typography>
      ),
      minWidth: 140,
    },
    {
      id: 'trigger',
      label: 'Trigger',
      priority: 'secondary',
      value: (item) => triggerLabel(item.trigger),
      width: 140,
    },
    {
      id: 'lastRun',
      label: 'Last run',
      priority: 'secondary',
      // The scalar behind the cell — what a CSV export writes and what the
      // truncation tooltip would reveal.
      value: (item) => lastRunSummary(item),
      render: (item) =>
        item.lastRun ? (
          <Stack spacing={0.5} sx={{ minWidth: 0, py: 0.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Chip
                size="small"
                label={runStatusLabel(item.lastRun.status)}
                color={runStatusColor(item.lastRun.status)}
                variant="outlined"
              />
              <Typography variant="caption" color="text.secondary">
                {formatRelativeTime(item.lastRun.finishedAt ?? item.lastRun.createdAt)}
              </Typography>
            </Box>
            <Typography variant="caption" color="text.secondary">
              {lastRunSummary(item)}
            </Typography>
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Never run
          </Typography>
        ),
      minWidth: 200,
      flex: 1.4,
    },

    // --- detail -------------------------------------------------------------
    {
      id: 'subjectType',
      label: 'Subject',
      priority: 'detail',
      value: (item) => subjectLabel(item.subjectType),
      width: 140,
    },
    {
      id: 'matched',
      label: 'Matched',
      priority: 'detail',
      align: 'right',
      value: (item) => item.totals.matched,
      render: (item) => (
        <Typography variant="body2">{formatCount(item.totals.matched)}</Typography>
      ),
      width: 120,
    },
    {
      id: 'actioned',
      label: 'Actioned',
      priority: 'detail',
      align: 'right',
      value: (item) => item.totals.actioned,
      render: (item) => (
        <Typography variant="body2">{formatCount(item.totals.actioned)}</Typography>
      ),
      width: 120,
    },
  ];
}
