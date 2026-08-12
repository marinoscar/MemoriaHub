/**
 * Workflows oversight table (issue #143; migrated onto the shared DataTable in
 * issue #261, epic #238).
 *
 * Every workflow across all circles. Still props-driven for testability: the
 * parent owns fetching, pagination state, and the row-action handlers.
 *
 * What #261 replaced: a hand-rolled nine-column `<Table>` inside a
 * `<TableContainer sx={{ overflowX: 'auto' }}>` plus a `<TablePagination>`
 * footer — i.e. the pattern where a desktop-shaped grid is made "responsive" by
 * letting it scroll sideways. It is now one `DataTableColumn[]`
 * (`./workflowsOversightColumns.tsx`) rendered by the shared component, which
 * picks grid-vs-cards from ITS OWN CONTAINER width (§7.2). That matters here
 * even on a desktop: this table sits inside a `Container maxWidth="lg"` card, so
 * its container is ~1050px and it resolves to the tablet layout — the three
 * `detail` columns fold into a row expander rather than being squeezed.
 *
 * ## Permission gating is on the ACTION ARRAY, not on a rendered control
 *
 * The pre-migration table always rendered a "Disable" button and merely
 * disabled it when the caller lacked `system_settings:write`. Per
 * docs/specs/datatable.md §13.1 (#260) a permission gate belongs on the array,
 * so an action a caller may not perform is absent from the DOM in every
 * renderer at once rather than present-but-inert in one of them. `canManage`
 * therefore decides whether the action EXISTS; whether the workflow is already
 * disabled is per-row state and stays a `disabled` predicate (#259's rule).
 */

import { Card, CardContent, Typography } from '@mui/material';
import BlockIcon from '@mui/icons-material/Block';
import HistoryIcon from '@mui/icons-material/History';
import { useMemo } from 'react';
import type { AdminWorkflowListItem } from '../../../services/adminWorkflows';
import { DataTable, type DataTableRowAction } from '../../datatable';
import {
  WORKFLOWS_OVERSIGHT_TABLE_ID,
  buildWorkflowOversightColumns,
} from './workflowsOversightColumns';

interface WorkflowsOversightTableProps {
  items: AdminWorkflowListItem[];
  loading: boolean;
  totalItems: number;
  page: number; // zero-based (MUI convention)
  pageSize: number;
  canManage: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onDisable: (item: AdminWorkflowListItem) => void;
  onViewRuns: (item: AdminWorkflowListItem) => void;
}

export function WorkflowsOversightTable({
  items,
  loading,
  totalItems,
  page,
  pageSize,
  canManage,
  onPageChange,
  onPageSizeChange,
  onDisable,
  onViewRuns,
}: WorkflowsOversightTableProps) {
  const columns = useMemo(() => buildWorkflowOversightColumns(), []);

  const rowActions = useMemo<DataTableRowAction<AdminWorkflowListItem>[]>(() => {
    const actions: DataTableRowAction<AdminWorkflowListItem>[] = [
      {
        id: 'runs',
        label: 'Runs',
        icon: <HistoryIcon fontSize="small" />,
        onClick: onViewRuns,
      },
    ];
    // Absent, not disabled, without the permission — see the module docblock.
    if (canManage) {
      actions.push({
        id: 'disable',
        label: 'Disable',
        icon: <BlockIcon fontSize="small" />,
        destructive: true,
        // Per-ROW state, which is what `disabled` is for: the control stays
        // discoverable on an already-disabled workflow instead of vanishing.
        disabled: (item) => !item.enabled,
        onClick: onDisable,
      });
    }
    return actions;
  }, [canManage, onDisable, onViewRuns]);

  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }}>
      <CardContent sx={{ p: 3 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 0.5 }}>
          All workflows
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
          Every workflow across all circles, newest first.
        </Typography>

        {/*
          Rendered UNCONDITIONALLY: `loading` is a prop, never a gate. Swapping
          the table out for a spinner unmounts the renderer and takes row/card
          expansion state (and the page's scroll offset) with it —
          docs/specs/datatable.md §18.4.
        */}
        <DataTable<AdminWorkflowListItem>
          columns={columns}
          rows={items}
          rowId={(item) => item.id}
          tableId={WORKFLOWS_OVERSIGHT_TABLE_ID}
          ariaLabel="All workflows"
          density="compact"
          loading={loading}
          emptyState={<span>No workflows found.</span>}
          pagination={{
            page,
            pageSize,
            total: totalItems,
            // The parent keeps `page` and `pageSize` as two separate setters,
            // and its `onPageSizeChange` already resets the offset — so a
            // size change must NOT also emit a page change, or the two would
            // race and the reset would be clobbered.
            onPaginationChange: ({ page: nextPage, pageSize: nextPageSize }) => {
              if (nextPageSize !== pageSize) {
                onPageSizeChange(nextPageSize);
                return;
              }
              if (nextPage !== page) onPageChange(nextPage);
            },
            pageSizeOptions: [10, 25, 50],
          }}
          rowActions={rowActions}
          csvExport={{ filename: 'workflows' }}
        />
      </CardContent>
    </Card>
  );
}
