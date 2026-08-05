/**
 * DataTable — desktop renderer (MUI X DataGrid).
 *
 * Everything is server-driven: pagination, sorting and the row set all come in
 * as controlled props and every user gesture is reported back out. The grid
 * itself never sorts, filters, or paginates a row — it only draws what it is
 * handed. That is what makes the same contract work against a 150k-item
 * library where client-side anything is off the table.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  DataGrid,
  type GridColDef,
  type GridPaginationModel,
  type GridRowId,
  type GridRowSelectionModel,
  type GridSortModel,
  type GridValidRowModel,
} from '@mui/x-data-grid';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import type { DataTableRendererProps, DataTableRowAction } from '../types';
import { buildColumnVisibilityModel, toGridColumns } from './columnAdapter';
import { DataTableEmptyOverlay, DataTableLoadingOverlay } from './cells';
import { RowActionsCell } from './RowActionsCell';
import { BulkActionBar } from '../BulkActionBar';

/** Field name of the synthetic trailing actions column. */
export const ACTIONS_FIELD = '__datatable_actions__';

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
/** MIT DataGrid caps a page at 100 rows. */
const MAX_UNPAGINATED_ROWS = 100;
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

interface PendingConfirm<Row> {
  action: DataTableRowAction<Row>;
  row: Row;
}

function confirmCopy<Row>(pending: PendingConfirm<Row>) {
  const { action, row } = pending;
  const options = typeof action.confirm === 'object' ? action.confirm : {};
  const description =
    typeof options.description === 'function' ? options.description(row) : options.description;
  return {
    title: options.title ?? `${action.label}?`,
    description:
      description ??
      (action.destructive
        ? 'This action cannot be undone.'
        : `Are you sure you want to ${action.label.toLowerCase()}?`),
    confirmLabel: options.confirmLabel ?? action.label,
    cancelLabel: options.cancelLabel ?? 'Cancel',
  };
}

