/**
 * Admin workflow-runs drawer — the DataTable column declaration (issue #261,
 * epic #238).
 *
 * ## This table is the epic's container-query proof case
 *
 * The drawer is 620px wide on a desktop (`slotProps.paper`), which leaves its
 * content ~570px after padding — on a 1440px viewport. A viewport media query
 * would hand that a full desktop grid and it would be unusable; the shared
 * component measures its OWN wrapper with a `ResizeObserver`, so it resolves to
 * the CARD layout here while the same component renders a grid on the page
 * behind the drawer. That is exactly the scenario docs/specs/datatable.md §7.2
 * describes, and `WorkflowRunsDrawer.test.tsx` asserts it with `matchMedia`
 * pinned to 1440px so a `mobile` result can only have come from the container
 * measurement.
 *
 * ## Priorities
 *
 *   - primary   — Run (short id), Status
 *   - secondary — Started, Matched, Actioned, Failed
 *
 * `Run` leads rather than `Status`, even though status is the signal an admin
 * scans for, because the first `primary` column names every per-row control
 * (§17.6) and half a dozen runs of one workflow are routinely all "Running".
 * `Status` is the second primary, so it still lands in the card headline.
 *
 * Nothing is `sortable` (`GET /api/admin/workflow-runs` accepts no `sortBy`)
 * and nothing is `filterable` (the drawer is already scoped to one workflow).
 */

import { Chip, Typography } from '@mui/material';
import type { AdminWorkflowRun } from '../../../services/adminWorkflows';
import {
  runStatusColor,
  runStatusLabel,
  formatRelativeTime,
  formatCount,
} from '../../../utils/workflowFormat';
import type { DataTableColumn } from '../../datatable';

/**
 * Persistence key for the user's column/density choices
 * (`user_settings.dataTables['admin-workflow-runs']`).
 */
export const WORKFLOW_RUNS_TABLE_ID = 'admin-workflow-runs';

/** A run's human handle — the first 8 characters of its id. */
export function shortRunId(id: string): string {
  return id.slice(0, 8);
}

export function buildWorkflowRunColumns(): DataTableColumn<AdminWorkflowRun>[] {
  return [
    // --- primary ------------------------------------------------------------
    {
      id: 'id',
      label: 'Run',
      priority: 'primary',
      value: (run) => shortRunId(run.id),
      render: (run) => (
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {shortRunId(run.id)}
        </Typography>
      ),
      width: 120,
      hideable: false,
    },
    {
      id: 'status',
      label: 'Status',
      priority: 'primary',
      value: (run) => run.status,
      render: (run) => (
        <Chip
          size="small"
          label={runStatusLabel(run.status)}
          color={runStatusColor(run.status)}
          variant="outlined"
        />
      ),
      width: 170,
    },

    // --- secondary ----------------------------------------------------------
    {
      id: 'startedAt',
      label: 'Started',
      priority: 'secondary',
      value: (run) => run.startedAt ?? run.createdAt,
      render: (run) => (
        <Typography variant="caption" color="text.secondary">
          {formatRelativeTime(run.startedAt ?? run.createdAt)}
        </Typography>
      ),
      minWidth: 150,
    },
    {
      id: 'matchedCount',
      label: 'Matched',
      priority: 'secondary',
      align: 'right',
      value: (run) => run.matchedCount,
      render: (run) => <Typography variant="body2">{formatCount(run.matchedCount)}</Typography>,
      width: 110,
    },
    {
      id: 'succeededCount',
      label: 'Actioned',
      priority: 'secondary',
      align: 'right',
      value: (run) => run.succeededCount,
      render: (run) => <Typography variant="body2">{formatCount(run.succeededCount)}</Typography>,
      width: 110,
    },
    {
      id: 'failedCount',
      label: 'Failed',
      priority: 'secondary',
      align: 'right',
      value: (run) => run.failedCount,
      render: (run) => <Typography variant="body2">{formatCount(run.failedCount)}</Typography>,
      width: 110,
    },
  ];
}
