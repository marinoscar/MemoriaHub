/**
 * DataTable — shared column contract.
 *
 * This module is the single public API every table in MemoriaHub is built
 * against. It is deliberately renderer-agnostic: the SAME `DataTableColumn[]`
 * feeds the desktop DataGrid renderer (issue #252, this file's sibling
 * `desktop/`) and the mobile card-list renderer (issue #253), and will feed
 * filtering (#254), column visibility / saved views (#255), and
 * virtualization / export (#256) without any column definition changing.
 *
 * See docs/specs/datatable.md for the full contract documentation.
 */

import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Column-level primitives
// ---------------------------------------------------------------------------

/**
 * Comparison operators a filterable column can advertise.
 *
 * Defined here (rather than in the filtering issue, #254) so column authors can
 * declare `filterable: ['equals', 'contains']` today and have it become live
 * the moment the filter UI ships. Nothing in #252 reads these values.
 */
export type FilterOperator =
  | 'equals'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'before'
  | 'after'
  | 'in'
  | 'isEmpty'
  | 'isNotEmpty';

/**
 * The pivot that drives BOTH renderers from one declaration.
 *
 * - `primary`   — card headline + always-visible desktop column.
 * - `secondary` — card body + visible desktop column.
 * - `detail`    — card expandable region + hidden-by-default on narrow desktop.
 *
 * A column author never writes "show this on mobile" or "hide below 1200px";
 * they state how important the column is and each renderer decides.
 */
export type DataTableColumnPriority = 'primary' | 'secondary' | 'detail';

/** Horizontal alignment of a cell's content (and its header). */
export type DataTableAlign = 'left' | 'center' | 'right';

/** Sort direction used by the controlled server-side sort contract. */
export type DataTableSortDirection = 'asc' | 'desc';

/**
 * One column of a DataTable.
 *
 * `render` and `value` are intentionally separate concerns:
 *   - `render` produces the *visual* cell (chips, avatars, links, thumbnails).
 *   - `value` produces the *scalar* behind the cell — the thing sorting,
 *     filtering and CSV export operate on.
 * A column with only `value` renders that value as text. A column with only
 * `render` has no scalar and therefore cannot be sorted or exported
 * meaningfully; declare `value` too whenever a sensible scalar exists.
 */
export interface DataTableColumn<Row> {
  /**
   * Stable identifier, unique within the table. Doubles as the DataGrid
   * `field` and as the sort field sent to the server, so it should match the
   * API's sort key when the column is sortable.
   */
  id: string;

  /** Human-readable header text (desktop) / field label (mobile card). */
  label: string;

  /** Rich cell renderer. Falls back to the `value` scalar when omitted. */
  render?: (row: Row) => ReactNode;

  /**
   * Scalar extractor — the source of truth for sorting, filtering and export.
   * When omitted, the adapter falls back to `row[id]` if that key exists.
   */
  value?: (row: Row) => string | number | null;

  /** Cell + header alignment. Default `'left'`. */
  align?: DataTableAlign;

  /** Layout importance. Drives both renderers — see {@link DataTableColumnPriority}. */
  priority: DataTableColumnPriority;

  /**
   * Whether the column can be sorted. Default `false`.
   *
   * Sorting is ALWAYS server-side: enabling this only makes the header
   * interactive; the owning page must handle `sort.onSortChange` and refetch.
   * Opt-in (rather than opt-out) because a sortable header that silently does
   * nothing is worse than no header affordance at all.
   */
  sortable?: boolean;

  /**
   * Reserved for #254 (filtering). `true` enables the default operator set for
   * the column's inferred type; an explicit array narrows it.
   */
  filterable?: boolean | FilterOperator[];

  /** Reserved for #256 (export). Default `true` when a `value` extractor exists. */
  exportable?: boolean;

  /**
   * Reserved for #255 (column visibility / saved views). `false` pins the
   * column permanently visible. Default `true`.
   */
  hideable?: boolean;

  /**
   * Long values are clipped with an ellipsis and reveal the full text on
   * hover/focus (tooltip) rather than wrapping and blowing up row height.
   */
  truncate?: boolean;