export function DesktopGridRenderer<Row>({
  columns,
  rows,
  rowId,
  loading = false,
  error = null,
  emptyState,
  pagination,
  sort,
  selection,
  rowActions,
  bulkActions,
  density = 'standard',
  ariaLabel,
  height,
}: DataTableRendererProps<Row>) {
  const theme = useTheme();
  // `detail`-priority columns fold away once the desktop viewport gets tight.
  const hideDetailColumns = useMediaQuery(theme.breakpoints.down('lg'));

  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm<Row> | null>(null);

  const selectable = selection ? (selection.selectable ?? true) : false;
  const selectedIds = selection?.selectedIds ?? EMPTY_SELECTION;

  // --- Rows -----------------------------------------------------------------

  const rowIds = useMemo(() => rows.map((row) => rowId(row)), [rows, rowId]);
  const gridRows = rows as unknown as readonly GridValidRowModel[];
  const getRowId = useCallback((row: GridValidRowModel) => rowId(row as Row), [rowId]);

  // --- Columns --------------------------------------------------------------

  const runAction = useCallback((action: DataTableRowAction<Row>, row: Row) => {
    if (action.confirm) {
      setPendingConfirm({ action, row });
      return;
    }
    action.onClick(row);
  }, []);

  const gridColumns: GridColDef[] = useMemo(() => {
    const mapped = toGridColumns(columns);
    if (!rowActions || rowActions.length === 0) return mapped;

    const actionsColumn: GridColDef = {
      field: ACTIONS_FIELD,
      headerName: 'Actions',
      // Header text is visually redundant next to icon buttons but is what a
      // screen reader announces when navigating cells, so it stays.
      sortable: false,
      filterable: false,
      hideable: false,
      disableColumnMenu: true,
      align: 'right',
      headerAlign: 'right',
      width: rowActions.length === 1 ? 72 : 64,
      renderCell: (params) => (
        <RowActionsCell
          row={params.row as Row}
          actions={rowActions}
          onRun={runAction}
        />
      ),
    };
    return [...mapped, actionsColumn];
  }, [columns, rowActions, runAction]);

  const columnVisibilityModel = useMemo(
    () => buildColumnVisibilityModel(columns, { hideDetailColumns }),
    [columns, hideDetailColumns],
  );

  // --- Pagination (server) --------------------------------------------------

  const paginationModel: GridPaginationModel = useMemo(
    () =>
      pagination
        ? { page: pagination.page, pageSize: pagination.pageSize }
        : { page: 0, pageSize: Math.min(Math.max(rows.length, 1), MAX_UNPAGINATED_ROWS) },
    [pagination, rows.length],
  );

  const handlePaginationModelChange = useCallback(
    (model: GridPaginationModel) => {
      pagination?.onPaginationChange({ page: model.page, pageSize: model.pageSize });
    },
    [pagination],
  );

  // --- Sorting (server) -----------------------------------------------------

  const sortModel: GridSortModel = useMemo(
    () => (sort?.sort ? [{ field: sort.sort.field, sort: sort.sort.direction }] : []),
    [sort],
  );

  const handleSortModelChange = useCallback(
    (model: GridSortModel) => {
      if (!sort) return;
      const next = model[0];
      if (!next || !next.sort) {
        sort.onSortChange(null);
        return;
      }
      sort.onSortChange({ field: next.field, direction: next.sort });
    },
    [sort],
  );

  // --- Selection ------------------------------------------------------------

  const rowSelectionModel: GridRowSelectionModel = useMemo(
    () => ({ type: 'include', ids: new Set<GridRowId>(selectedIds) }),
    [selectedIds],
  );

  const handleRowSelectionModelChange = useCallback(
    (model: GridRowSelectionModel) => {
      if (!selection) return;
      const ids = new Set(Array.from(model.ids, (id) => String(id)));
      if (model.type === 'include') {
        selection.onSelectionChange(ids);
        return;
      }
      // MUI X v9 reports "select all" as an *exclude* model: everything except
      // `ids`. With server-side pagination "everything" can only mean the rows
      // this table has actually loaded, so materialise it against the current
      // page rather than pretending we selected rows we have never seen.
      selection.onSelectionChange(new Set(rowIds.filter((id) => !ids.has(id))));
    },
    [selection, rowIds],
  );

  const clearSelection = useCallback(() => {
    selection?.onSelectionChange(new Set<string>());
  }, [selection]);

  const selectedIdList = useMemo(() => Array.from(selectedIds), [selectedIds]);

  // --- Overlays -------------------------------------------------------------

  const slots = useMemo(
    () => ({
      noRowsOverlay: () => <DataTableEmptyOverlay>{emptyState}</DataTableEmptyOverlay>,
      loadingOverlay: () => <DataTableLoadingOverlay />,
    }),
    [emptyState],
  );

  const confirm = pendingConfirm ? confirmCopy(pendingConfirm) : null;

  return (
    <Box sx={{ width: '100%', maxWidth: '100%', minWidth: 0 }}>
      {error && (
        <Alert severity="error" sx={{ mb: 1 }} data-testid="datatable-error">
          {error}
        </Alert>
      )}

      {selectable && (
        <BulkActionBar ids={selectedIdList} actions={bulkActions} onClear={clearSelection} />
      )}

      {/*
        Non-negotiable: wide content scrolls HERE, never on <body>. The grid
        already owns a horizontal virtual scroller; `minWidth: 0` is what stops
        a flex parent from letting this box grow past the viewport, and
        `overflowX: 'auto'` contains anything the grid itself does not.
      */}
      <Box
        data-testid="datatable-scroll-container"
        sx={{
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          overflowX: 'auto',
          ...(height != null ? { height } : {}),
        }}
      >
        <DataGrid
          rows={gridRows}
          columns={gridColumns}
          getRowId={getRowId}
          loading={loading}
          density={density}
          aria-label={ariaLabel}
          autoHeight={height == null}
          columnVisibilityModel={columnVisibilityModel}
          disableColumnFilter
          disableColumnMenu
          disableRowSelectionOnClick
          // Pagination — server-side.
          paginationMode="server"
          rowCount={pagination?.total ?? rows.length}
          paginationModel={paginationModel}
          onPaginationModelChange={handlePaginationModelChange}
          pageSizeOptions={pagination?.pageSizeOptions ?? DEFAULT_PAGE_SIZE_OPTIONS}
          hideFooter={!pagination}
          // Sorting — server-side.
          sortingMode="server"
          sortModel={sortModel}
          onSortModelChange={handleSortModelChange}
          // Selection.
          checkboxSelection={selectable}
          rowSelectionModel={rowSelectionModel}
          onRowSelectionModelChange={handleRowSelectionModelChange}
          slots={slots}
          sx={{
            minWidth: 0,
            // Keep the grid's own scroller the horizontal scroll owner.
            '& .MuiDataGrid-virtualScroller': { overflowX: 'auto' },
            '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': {
              outlineOffset: -2,
            },
          }}
        />
      </Box>

      <Dialog
        open={Boolean(pendingConfirm)}
        onClose={() => setPendingConfirm(null)}
        aria-labelledby="datatable-confirm-title"
      >
        <DialogTitle id="datatable-confirm-title">{confirm?.title}</DialogTitle>
        <DialogContent>
          <DialogContentText>{confirm?.description}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingConfirm(null)}>{confirm?.cancelLabel}</Button>
          <Button
            variant="contained"
            color={pendingConfirm?.action.destructive ? 'error' : 'primary'}
            onClick={() => {
              if (pendingConfirm) {
                pendingConfirm.action.onClick(pendingConfirm.row);
              }
              setPendingConfirm(null);
            }}
          >
            {confirm?.confirmLabel}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
