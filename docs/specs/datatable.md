# DataTable — Shared Column Contract & Renderers

**Status:** foundation shipped (issue #252 of epic #238)
**Location:** `apps/web/src/components/datatable/`
**Spec owner:** frontend

---

## 1. Why this exists

Every table in the web app was hand-rolled. `UserList`, `JobsPage`, the allowlist
table, the shares table, the storage-migration history — each one reimplements
the same six things (header row, cell formatting, pagination footer, selection
checkboxes, a `MoreVert` menu, an empty/loading/error state) with slightly
different behaviour, slightly different accessibility, and no mobile story at
all beyond "scroll sideways and hope".

The DataTable replaces that with **one contract and two renderers**. A page
declares *what* its columns are and *how important* each one is; the renderers
decide how that becomes pixels — a MUI X DataGrid on desktop, a card list on
mobile (issue #253). A column declaration is written once and never edited when
a new renderer, filter UI, or export path arrives.

The contract lives in `types.ts` and is intentionally free of any DataGrid type.
`desktop/columnAdapter.ts` is the only module in the codebase that knows
`GridColDef` exists.

### Scope of this document

This spec documents the contract as of #252. Fields that exist in the contract
but are **not yet consumed** are marked *reserved* and name the issue that will
consume them, so column authors can declare them today without churn later:

| Field / concept              | Consumed by                            |
| ---------------------------- | -------------------------------------- |
| `priority` (card layout half)| #253 — mobile `CardListRenderer`       |
| `filterable`                 | #254 — server-backed filter UI         |
| `hideable`                   | #255 — column visibility / saved views |
| `exportable`                 | #256 — CSV/export + virtualization     |

Everything else on this page is live behaviour today.

---

## 2. File layout

```
apps/web/src/components/datatable/
  index.ts                        # public entry point — import from here
  types.ts                        # THE contract (renderer-agnostic)
  DataTable.tsx                   # renderer-switch shell + shared wrapper
  BulkActionBar.tsx               # selection toolbar (shared by both renderers)
  desktop/
    DesktopGridRenderer.tsx       # MUI X DataGrid renderer
    columnAdapter.ts              # DataTableColumn -> GridColDef
    cells.tsx                     # TruncatedCell + empty/loading overlays
    RowActionsCell.tsx            # per-row icon button / overflow menu
  __tests__/DataTable.test.tsx
```

Consumers import from `components/datatable` only. `desktop/` (and, from #253,
`mobile/`) are implementation detail.

---

## 3. The `priority` pivot

`priority` is the one field that makes a single declaration serve three
different layouts. It expresses **importance**, never geometry — a column author
never writes "hide below 1200px" or "show on mobile".

| `priority`  | Desktop (wide ≥ `lg`) | Desktop (narrow < `lg`) | Mobile card (#253)      |
| ----------- | --------------------- | ----------------------- | ----------------------- |
| `primary`   | visible               | visible                 | card **headline**       |
| `secondary` | visible               | visible                 | card **body**           |
| `detail`    | visible               | **hidden by default**   | card **expandable area**|

The desktop baseline is computed by `buildColumnVisibilityModel(columns, {
hideDetailColumns })`, where `hideDetailColumns` is
`useMediaQuery(theme.breakpoints.down('lg'))`. Issue #255 layers explicit user
overrides and saved views *on top of* this baseline rather than replacing it, so
a fresh table always opens in a sane state.

**Rule of thumb:** one or two `primary` columns (the thing you scan for), the
rest `secondary`, and anything diagnostic (ids, error text, timestamps nobody
reads at a glance) `detail`.

---

## 4. `DataTableColumn<Row>`

```ts
interface DataTableColumn<Row> {
  id: string;
  label: string;
  render?: (row: Row) => ReactNode;
  value?: (row: Row) => string | number | null;
  align?: 'left' | 'center' | 'right';
  priority: 'primary' | 'secondary' | 'detail';
  sortable?: boolean;
  filterable?: boolean | FilterOperator[];
  exportable?: boolean;
  hideable?: boolean;
  truncate?: boolean;
  width?: number;
  minWidth?: number;
  flex?: number;
}
```

### `id` — required

Stable, unique within the table. It is simultaneously the DataGrid `field`, the
sort key sent to the server, and the visibility-model key. **When a column is
sortable, `id` must equal the API's sort parameter value** — the table sends it
verbatim.

### `label` — required

Header text on desktop; field label on the mobile card. Also the accessible name
of the column header.

### `render` vs. `value` — the central distinction

These are two different questions about the same cell and both may be answered:

- **`render(row)` → what the user sees.** Chips, avatars, thumbnails, links,
  relative timestamps, monospace ids. Free-form React.
- **`value(row)` → the scalar behind the cell.** The thing sorting, filtering
  (#254) and export (#256) operate on, and the thing a `truncate` tooltip
  reveals.

| Declared        | Cell shows                    | Sortable / exportable |
| --------------- | ----------------------------- | --------------------- |
| `value` only    | the scalar as text (`—` if null) | yes                |
| `render` only   | the rendered node             | no meaningful scalar  |
| both            | the rendered node             | yes                   |
| neither         | `row[id]` coerced to text     | yes, if the key exists|

**Always declare `value` when a sensible scalar exists**, even alongside
`render`. A `render`-only column is a dead end for every downstream feature.

Fallback coercion when no `value` is declared (`extractColumnValue`): `string`
and `number` pass through, `boolean` → `'true'`/`'false'`, `Date` → ISO string,
`null`/`undefined` → `null`, anything else → `String(raw)`.

### `align`

`'left'` (default), `'center'`, `'right'`. Applied to both the cell and its
header so the column reads as a unit. Use `'right'` for numerics.

### `sortable` — **defaults to `false`**

This is the one place the contract deliberately departs from DataGrid's own
default. Sorting is *always* server-side here: making a header interactive
without the owning page handling `sort.onSortChange` produces a control that
looks live and does nothing. Opt in explicitly, and only for fields the API can
actually order by.

### `filterable` — *reserved (#254)*

`true` enables the default operator set for the column's inferred type; an
array narrows it:

```ts
type FilterOperator =
  | 'equals' | 'contains' | 'startsWith' | 'endsWith'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'before' | 'after'
  | 'in' | 'isEmpty' | 'isNotEmpty';
```

Note that DataGrid's *own* client-side filtering is hard-disabled by the adapter
(`filterable: false` on every `GridColDef`, plus `disableColumnFilter` on the
grid). Client-side filtering would only ever filter the current server page,
which is worse than no filtering at all. #254 builds a server-backed filter UI
against these declarations.

### `exportable` — *reserved (#256)*

Defaults to `true` for any column with a usable scalar. Set `false` to keep a
column out of CSV/export (e.g. a pure-affordance column).

### `hideable` — *reserved (#255)*

`false` pins the column permanently visible in the visibility UI. Default
`true`. Already wired into the `GridColDef` today, so it takes effect the moment
#255 exposes the control.

### `truncate`

Clips the cell to one line with an ellipsis and reveals the full scalar in a
tooltip on hover **or keyboard focus** (the cell is focusable when there is
something to reveal). This is what keeps a table with a `lastError` column
scannable: row heights stay uniform and the long value is one hover away instead
of wrapping into a five-line row.

### `width` / `minWidth` / `flex`

Desktop-only sizing hints, ignored by the card renderer.

- `width: n` — fixed pixel width. Wins over `flex`.
- `flex: n` — grow factor. Default when no `width` is given is `flex: 1`.
- `minWidth: n` — floor while flexing. Defaults to `DEFAULT_COLUMN_MIN_WIDTH`
  (120px).

---

## 5. `DataTableProps<Row>`

```ts
interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  rowId: (row: Row) => string;

  loading?: boolean;
  error?: string | null;
  emptyState?: ReactNode;

  pagination?: DataTablePaginationConfig;
  sort?: DataTableSortConfig;
  selection?: DataTableSelectionConfig;

  rowActions?: DataTableRowAction<Row>[];
  bulkActions?: DataTableBulkAction[];

  density?: 'compact' | 'standard' | 'comfortable';
  ariaLabel?: string;
  height?: number | string;
  renderer?: 'auto' | 'desktop' | 'mobile';
  'data-testid'?: string;
}
```

| Prop         | Notes |
| ------------ | ----- |
| `rows`       | The current page only. The table never holds more than one page. |
| `rowId`      | Must be unique within the page. Usually `(r) => r.id`. |
| `loading`    | Shows the loading overlay. Rows already present stay visible underneath, so a refetch doesn't blank the table. |
| `error`      | Rendered as an `Alert severity="error"` **above** the table; the table still renders beneath it, so a stale page remains readable while the error is shown. |
| `emptyState` | Any node; rendered by the no-rows overlay. Defaults to a plain "No results". |
| `density`    | Maps straight to DataGrid row density. |
| `ariaLabel`  | Accessible name of the grid. Strongly recommended — a table with no name is an unnavigable blob to a screen reader. |
| `height`     | Omit for **auto-height**: the table grows with its rows and the page scrolls vertically. Supply a value to get a fixed-height, internally scrolling table body. |
| `renderer`   | `'auto'` (default) picks by viewport; `'desktop'`/`'mobile'` force one. Until #253, `'mobile'` resolves to the desktop grid. |

### 5.1 Server-side pagination

```ts
interface DataTablePaginationConfig {
  page: number;        // ZERO-BASED (MUI convention)
  pageSize: number;
  total: number;       // total across all pages, from the API's meta
  onPaginationChange: (next: { page: number; pageSize: number }) => void;
  pageSizeOptions?: number[];   // default [10, 25, 50, 100]
}
```

`page` is zero-based to match MUI. **MemoriaHub's APIs are one-based**, so the
owning page converts at the fetch boundary:

```ts
fetchJobs({ page: pagination.page + 1, pageSize: pagination.pageSize });
```

`paginationMode="server"` is hard-wired: the grid never slices `rows`. It draws
exactly what it is handed and reports `total` in the footer. Omitting the
`pagination` prop entirely hides the footer and renders all supplied rows
(capped at the MIT DataGrid's 100-row page limit — use pagination beyond that).

### 5.2 Server-side sorting

```ts
interface DataTableSortConfig {
  sort: { field: string; direction: 'asc' | 'desc' } | null;
  onSortChange: (next: { field: string; direction: 'asc' | 'desc' } | null) => void;
}
```

`sortingMode="server"` is hard-wired. Only one column sorts at a time. Cycling a
header past `desc` emits `null`, meaning "back to the server's default order" —
handle that case rather than treating `null` as "no change".

`sort.field` is a column `id`, sent to the API verbatim.

### 5.3 Selection

```ts
interface DataTableSelectionConfig {
  selectable?: boolean;          // default true when the config is present
  selectedIds: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
}
```

Fully controlled: the table stores no selection state of its own.

**Selection is page-scoped.** Because pagination is server-side, the table only
ever knows the ids on the current page, so "select all" means *all rows on this
page*. This is a real constraint, not an oversight — a cross-page "select all
137 matching" would need a server-side selection token and is out of scope.

Implementation note: MUI X v9 changed `GridRowSelectionModel` to
`{ type: 'include' | 'exclude'; ids: Set<GridRowId> }`. Header select-all is
reported as an **exclude** model (`{ type: 'exclude', ids: ∅ }` = "everything
except nothing"). `DesktopGridRenderer` materialises that against the currently
loaded row ids rather than emitting a model that claims rows it has never seen:

```ts
if (model.type === 'include') onSelectionChange(new Set(model.ids));
else onSelectionChange(new Set(rowIds.filter((id) => !model.ids.has(id))));
```

Clearing the selection (`selectedIds.size === 0`) hides the bulk bar.

### 5.4 Row actions

```ts
interface DataTableRowAction<Row> {
  id: string;
  label: string;
  icon?: ReactNode;
  onClick: (row: Row) => void;
  disabled?: (row: Row) => boolean;
  destructive?: boolean;
  confirm?: boolean | DataTableConfirmOptions<Row>;
}
```

Rendered in a synthetic trailing column (`ACTIONS_FIELD`), which is never
sortable, filterable, or hideable.

- **One action** → a bare `IconButton` with a tooltip and an aria-label of
  `"{label} for {rowLabel}"`. A disabled action keeps its tooltip (the button is
  wrapped in a `span`).
- **Two or more** → a single `MoreVert` button opening a `Menu`. Give each
  action an `icon` here; bare text menu items read poorly.
- `destructive: true` paints the control in the error palette. It does **not**
  by itself add a confirmation step.
- `confirm` adds the confirmation step. `true` uses default copy; an object
  customizes it:

```ts
confirm: {
  title: 'Delete job?',
  description: (row) => `Job ${row.id} will be removed permanently.`,
  confirmLabel: 'Delete',
  cancelLabel: 'Keep',
}
```

There is exactly **one** dialog per table (owned by the renderer), not one per
row — the cell hands the action descriptor back up rather than executing it.

### 5.5 Bulk actions

```ts
interface DataTableBulkAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onClick: (ids: string[]) => void;
  destructive?: boolean;
  disabled?: boolean | ((ids: string[]) => boolean);
}
```

`BulkActionBar` appears directly above the table whenever `selectable` is on and
the selection is non-empty. It shows `"N selected"` in an `aria-live="polite"`
region (so the count is announced as it changes), a **Clear** button, and one
button per bulk action. The bar itself is `role="toolbar"` with
`aria-label="Bulk actions"`.

The bar is renderer-agnostic and is reused verbatim by the mobile card renderer
in #253, so selection UX is identical at every width.

---

## 6. Horizontal containment — non-negotiable

**The document body must never scroll horizontally, at any viewport width.**

Three things enforce this:

1. `DataTable`'s outer wrapper is `width: 100%; max-width: 100%; min-width: 0`.
   `min-width: 0` is the load-bearing one — without it a flex child refuses to
   shrink below its content and pushes the page wide.
2. An inner `data-testid="datatable-scroll-container"` box carries
   `overflow-x: auto` plus the same `max-width` / `min-width` guard. This is the
   designated scroll owner for anything the grid itself doesn't contain.
3. The DataGrid's own `.MuiDataGrid-virtualScroller` keeps `overflow-x: auto`,
   so wide column sets scroll inside the grid body while the header and footer
   stay put.

A page embedding a DataTable inside a flex row must also set `minWidth: 0` on
that flex child — the table cannot fix a parent that refuses to shrink.

---

## 7. Renderer switch

```tsx
export function useDataTableRenderer(mode = 'auto'): 'desktop' | 'mobile' {
  const isNarrow = useMediaQuery(theme.breakpoints.down('md'));
  if (mode !== 'auto') return mode;
  return isNarrow ? 'mobile' : 'desktop';
}
```

The `md` breakpoint (900px) is where a table stops being able to show more than
about two columns without horizontal scrolling — exactly where cards beat rows.

The resolved mode is exposed as `data-renderer` on the wrapper element, which is
both a test hook and a debugging aid. Until #253 lands, `'mobile'` resolves to
`DesktopGridRenderer` through a single named constant (`MOBILE_RENDERER`) — that
constant is the whole seam, and #253's change to this file is one import and one
assignment.

---

## 8. Worked example

A jobs table with all four states, server pagination and sorting, selection with
a bulk retry, and per-row actions including a confirming destructive one:

```tsx
import { useState, useMemo } from 'react';
import { Chip, Box } from '@mui/material';
import { Replay as RetryIcon, Delete as DeleteIcon } from '@mui/icons-material';
import { DataTable, type DataTableColumn } from '../../components/datatable';

export function JobsTable() {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<{ field: string; direction: 'asc' | 'desc' } | null>({
    field: 'createdAt',
    direction: 'desc',
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // page + 1: the API is one-based, the table is zero-based.
  const { jobs, total, isLoading, error, retryJob, retryMany, deleteJob } = useJobs({
    page: page + 1,
    pageSize,
    sortBy: sort?.field,
    sortOrder: sort?.direction,
  });

  const columns = useMemo<DataTableColumn<EnrichmentJobDto>[]>(
    () => [
      {
        id: 'type',
        label: 'Type',
        priority: 'primary',
        sortable: true,
        value: (job) => job.type,
        minWidth: 180,
      },
      {
        id: 'status',
        label: 'Status',
        priority: 'primary',
        sortable: true,
        value: (job) => job.status,                       // scalar for sort/export
        render: (job) => <Chip size="small" label={job.status} />, // what the user sees
        width: 130,
        align: 'center',
      },
      {
        id: 'attempts',
        label: 'Attempts',
        priority: 'secondary',
        align: 'right',
        sortable: true,
        value: (job) => job.attempts,
        width: 100,
      },
      {
        id: 'createdAt',
        label: 'Created',
        priority: 'secondary',
        sortable: true,
        value: (job) => job.createdAt,
        render: (job) => new Date(job.createdAt).toLocaleString(),
        minWidth: 190,
      },
      {
        id: 'lastError',
        label: 'Last error',
        priority: 'detail',      // folds away on a narrow desktop / into the card's expander
        truncate: true,          // one line + tooltip instead of a five-line row
        value: (job) => job.lastError,
        filterable: ['contains', 'isEmpty', 'isNotEmpty'],  // reserved for #254
        flex: 2,
      },
      {
        id: 'id',
        label: 'Job ID',
        priority: 'detail',
        value: (job) => job.id,
        render: (job) => <Box component="code">{job.id.slice(0, 8)}</Box>,
        width: 120,
      },
    ],
    [],
  );

  return (
    <DataTable<EnrichmentJobDto>
      columns={columns}
      rows={jobs}
      rowId={(job) => job.id}
      ariaLabel="Enrichment jobs"
      loading={isLoading}
      error={error}
      emptyState={<span>No jobs match these filters.</span>}
      pagination={{
        page,
        pageSize,
        total,
        onPaginationChange: ({ page: p, pageSize: s }) => {
          setPage(p);
          setPageSize(s);
        },
      }}
      sort={{ sort, onSortChange: setSort }}
      selection={{ selectedIds, onSelectionChange: setSelectedIds }}
      bulkActions={[
        {
          id: 'retry',
          label: 'Retry selected',
          icon: <RetryIcon fontSize="small" />,
          onClick: (ids) => retryMany(ids),
        },
      ]}
      rowActions={[
        {
          id: 'retry',
          label: 'Retry',
          icon: <RetryIcon fontSize="small" />,
          disabled: (job) => job.status === 'running',
          onClick: (job) => retryJob(job.id),
        },
        {
          id: 'delete',
          label: 'Delete',
          icon: <DeleteIcon fontSize="small" />,
          destructive: true,
          disabled: (job) => job.status === 'running',
          confirm: {
            title: 'Delete job?',
            description: (job) => `Job ${job.id.slice(0, 8)} will be removed permanently.`,
          },
          onClick: (job) => deleteJob(job.id),
        },
      ]}
    />
  );
}
```

---

## 9. Testing notes

`apps/web/src/components/datatable/__tests__/DataTable.test.tsx` covers the
rendered shell, the four states, pagination/sort/selection round-trips, row and
bulk actions, the adapter as a unit, and horizontal containment.

jsdom performs no layout, so MUI X's virtualizer measures a 0×0 viewport and
renders zero rows out of the box. The test file installs `installLayoutStubs()`
in `beforeAll`: fixed 800×600 values for `clientWidth`/`offsetWidth`/
`getBoundingClientRect`, plus a `ResizeObserver` whose `observe()` synchronously
invokes the callback with that size. Any future test that renders a DataGrid
needs the same stubs — the project-wide `ResizeObserver` mock in
`src/__tests__/setup.ts` is a no-op and is not sufficient on its own.

Containment is asserted through computed styles (`overflow-x`, `max-width`,
`min-width`) rather than measured geometry, since jsdom reports no real layout.

---

## 10. Migration path

The foundation is additive — no existing table changed in #252. Tables migrate
one at a time, roughly in ascending order of weirdness:

1. `AllowlistTable` — plain columns, pagination, one row action.
2. `UserList` — adds rich cells (avatar, role chips) and a multi-action menu.
3. `JobsPage` — adds server sorting, selection, bulk retry, `detail` columns.
4. The storage-migration, shares, and node tables.

Each migration should delete the hand-rolled `Table`/`TablePagination`/`Menu`
block wholesale rather than wrapping it, and should declare `value` on every
column that has a scalar so the table is ready for #254/#256 without a second
pass.
