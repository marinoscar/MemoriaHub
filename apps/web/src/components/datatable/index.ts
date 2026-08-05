/**
 * DataTable — public entry point.
 *
 * Consumers should import from `components/datatable` only; the `desktop/`,
 * `mobile/` and `shared/` subfolders are implementation detail.
 */

export { DataTable, useDataTableRenderer, rendererForLayout } from './DataTable';
export { BulkActionBar } from './BulkActionBar';
export type { BulkActionBarProps } from './BulkActionBar';

// --- Layout resolution -------------------------------------------------------
export {
  useDataTableLayout,
  useContainerWidth,
  useViewportLayout,
  layoutForWidth,
  DEFAULT_BREAKPOINTS,
  DEFAULT_MOBILE_BREAKPOINT,
  DEFAULT_TABLET_BREAKPOINT,
} from './useContainerLayout';
export type { DataTableBreakpoints } from './useContainerLayout';

// --- Desktop / tablet renderer ----------------------------------------------
export { DesktopGridRenderer, ACTIONS_FIELD } from './desktop/DesktopGridRenderer';
export type { DesktopGridRendererProps } from './desktop/DesktopGridRenderer';
export {
  toGridColDef,
  toGridColumns,
  extractColumnValue,
  formatColumnValue,
  buildColumnVisibilityModel,
  DEFAULT_COLUMN_MIN_WIDTH,
} from './desktop/columnAdapter';
export { TruncatedCell, DataTableEmptyOverlay, DataTableLoadingOverlay } from './desktop/cells';
export { RowActionsCell } from './desktop/RowActionsCell';
export type { RowActionsCellProps } from './desktop/RowActionsCell';
export {
  DetailRowPanel,
  EXPANDER_FIELD,
  detailRowHeight,
  detailRowId,
  isDetailRow,
} from './desktop/detailRow';

// --- Mobile renderer ---------------------------------------------------------
export { CardListRenderer } from './mobile/CardListRenderer';
export { DataCard } from './mobile/DataCard';
export type { DataCardProps } from './mobile/DataCard';
export { CardField, ExpandableValue, columnContent, columnText } from './mobile/CardField';
export { CompactPagination } from './mobile/CompactPagination';
export { CardSortControl } from './mobile/CardSortControl';

// --- Shared ------------------------------------------------------------------
export { useRowActionConfirm, confirmCopy } from './shared/rowActionConfirm';

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
  DataTableLayout,
  DataTableRendererKind,
  FilterOperator,
} from './types';