  /** Desktop sizing hint: fixed pixel width. */
  width?: number;
  /** Desktop sizing hint: minimum pixel width when flexing. */
  minWidth?: number;
  /** Desktop sizing hint: flex grow factor. Mutually exclusive with `width`. */
  flex?: number;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Confirmation copy for a destructive row action. */
export interface DataTableConfirmOptions<Row> {
  title?: string;
  /** Static description, or one derived from the row being acted upon. */
  description?: string | ((row: Row) => string);
  confirmLabel?: string;
  cancelLabel?: string;
}

/** A per-row action rendered in the trailing actions column. */
export interface DataTableRowAction<Row> {
  id: string;
  label: string;
  /** Optional icon element. Required in practice when >1 action (menu items). */
  icon?: ReactNode;
  onClick: (row: Row) => void;
  /** Per-row disabling, e.g. "can't retry a running job". */
  disabled?: (row: Row) => boolean;
  /** Renders in the error palette. Does NOT by itself add a confirmation step. */
  destructive?: boolean;
  /** `true` for default copy, or an object to customize the confirm dialog. */
  confirm?: boolean | DataTableConfirmOptions<Row>;
}

/** An action applied to the current selection, rendered in the bulk bar. */
export interface DataTableBulkAction {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Receives the selected row ids, in insertion order. */
  onClick: (ids: string[]) => void;
  destructive?: boolean;
  disabled?: boolean | ((ids: string[]) => boolean);
}

// ---------------------------------------------------------------------------
// Controlled state contracts (all server-side)
// ---------------------------------------------------------------------------

/**
 * Controlled, server-side pagination. `page` is ZERO-BASED (matching MUI);
 * APIs in this codebase are one-based, so callers convert at the fetch
 * boundary (`page: pagination.page + 1`).
 */
export interface DataTablePaginationConfig {
  page: number;
  pageSize: number;
  /** Total row count across all pages, from the server's `meta.totalItems`. */
  total: number;
  onPaginationChange: (next: { page: number; pageSize: number }) => void;
  /** Default `[10, 25, 50, 100]`. */
  pageSizeOptions?: number[];
}

/** The active sort, or `null` for "server default order". */
export interface DataTableSortState {
  field: string;
  direction: DataTableSortDirection;
}

/** Controlled, server-side sorting. */
export interface DataTableSortConfig {
  sort: DataTableSortState | null;
  onSortChange: (next: DataTableSortState | null) => void;
}

/**
 * Controlled selection.
 *
 * The value is a `Set<string>` of row ids. Selection is page-scoped: because
 * pagination is server-side the table only ever knows about the ids it has
 * loaded, so "select all" means "select every row on this page".
 */
export interface DataTableSelectionConfig {
  /** Default `true` when a selection config is supplied at all. */
  selectable?: boolean;
  selectedIds: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
}

// ---------------------------------------------------------------------------
// Table props
// ---------------------------------------------------------------------------

/**
 * Which renderer to use. `'auto'` (default) picks by viewport width; the
 * explicit values exist for tests, Storybook-style previews, and pages that
 * genuinely want one layout at every width.
 *
 * `'mobile'` resolves to the desktop renderer until issue #253 lands.
 */
export type DataTableRendererMode = 'auto' | 'desktop' | 'mobile';

export interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  /** Stable row identity. Must be unique within the page of rows. */
  rowId: (row: Row) => string;

  /** Shows the loading overlay. Rows already present stay visible beneath it. */
  loading?: boolean;
  /** Error message rendered in an Alert above the table. */
  error?: string | null;
  /** Rendered by the no-rows overlay. Defaults to a plain "No results" message. */
  emptyState?: ReactNode;

  pagination?: DataTablePaginationConfig;
  sort?: DataTableSortConfig;
  selection?: DataTableSelectionConfig;

  rowActions?: DataTableRowAction<Row>[];
  bulkActions?: DataTableBulkAction[];

  /** Row height preset. Default `'standard'`. */
  density?: 'compact' | 'standard' | 'comfortable';
  /** Accessible name for the grid. Strongly recommended. */
  ariaLabel?: string;
  /**
   * Fixed table height. Omit for auto-height (the table grows with its rows and
   * the PAGE scrolls vertically); supply a height to get an internally
   * scrolling table body instead.
   */
  height?: number | string;
  /** Force a renderer. Default `'auto'`. */
  renderer?: DataTableRendererMode;
  /** Forwarded to the outermost wrapper for test targeting. */
  'data-testid'?: string;
}

/**
 * Props handed to a concrete renderer. Identical to {@link DataTableProps}
 * minus the renderer switch itself — every renderer consumes the same contract.
 */
export type DataTableRendererProps<Row> = Omit<DataTableProps<Row>, 'renderer'>;
