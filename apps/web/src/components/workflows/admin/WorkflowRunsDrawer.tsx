/**
 * Admin workflow-runs drawer (issue #143; migrated onto the shared DataTable in
 * issue #261, epic #238).
 *
 * Presentational: the parent owns fetching runs for the selected workflow and
 * the cancel-confirm flow.
 *
 * ## Why this one table proves the container-query work (#253)
 *
 * The drawer is 620px wide on a desktop and its content ~570px after padding —
 * on a 1440px viewport. If the shared component switched layouts on
 * `useMediaQuery` it would render the full desktop grid in here and reintroduce
 * horizontal scrolling on a desktop, which is the exact defect epic #238 exists
 * to remove. It measures its own wrapper instead, so this table resolves to the
 * CARD layout while the oversight table behind the drawer stays a grid. See
 * `./workflowRunsColumns.tsx` and docs/specs/datatable.md §7.2.
 *
 * No `mobileBreakpoint` override is needed or wanted: the default 600px
 * container threshold already produces cards at this drawer's width, and
 * hard-coding a layout here would be the viewport assumption in another form.
 *
 * ## Permission gating is on the ACTION ARRAY
 *
 * `canCancel` (Admin + `jobs:write`) decides whether the Cancel action EXISTS,
 * per docs/specs/datatable.md §13.1 — not whether a rendered button is inert.
 * Whether a given run is terminal, or is the one currently being cancelled, is
 * per-row state and stays a `disabled` predicate.
 */

import { useMemo } from 'react';
import {
  Drawer,
  Box,
  Typography,
  IconButton,
  Alert,
  Divider,
} from '@mui/material';
import { Close as CloseIcon, Stop as StopIcon } from '@mui/icons-material';
import type { AdminWorkflowRun } from '../../../services/adminWorkflows';
import { isTerminalRunStatus } from '../../../utils/workflowFormat';
import { DataTable, type DataTableRowAction } from '../../datatable';
import {
  WORKFLOW_RUNS_TABLE_ID,
  buildWorkflowRunColumns,
} from './workflowRunsColumns';

interface WorkflowRunsDrawerProps {
  open: boolean;
  workflowName: string | null;
  runs: AdminWorkflowRun[];
  loading: boolean;
  error: string | null;
  canCancel: boolean;
  cancellingRunId: string | null;
  onCancel: (run: AdminWorkflowRun) => void;
  onClose: () => void;
}

export function WorkflowRunsDrawer({
  open,
  workflowName,
  runs,
  loading,
  error,
  canCancel,
  cancellingRunId,
  onCancel,
  onClose,
}: WorkflowRunsDrawerProps) {
  const columns = useMemo(() => buildWorkflowRunColumns(), []);

  const rowActions = useMemo<DataTableRowAction<AdminWorkflowRun>[]>(() => {
    if (!canCancel) return [];
    return [
      {
        id: 'cancel',
        label: 'Cancel run',
        icon: <StopIcon fontSize="small" />,
        destructive: true,
        disabled: (run) => isTerminalRunStatus(run.status) || cancellingRunId === run.id,
        onClick: onCancel,
      },
    ];
  }, [canCancel, cancellingRunId, onCancel]);

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{ paper: { sx: { width: { xs: '100%', sm: 620 }, maxWidth: '100%' } } }}
    >
      <Box sx={{ p: 3, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              Run history
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {workflowName ?? 'Workflow'}
            </Typography>
          </Box>
          <IconButton onClick={onClose} aria-label="Close run history">
            <CloseIcon />
          </IconButton>
        </Box>

        <Divider sx={{ mb: 2 }} />

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/*
          Rendered UNCONDITIONALLY: `loading` is a prop, never a gate
          (docs/specs/datatable.md §18.4). The drawer refetches this list after
          every cancel, and swapping the table for a spinner would throw away
          card expansion state and the drawer's scroll offset each time.
        */}
        <DataTable<AdminWorkflowRun>
          columns={columns}
          rows={runs}
          rowId={(run) => run.id}
          tableId={WORKFLOW_RUNS_TABLE_ID}
          ariaLabel="Workflow run history"
          density="compact"
          loading={loading}
          emptyState={<span>No runs for this workflow yet.</span>}
          rowActions={rowActions}
          csvExport={{ filename: 'workflow-runs' }}
        />
      </Box>
    </Drawer>
  );
}
