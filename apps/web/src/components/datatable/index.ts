/**
 * DataTable — public entry point.
 *
 * Consumers should import from `components/datatable` only; the `desktop/`
 * (and, from #253, `mobile/`) subfolders are implementation detail.
 */

export { DataTable, useDataTableRenderer } from './DataTable';
export { BulkActionBar } from './BulkActionBar';
export type { BulkActionBarProps } from './BulkActionBar';

export { DesktopGridRenderer, ACTIONS_FIELD } from './desktop/DesktopGridRenderer';
export {
  toGridColDef,
  toGridColumns,
  extractColumnValue,
  buildColumnVisibilityModel,
  DEFAULT_COLUMN_MIN_WIDTH,
} from './desktop/columnAdapter';
export { TruncatedCell, DataTableEmptyOverlay, DataTableLoadingOverlay } from './desktop/cells';
export { RowActionsCell } from './desktop/RowActionsCell';
export type { RowActionsCellProps } from './desktop/RowActionsCell';

export type {
  DataTableColumn,
  DataTableColumnPriority,
  DataTableAlign,
  DataTableSortDirection,
  DataTableSortState,
  DataTableSortConfig,
  DataTablePaginationConfig,
  DataTableSelectionConfig,
  DataTableRowAction,
  DataTableBulkAction,
  DataTableConfirmOptions,
  DataTableProps,
  DataTableRendererProps,
  DataTableRendererMode,
  FilterOperator,
} from './types';
