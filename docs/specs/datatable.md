# DataTable — Shared Column Contract & Renderers

**Status:** foundation shipped (issue #252); mobile + tablet layouts shipped (issue #253) — both of epic #238
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

The DataTable replaces that with **one contract, two renderers, three
layouts**. A page declares *what* its columns are and *how important* each one
is; the renderers decide how that becomes pixels — a MUI X DataGrid on desktop,
the same grid with row expansion on a tablet, a card list on a phone. A column
declaration is written once and never edited when a new renderer, filter UI, or
export path arrives.

The contract lives in `types.ts` and is intentionally free of any DataGrid type.
`desktop/columnAdapter.ts` is the only module in the codebase that knows
`GridColDef` exists.

### Scope of this document

This spec documents the contract as of #253. Fields that exist in the contract
but are **not yet consumed** are marked *reserved* and name the issue that will
consume them, so column authors can declare them today without churn later:

| Field / concept              | Consumed by                            |
| ---------------------------- | -------------------------------------- |
| `filterable`                 | #254 — server-backed filter UI         |
| `hideable`                   | #255 — column visibility / saved views |
| `exportable`                 | #256 — CSV/export + virtualization     |

Everything else on this page is live behaviour today. `priority` is now fully
consumed: it drives column visibility on the grid *and* the card's
headline/body/detail split (§3).

---

## 2. File layout

```
apps/web/src/components/datatable/
  index.ts                        # public entry point — import from here
  types.ts                        # THE contract (renderer-agnostic)
  DataTable.tsx                   # layout-switch shell + shared wrapper
  useContainerLayout.ts           # ResizeObserver width -> layout resolution
  BulkActionBar.tsx               # selection toolbar (shared by all layouts)
  shared/
    rowActionConfirm.tsx          # one confirm dialog, shared by both renderers
  desktop/
    DesktopGridRenderer.tsx       # MUI X DataGrid renderer (desktop + tablet)
    columnAdapter.ts              # DataTableColumn -> GridColDef
    cells.tsx                     # TruncatedCell + empty/loading overlays
    RowActionsCell.tsx            # per-row icon button / overflow menu
    detailRow.tsx                 # tablet row expansion (synthetic detail rows)
  mobile/
    CardListRenderer.tsx          # card list renderer
    DataCard.tsx                  # one row, as a card
    CardField.tsx                 # label/value pair + tap-to-expand value
    CardSortControl.tsx           # sort picker (no headers to click on a card)
    CompactPagination.tsx         # prev / range / next
  __tests__/DataTable.test.tsx            # #252 foundation
  __tests__/ResponsiveDataTable.test.tsx  # #253 layouts
```

Consumers import from `components/datatable` only. `desktop/`, `mobile/` and
`shared/` are implementation detail.

---

## 3. The `priority` pivot

`priority` is the one field that makes a single declaration serve three
different layouts. It expresses **importance**, never geometry — a column author
never writes "hide below 1200px" or "show on mobile".

| `priority`  | Desktop (≥ 1200px)  | Tablet (600–1199px)                  | Mobile card (< 600px)          |
| ----------- | ------------------- | ------------------------------------ | ------------------------------ |
| `primary`   | visible column      | visible column                       | card **headline**              |
| `secondary` | visible column      | visible column                       | card **body** (label/value)    |
| `detail`    | visible column      | **hidden**, reachable via row expand | card **"More details"**, closed |

Three consequences worth stating explicitly:

- **A `detail` column is never lost, only folded.** On tablet it moves into an
  expandable row; on a card it moves behind a collapsed region. Hiding a column
  with no route back would be data loss dressed as responsive design.
- **A column's `render` is used verbatim in every layout.** A job's `succeeded`
  chip and a share's preview thumbnail look the same inside a card as inside a
  grid cell. A card is a different *layout*, not a different *vocabulary*.
- **Card order follows priority, then declaration order** — `primary` columns in
  the header (the first one is the card's accessible name), then `secondary`,
  then `detail`. Column order within a priority band is preserved.

The grid's own visibility baseline is computed by
`buildColumnVisibilityModel(columns, { hideDetailColumns })`, where
`hideDetailColumns` is now the resolved layout being `tablet` (§7), not a
viewport media query. Issue #255 layers explicit user overrides and saved views
*on top of* this baseline rather than replacing it, so a fresh table always
opens in a sane state.

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

  renderer?: 'auto' | 'desktop' | 'tablet' | 'mobile';
  mobileBreakpoint?: number;   // container px, default 600
  tabletBreakpoint?: number;   // container px, default 1200

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
| `renderer`   | `'auto'` (default) picks by **container** width; `'desktop'`/`'tablet'`/`'mobile'` force one layout at every width. |
| `mobileBreakpoint` / `tabletBreakpoint` | Per-instance container-width thresholds, in px. See §7. |

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

On the grid the control is the column header. A card has no header, so the card
layout renders `CardSortControl` instead — a field picker over the `sortable`
columns plus a direction toggle (§8.4). Both write the same
`DataTableSortConfig`, so the active sort survives a layout switch in either
direction.

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

The bar is renderer-agnostic and is reused **verbatim** by the mobile card
renderer, so selection UX is identical at every width. The card layout's
select-all checkbox carries the same accessible name as the grid's header
checkbox (`"Select all rows"`) and the same page-scoped semantics, so a test —
or a screen-reader user — meets the same control in both.

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

## 7. Layout switch — container width, not viewport width

### 7.1 The three layouts

| Layout    | Container width | Renderer module               | `data-renderer` | `data-layout` |
| --------- | --------------- | ----------------------------- | --------------- | ------------- |
| `mobile`  | `< 600px`       | `mobile/CardListRenderer`     | `mobile`        | `mobile`      |
| `tablet`  | `600–1199px`    | `desktop/DesktopGridRenderer` (`variant="tablet"`) | `desktop` | `tablet` |
| `desktop` | `≥ 1200px`      | `desktop/DesktopGridRenderer` (`variant="desktop"`) | `desktop` | `desktop` |

Two attributes, not one, because they answer different questions.
`data-renderer` is *which component module drew this* (two values — the seam
#252 left behind); `data-layout` is *which of the three layouts it drew*. Tablet
is a variant of the grid, not a third renderer.

### 7.2 Why the container, not the viewport

The switch measures the table's **own wrapper** with a `ResizeObserver`:

> A DataTable inside the Workflow runs drawer is 400px wide on a 1440px
> desktop. A viewport media query hands that drawer the full desktop grid and it
> is unusable. Container measurement hands it cards, which is correct.

This is issue #261's acceptance case, and it is why a bare `useMediaQuery` is
not sufficient. CSS container queries can't help either: they change how an
already-rendered tree is *styled*, and a card list versus a DataGrid are
genuinely different trees, so the measurement has to reach JavaScript.

**Before the first measurement** (SSR, first paint) the hook falls back to a
viewport `useMediaQuery` using the same thresholds — `down('sm')` → mobile,
`down('lg')` → tablet. On an ordinary page the container and the viewport agree,
so the fallback is right; in a drawer it is wrong for exactly one frame, which
beats being wrong forever or flashing an empty table.

A measured width of **`0` is treated as "not measured yet"**, not as "0px wide".
That is what a `display: none` ancestor, a not-yet-laid-out node, and jsdom's
layout-free DOM all report, and none of them means the table is a phone.

### 7.3 Why 600 and 1200

- **600px (`sm`)** — below this a grid cannot show a headline plus one
  supporting column without horizontal scrolling or unreadable truncation.
- **1200px (`lg`)** — this is *already* the threshold at which `detail` columns
  folded away (#252's `hideDetailColumns`). Reusing it makes the tablet band
  exactly "the widths at which the grid is hiding something", which is exactly
  the band that needs a row expander to make it reachable again.

Both are per-instance overridable, because a host sometimes knows something the
table cannot measure — a chrome-heavy panel, or a table whose cells are
unusually wide:

```tsx
<DataTable {...props} mobileBreakpoint={720} tabletBreakpoint={1440} />
```

### 7.4 State lives above the renderers

Selection, pagination, sort (and, from #254, filters) are **controlled props
owned by the calling page**. No renderer stores any of them. Rotating a device,
dragging a drawer wider, or resizing a window therefore swaps the layout without
losing a single selected id, the current page, or the active sort — the switch
is a pure presentation change.

The only state a renderer owns is which rows/cards are currently expanded, which
is meaningless in the layout being switched to and is deliberately not carried
across.

---

## 8. Mobile layout — the card list

One card per row, built entirely from `priority` (§3). Nothing about a table's
declaration changes to get it.

### 8.1 Card anatomy

```
┌─────────────────────────────────────────────┐
│ [✓]  auto_tagging            FAILED     [⋮] │  header: selection,
│                                             │          primary columns,
├─────────────────────────────────────────────┤          row-actions menu
│ Attempts                                    │
│ 3                                           │  body: secondary columns
├─────────────────────────────────────────────┤        as stacked pairs
│ ⌄ More details                              │  detail: CLOSED by default
└─────────────────────────────────────────────┘
```

Label/value pairs are **stacked**, not side by side: at 320px a two-column field
layout leaves the value ~150px, which recreates on a card the exact truncation
problem cards exist to solve.

The visual language follows the burst/duplicate/location review queues (outlined
`Card`, `body2` / `text.secondary` body text, leading checkbox), which are the
surfaces in this app that already work well on a phone. Both themes are styled;
selection tint and the detail region's background are derived from
`theme.palette.mode`.

### 8.2 Row actions

Row actions collapse into an overflow menu in the **card header — always, even
for a single action** (`RowActionsCell` gains an `alwaysMenu` prop). A header has
room for exactly one trailing control, and an affordance that changes shape
depending on how many actions a page happened to declare is worse than one that
is always the same button.

The menu button is named after the row: `"Row actions for auto_tagging"`, using
the first `primary` column's scalar.

Confirmation is not reimplemented — both renderers call the shared
`useRowActionConfirm()` (`shared/rowActionConfirm.tsx`), so the copy, the
destructive palette, and the one-dialog-per-table rule are identical in both.

### 8.3 Truncation is tap-to-expand

The grid reveals a `truncate` value in a hover tooltip. **A touch device has no
hover**, so on a card the value itself becomes the control: a `ButtonBase`
clamped to two lines that expands in place, with `aria-expanded` and real
Enter/Space activation. The full text is always in the DOM — the clamp is purely
visual, so a value can be folded but never lost.

### 8.4 Pagination and sort

`TablePagination` is the wrong control on a phone: rows-per-page select +
"1–25 of 137" + two arrows comes to roughly 420px of intrinsic width, so on a
360px screen it overflows or forces the table into a horizontal scroller — the
exact failure cards exist to remove. `CompactPagination` replaces it with
prev / range / next. Page size is not adjustable from a card list (nobody sets
100-per-page on a phone); it stays a controlled prop the page can still change.

A card has no column header to click, so sort would otherwise be *held*
correctly across a layout switch but *unreachable* while the card layout is
active. `CardSortControl` fixes that: a field picker listing only
`sortable: true` columns, plus a direction toggle. "Default" emits
`onSortChange(null)`, the contract's "back to the server's own order".

### 8.5 Touch and keyboard rules (hard requirements)

1. **Every interactive element is ≥44px** in both axes (WCAG 2.5.8).
2. **Nothing is hidden with `opacity: 0` while remaining clickable.** This is the
   exact bug filed as issue #243 — a hover-revealed control on `MediaGallery`
   tiles was invisible yet fully tappable on touch, silently starring photos. A
   hover-only affordance must be gated on `@media (hover: hover)` or carry
   `pointer-events: none`. The card layout has **no** hover-revealed
   affordances at all.
   *(MUI's Checkbox puts a transparent native `<input>` exactly on top of a
   painted SVG. That is the opposite pattern — the hit target coincides with a
   visible affordance — and is fine.)*
3. Every collapsible region is a real `button` with `aria-expanded` and
   `aria-controls`, so Enter/Space work without a keydown handler.
4. The card list is a `ul role="list"` labelled with `ariaLabel`; each card is
   an `li`.

---

## 9. Tablet layout — the real grid, with row expansion

The intermediate case, and the one most likely to be skipped. Between 600px and
1200px the grid is still the right control — rows are scannable at 800px in a
way cards are not — but it cannot show every column. So `detail` columns are
hidden **and a leading expander column is added** that reveals them as
label/value pairs in an expanded row.

The switch is deliberately *not* "phone layout or desktop layout at the `sm`
boundary". At 600px you get the grid; at 599px you get cards; at neither width do
you get a grid that has silently dropped a column.

### 9.1 Implementation: synthetic detail rows

MUI X's `getDetailPanelContent` is declared on the community `DataGrid`'s prop
types but is **not implemented** in the MIT package — grep the built package and
its only occurrence is in `propTypes`. It is a Pro feature.

So expansion is built from two primitives the MIT grid *does* implement
(`desktop/detailRow.tsx`):

1. A **synthetic row** is spliced in directly after its parent when that parent
   is expanded, carrying the parent row under namespaced keys
   (`__datatableDetailFor` / `__datatableDetailSource`) that no caller `Row`
   type can collide with. Its grid id is `__datatable_detail__<parentId>`.
2. The expander column declares **`colSpan`** covering every visible column for
   that synthetic row, so one cell renders the whole panel.

Three details make this safe:

- **`paginationMode="server"` never slices `rows`** (`gridPaginationRowRangeSelector`
  short-circuits unless client-side pagination is on), so injecting a row cannot
  push a real row onto a phantom next page.
- **`isRowSelectable`** rejects detail rows, and the grid's `__check__` cell —
  which `colSpan` cannot absorb, since spanning only ever runs *forward* — has
  its checkbox removed with `display: none`, not `opacity: 0`, so it leaves the
  accessibility tree instead of becoming an invisible hit target (§8.5 rule 2).
- **Row height is arithmetic** (`detailRowHeight(fieldCount)`), not
  `getRowHeight: () => 'auto'`. Auto height depends on a measurement pass, and a
  panel that measures 0px in a layout-free environment would clip its own
  content; the panel scrolls internally if a value exceeds the estimate.

No expander column is added when a table declares no `detail` columns — nothing
is hidden, so there is nothing to reach.

### 9.2 Touch target

A tablet is a touch device, and the expander is the *only* route to the hidden
columns, so it gets the same ≥44px target the card layout uses — except at
`density="compact"`, where the row itself is only 36px tall and the button keeps
the grid's own density. Every other control in the grid follows the grid's
density contract, unchanged from #252.

---

## 10. Worked example

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

## 11. Testing notes

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

*(Note that because the layout switch is now container-driven, that file's
800px stub container puts it in the **tablet** layout. It passes unchanged,
which is the point: tablet is a drop-in variant of the same grid.)*

### 11.1 Testing the responsive layouts

`__tests__/ResponsiveDataTable.test.tsx` covers #253 and needs two things the
#252 recipe does not:

1. **A re-fireable `ResizeObserver`.** `installLayoutStubs()` there drives every
   width getter from a module-level `containerWidth`, and keeps a registry of
   live observers so `setContainerWidth(px)` can re-invoke their callbacks
   inside `act()`. That is what makes a *resize* — and therefore
   state-preservation across a layout switch — observable in a test.
2. **A `window.matchMedia` implemented against a FIXED 1440px viewport.** Every
   viewport media query in the tree then answers "desktop", so a `mobile`
   result can only have come from the container measurement. This is what makes
   the drawer assertion (#261) meaningful rather than accidental.

The suite also carries a **regression guard for the issue #243 class of bug**:
it sweeps every painted control (`button`, `[role="button"]`, `.MuiCheckbox-root`,
`a[href]`) and fails, naming the offender, if any is `opacity: 0` while its
`pointer-events` is not `none`. Bare `<input>` and MUI X's own hover-revealed
column-header chrome are excluded, for the reasons given in §8.5.

---

## 12. Migration path

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
