# DataTable — Shared Column Contract & Renderers

**Status:** foundation shipped (issue #252); mobile + tablet layouts shipped
(issue #253); filtering + quick search shipped (issue #254); layout persistence
**API half** shipped (issue #255, §14 — web half pending) — all of epic #238
**Location:** `apps/web/src/components/datatable/`,
`apps/api/src/common/schemas/settings.schema.ts` (persistence schema)
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

This spec documents the contract as of #254. Fields that exist in the contract
but are **not yet consumed** are marked *reserved* and name the issue that will
consume them, so column authors can declare them today without churn later:

| Field / concept              | Consumed by                            |
| ---------------------------- | -------------------------------------- |
| `hideable`                   | #255 — column visibility / saved views |
| `exportable`                 | #256 — CSV/export + virtualization     |

§14 documents the **persistence half of #255**, which is shipped: the API can
store a per-user, per-table layout today. The UI that reads and writes it (the
visibility menu, the density switch) is the remaining half.

Everything else on this page is live behaviour today. `priority` is fully
consumed: it drives column visibility on the grid *and* the card's
headline/body/detail split (§3). `filterable` is now live too, together with
its three companions `filterType`, `enumValues` and `searchable` (§10).

---

## 2. File layout

```
apps/web/src/components/datatable/
  index.ts                        # public entry point — import from here
  types.ts                        # THE contract (renderer-agnostic)
  DataTable.tsx                   # layout-switch shell + shared wrapper
  useContainerLayout.ts           # ResizeObserver width -> layout resolution
  BulkActionBar.tsx               # selection toolbar (shared by all layouts)
  filter/
    DataTableFilterBar.tsx        # the filter surface — one shape per layout
    FilterEditor.tsx              # column -> operator -> value form
    FilterChips.tsx               # active filters, removable (wrap / strip)
    QuickSearchField.tsx          # debounced global search box
    operators.ts                  # the operator catalog (pure)
    filterModel.ts                # normalized-model helpers (pure)
    filterUrl.ts                  # <-> URLSearchParams helper (pure, opt-in)
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
  __tests__/DataTableFilters.test.tsx     # #254 filtering + quick search
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
  filterType?: 'text' | 'number' | 'date' | 'enum' | 'boolean';
  enumValues?: { value: string; label: string }[];
  searchable?: boolean;
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

### `filterable` — **defaults to `false`**

Opt-in, for the same reason `sortable` is: filtering is always server-side, so a
filter control the owning page doesn't handle is an affordance that looks live
and does nothing.

`true` enables the default operator set for the column's `filterType`; an
explicit array pins exactly which operators are offered, **in the order given**
(the first is the default operator for a fresh filter on that column):

```ts
filterable: true                                    // the type's default set
filterable: ['contains', 'isEmpty', 'isNotEmpty']   // pinned, in this order
```

Full operator list and per-type defaults: §10.2.

Note that DataGrid's *own* client-side filtering stays hard-disabled by the
adapter (`filterable: false` on every `GridColDef`, plus `disableColumnFilter`
on the grid). Client-side filtering would only ever filter the current server
page, which is worse than no filtering at all — see §10.1.

### `filterType` / `enumValues`

`filterType` declares the kind of value behind the column, which decides both
the operator set offered (§10.2) and the input control drawn for the operand
(§10.3). Default `'text'`. Ignored unless `filterable` is set.

It is **declared, never inferred from the rows.** Inference is unstable in
exactly the cases that matter: an empty page has nothing to infer from, and a
nullable column whose first page happens to be all nulls would silently offer
text operators for a number.

`enumValues` supplies the options for a `filterType: 'enum'` column, as
`{ value, label }` pairs — `value` is what goes into the filter model and the
URL, `label` is what the picker and the chip show. An enum column **with no
`enumValues` is treated as not filterable**: an operator you cannot supply a
value for is the same dead affordance `sortable` refuses.

```ts
{
  id: 'status',
  label: 'Status',
  priority: 'primary',
  value: (job) => job.status,
  filterable: true,
  filterType: 'enum',
  enumValues: [
    { value: 'pending',   label: 'Pending' },
    { value: 'failed',    label: 'Failed' },
  ],
}
```

### `searchable`

Marks the column as covered by the global quick search (§10.4). Purely
declarative: the search term is a single free-text value sent to the server, so
this field documents *which* columns the endpoint's free-text param actually
searches, and is what the default placeholder is built from
(`"Search Type, Status or Last error"`). The table never searches rows.

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

  filters?: DataTableFilterModel;
  onFiltersChange?: (next: DataTableFilterModel) => void;
  quickSearch?: DataTableQuickSearchConfig;

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

### 5.4 Filters and quick search

```ts
filters?: DataTableFilterModel;                        // controlled
onFiltersChange?: (next: DataTableFilterModel) => void;
quickSearch?: DataTableQuickSearchConfig;
```

Both are controlled exactly like pagination and sort, and both are **server-side
only** — the table never filters or searches `rows`. Supplying `filters` +
`onFiltersChange` turns the filter surface on for every layout; supplying
`quickSearch` adds the debounced search box. Full contract in §10.

### 5.5 Row actions

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

### 5.6 Bulk actions

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

Selection, pagination, sort, filters and the quick-search term are all
**controlled props owned by the calling page**. No renderer stores any of them.
Rotating a device, dragging a drawer wider, or resizing a window therefore swaps
the layout without losing a single selected id, the current page, the active
sort, or an applied filter — the switch is a pure presentation change.

The filter surface is drawn by `DataTable` rather than by a renderer for exactly
this reason: it changes *shape* per layout (§10.3), and a renderer owning the
panel's open state would throw it away on every resize.

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

## 10. Filtering and quick search

Two related surfaces, both **controlled by the calling page** and both
**server-side**: per-column filtering (an operator + an operand per column) and
a single global quick-search box.

### 10.1 Why server-side is not a choice

Every target table in this app is server-paginated. A client-side filter can
only ever see the page it has been handed, so filtering 25 loaded rows out of
137 matching rows out of 40 000 total produces an answer that is confidently,
silently wrong — worse than no filter at all, because the user believes it.

Three consequences follow, and they are the shape of the whole feature:

- **The table never touches `rows`.** It emits a new filter model and the page
  refetches. There is a test asserting exactly this — a table handed filters
  that match nothing still draws every row it was given.
- **DataGrid's own filter UI is not used.** `GridFilterPanel` drives the grid's
  client-side filter model, which is the thing we just ruled out; multi-column
  filtering in it is a MUI X **Pro** feature besides. The adapter keeps
  `filterable: false` on every `GridColDef` plus `disableColumnFilter` on the
  grid, and the filter surface here is ours (`filter/`).
- **The model is normalized and endpoint-agnostic.** The component knows nothing
  about `?status=failed` vs `?state[]=failed`; it emits `columnId` /`operator` /
  `value` and the page maps that onto its own params.

### 10.2 The normalized filter model

```ts
type DataTableFilterValue =
  | string | number | boolean       // one operand
  | (string | number)[]             // [from, to] for `between`; a set for `isAnyOf`
  | null;                           // no operand (`isEmpty`), or "not filled in yet"

interface DataTableFilter {
  columnId: string;                 // a column `id`
  operator: FilterOperator;
  value: DataTableFilterValue;
}

type DataTableFilterModel = DataTableFilter[];   // AND-ed, by convention
```

Wired up exactly like pagination and sort:

```tsx
const [filters, setFilters] = useState<DataTableFilterModel>([]);

<DataTable filters={filters} onFiltersChange={setFilters} … />
```

`onFiltersChange` receives the **whole next model** on every add / edit / remove
/ clear — never a delta.

Dates travel as `YYYY-MM-DD` strings rather than `Date` objects, so a model
survives `JSON.stringify`, a URL round trip, and a page reload with no revive
step.

#### Operator sets, by `filterType`

| `filterType` | Operators offered (in order)          |
| ------------ | ------------------------------------- |
| `text`       | `contains`, `equals`, `startsWith`, `isEmpty` |
| `number`     | `equals` (`=`), `gt` (`>`), `lt` (`<`), `between` |
| `date`       | `before`, `after`, `between`          |
| `enum`       | `is`, `isNot`, `isAnyOf`              |
| `boolean`    | `is`                                  |

`FilterOperator` is one exported union covering all of them, plus `endsWith`,
`gte`, `lte`, `in` and `isNotEmpty` — not in any default set, but available to a
column that pins operators explicitly (and published by #252 before the defaults
were narrowed).

Operator **labels are type-aware**: a number column reads `=` / `>` / `<`, every
other type reads them in words (`equals`, `is greater than`). `operatorLabel(op,
filterType)` is the single source of that.

Operator **arity** drives the operand control and the completeness check:

| Arity   | Operators              | Operand           |
| ------- | ---------------------- | ----------------- |
| `0`     | `isEmpty`, `isNotEmpty`| none              |
| `1`     | everything else        | one value         |
| `2`     | `between`              | `[from, to]`      |
| `'many'`| `isAnyOf`, `in`        | a non-empty array |

#### Only complete filters are ever emitted

The editor owns the half-built filter (a column picked, no value typed) as
**local draft state** and emits nothing until `isFilterComplete()` holds. Were
the draft emitted, the very first click of "Add filter" would refetch with a
meaningless param and every keystroke after it would refetch again. The emitted
model — and therefore the chip strip and the URL — always describes a query that
has actually been applied.

Note that `false` and `0` are complete operands. The check is arity- and
type-aware, not a truthiness test.

### 10.3 The filter surface, per layout

Drawn by `DataTable` itself, above whichever renderer is active — not by a
renderer. Filtering is the one control whose *shape* is decided by the layout
rather than by how rows are presented, and a renderer owning the panel's open
state would discard it on every resize (§7.4).

| Layout    | Surface                                                            |
| --------- | ------------------------------------------------------------------ |
| `desktop` | An always-visible filter **row** above the grid: search box, then column → operator → value → **Add**. Active filters wrap below as removable chips. |
| `tablet`  | The same row, collapsed behind a **"Filters" button with an active-count badge**. Chips still show below, unconditionally. |
| `mobile`  | A **full-screen sheet** (MUI `Dialog fullScreen`) holding the stacked form and the active filters. Chips in the bar become a **horizontally scrollable strip**. |

The bar reports its resolved shape as `data-filter-surface` on
`[data-testid="datatable-filter-bar"]`, mirroring `data-layout` on the wrapper.

Three deliberate decisions:

- **The phone gets a sheet, not a squeezed inline row.** A three-control form at
  360px is either unusable or pushes the page sideways — the same failure the
  card list exists to remove. A sheet gets the full screen, a stacked form, and
  a real focus trap. MUI's `Dialog` supplies the trap, the Escape handling and
  the `aria-modal` semantics; hand-rolling a "sheet" is how those get dropped.
- **The phone chip strip is the one correct horizontal scroller.** §6 forbids the
  *document* scrolling sideways because a table overflowed. This is the opposite:
  an explicit, discoverable control that owns its own overflow (`overflow-x:
  auto`, `flex-wrap: nowrap`, `max-width: 100%`) instead of wrapping four chips
  onto four lines above a card list.
- **The count is spoken, not just painted.** The badge bubble is invisible to a
  screen reader, so the button's accessible name is `"Filters (2 active)"` —
  which still contains the visible word "Filters" (WCAG 2.5.3, Label in Name).

Chips are labelled from **labels, not ids or raw values**: `"Status is Failed"`,
not `"status is failed"`. A filter whose column the table no longer declares
(restored from a stale URL after a rename) still renders as a removable chip
using the raw `columnId` rather than crashing the strip.

Every control in the bar — search box, selects, Add, chips, the Filters button,
the sheet's close button — is ≥44px and none is hover-revealed (§8.5).

### 10.4 Quick search — the debounce is on the *emission*

```ts
interface DataTableQuickSearchConfig {
  value: string;
  onChange: (next: string) => void;   // fires ONCE, after the pause
  placeholder?: string;               // default: names the `searchable` columns
  debounceMs?: number;                // default 300
  ariaLabel?: string;                 // default 'Search'
}
```

The `<input>` is driven by local state and repaints on **every keystroke**;
`onChange` — the thing that costs an HTTP round trip — fires once the user pauses
for `debounceMs`. Debouncing the input's *value* instead is the classic version
of this bug: the caret lags a keystroke or two behind the typist on a slow phone.

A page can therefore refetch straight from `onChange` with no debounce of its own.

Two details that make it survive contact with a real page:

- **`onChange` is read through a ref**, so a parent re-rendering with a fresh
  inline arrow does not restart the debounce window. Without that, a busy parent
  can starve the emission indefinitely.
- **An externally-driven `value` change re-seeds the input; our own echo does
  not.** A URL restore or a programmatic clear updates the box; the value coming
  back from the page after our own emission is ignored, so it cannot clobber
  typing already in flight.

Clearing via the ✕ button emits **immediately** — an explicit single gesture has
nothing to debounce, and waiting 300ms to un-filter a table reads as a broken
button.

`searchable: true` on a column is what the default placeholder is built from
(`"Search Type, Status or Last error"`). The term itself is a single free-text
value; which columns the server actually searches is the server's business.

### 10.5 URL addressability

An **opt-in helper**, never wired in automatically — a page that doesn't already
own a `useSearchParams` shouldn't grow a router dependency to render a table.
Same posture the contract takes with pagination and sort.

```ts
import {
  readDataTableUrlState,
  writeDataTableUrlState,
} from '../../components/datatable';

const [searchParams, setSearchParams] = useSearchParams();

// Restore. Pass `columns` so scalars are coerced by each column's filterType.
const { filters, search } = readDataTableUrlState(searchParams, { columns });

// Persist. Returns a COPY; unrelated params (page, tab, …) are untouched.
const onFiltersChange = (next: DataTableFilterModel) =>
  setSearchParams(writeDataTableUrlState(searchParams, { filters: next }), {
    replace: true,
  });
```

Wire format — one repeated `filter` param, plus `q` for the search term:

```
?filter=status:is:failed
&filter=attempts:between:1,5
&filter=lastError:isEmpty
&q=tagging
```

`columnId:operator[:value]`, each segment `encodeURIComponent`-ed so a value
containing `:` or `,` survives, multi-value operands joined with `,`. The
double-encoding a `toString()` produces (`%2520`) is symmetric, so a
`toString()` → `new URLSearchParams()` round trip is lossless.

Nothing in the format says "this is an array" — it doesn't need to, because the
operator already determines the operand's shape. Scalar **type** is the one thing
a URL genuinely cannot carry: `attempts:equals:3` is indistinguishable from a
text `'3'`. Pass `columns` and each value is coerced by its column's
`filterType`; omit them and every scalar comes back a `string`. Always pass them.

An empty model or empty search **removes** its param rather than leaving
`?filter=&q=` behind. A malformed param is dropped silently — a hand-edited URL
should lose one filter, not throw during render.

---

## 11. Worked example

A jobs table with all four states, server pagination and sorting, selection with
a bulk retry, and per-row actions including a confirming destructive one:

```tsx
import { useState, useMemo } from 'react';
import { Chip, Box } from '@mui/material';
import { Replay as RetryIcon, Delete as DeleteIcon } from '@mui/icons-material';
import {
  DataTable,
  type DataTableColumn,
  type DataTableFilterModel,
} from '../../components/datatable';

export function JobsTable() {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<{ field: string; direction: 'asc' | 'desc' } | null>({
    field: 'createdAt',
    direction: 'desc',
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<DataTableFilterModel>([]);
  const [search, setSearch] = useState('');

  // page + 1: the API is one-based, the table is zero-based.
  // `filters` is the normalized model; `toJobQuery` is this page's own mapping
  // onto the endpoint's params (§10.1) — the table knows nothing about it.
  const { jobs, total, isLoading, error, retryJob, retryMany, deleteJob } = useJobs({
    page: page + 1,
    pageSize,
    sortBy: sort?.field,
    sortOrder: sort?.direction,
    q: search,                       // already debounced by the table
    ...toJobQuery(filters),
  });

  const columns = useMemo<DataTableColumn<EnrichmentJobDto>[]>(
    () => [
      {
        id: 'type',
        label: 'Type',
        priority: 'primary',
        sortable: true,
        value: (job) => job.type,
        filterable: true,        // filterType defaults to 'text'
        searchable: true,        // covered by the quick-search term
        minWidth: 180,
      },
      {
        id: 'status',
        label: 'Status',
        priority: 'primary',
        sortable: true,
        value: (job) => job.status,                       // scalar for sort/export
        render: (job) => <Chip size="small" label={job.status} />, // what the user sees
        filterable: true,
        filterType: 'enum',
        enumValues: [
          { value: 'pending', label: 'Pending' },
          { value: 'running', label: 'Running' },
          { value: 'succeeded', label: 'Succeeded' },
          { value: 'failed', label: 'Failed' },
        ],
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
        filterable: true,
        filterType: 'number',    // offers  =  >  <  is between
        width: 100,
      },
      {
        id: 'createdAt',
        label: 'Created',
        priority: 'secondary',
        sortable: true,
        value: (job) => job.createdAt,
        render: (job) => new Date(job.createdAt).toLocaleString(),
        filterable: true,
        filterType: 'date',      // offers  is before / is after / is between
        minWidth: 190,
      },
      {
        id: 'lastError',
        label: 'Last error',
        priority: 'detail',      // folds away on a narrow desktop / into the card's expander
        truncate: true,          // one line + tooltip instead of a five-line row
        value: (job) => job.lastError,
        filterable: ['contains', 'isEmpty', 'isNotEmpty'],  // pinned, in this order
        searchable: true,
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
      filters={filters}
      onFiltersChange={(next) => {
        setFilters(next);
        setPage(0);              // a new filter invalidates the current offset
      }}
      quickSearch={{ value: search, onChange: setSearch }}
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

## 12. Testing notes

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

### 12.1 Testing the responsive layouts

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

### 12.2 Testing filtering and quick search

`__tests__/DataTableFilters.test.tsx` covers #254, reusing the #253 stub recipe
(container-driven width, `matchMedia` pinned to 1440px). Four things in it are
worth copying rather than reinventing:

1. **The operator catalog is tested twice** — once as a pure function
   (`operatorsForColumn` per `filterType`) and once through the UI (open the
   Operator select, read the option names). The pure test pins the contract; the
   UI test proves it is actually wired to the control a user touches.
2. **The debounce is driven with fake timers and `fireEvent.change`.** Three
   changes, then `advanceTimersByTime(299)` → still nothing emitted, then one
   more millisecond → exactly one emission carrying the *final* term. That
   asserts both halves of the contract: the input keeps up, the emission does
   not fire per keystroke.
3. **A negative test for local filtering.** Every positive assertion about
   emitting a model would still pass if the component secretly filtered `rows`,
   so one test hands the table filters matching nothing and asserts all three
   rows still render (§10.1).
4. **The #243 guard is re-run against the filter surface** in all three layouts,
   including inside the opened phone sheet — which lives in a portal, so the
   sweep roots at the dialog rather than at `[data-testid="datatable"]`.

MUI selects are driven through `getByRole('combobox', { name })` +
`getByRole('option', { name })`; the phone sheet through
`getByRole('dialog')`, whose focus trap is asserted by checking that
`document.activeElement` is inside it.

---

## 13. Migration path

The foundation is additive — no existing table changed in #252. Tables migrate
one at a time, roughly in ascending order of weirdness:

1. `AllowlistTable` — plain columns, pagination, one row action.
2. `UserList` — adds rich cells (avatar, role chips) and a multi-action menu.
3. `JobsPage` — adds server sorting, selection, bulk retry, `detail` columns.
4. The storage-migration, shares, and node tables.

Each migration should delete the hand-rolled `Table`/`TablePagination`/`Menu`
block wholesale rather than wrapping it, and should declare `value` on every
column that has a scalar so the table is ready for filtering (§10) and #256
without a second pass, and should declare `filterable` / `filterType` /
`searchable` for the fields its endpoint can actually filter and search on —
replacing that page's bespoke filter controls (JobsPage's Status/Type/Processed
selects, Public Sharing's status tabs) as part of the same migration.

---

## 14. Persistence — `user_settings.dataTables` (#255)

A user's table layout (which columns are shown, how dense the rows are, how they
are sorted, how many rows per page) is **persisted per user, per table**.

### 14.1 Where it lives, and what it deliberately is not

It is a small blob inside the **existing** `user_settings` JSONB row, under a new
`dataTables` namespace. That is the whole storage design:

- **no new endpoint** — it is read by `GET /api/user-settings` and written by
  `PATCH` / `PUT /api/user-settings`, exactly like `theme` and `profile`;
- **no new table** and **no migration** — the namespace is optional, and absent
  is the correct state for every existing user, so there is nothing to backfill;
- **no new RBAC permission** — the existing `user_settings:read` /
  `user_settings:write` already scope it, and a layout preference is by
  definition only ever about the calling user.

A layout preference is not domain data. It has no cross-user query, no
aggregation, no audit requirement and no lifecycle of its own — it is read once
when a page mounts and written when the user flips a switch. A dedicated table
would buy nothing and cost a migration, a service, and a second write path.

### 14.2 Shape

```ts
dataTables?: {
  [tableId: string]: {
    visibleColumns?: string[];
    density?: 'compact' | 'standard' | 'comfortable';
    sort?: { field: string; direction: 'asc' | 'desc' };
    pageSize?: number;
  };
}
```

`tableId` is the stable id of the table instance (`'jobs'`,
`'admin-shares'`, …), chosen by the page and never derived from a route or a
label. `visibleColumns` and `sort.field` hold **column ids** — the same `id`
from `DataTableColumn` (§4), which is already the DataGrid field, the server
sort key, and the visibility-model key.

The canonical Zod definition is `dataTablesSchema` in
`apps/api/src/common/schemas/settings.schema.ts`, imported by the PUT, PATCH and
response DTOs rather than copied into each — the bounds in §14.4 are a security
control and four hand-maintained copies of them would drift.

### 14.3 The absent-key rule — and why it is load-bearing

**Every key is optional, and the API never fills one in.** An absent
`dataTables`, an absent entry, or an absent field inside an entry all mean the
same thing: *fall back to the contract-derived default* — the
`buildColumnVisibilityModel(columns, …)` baseline for `visibleColumns` (§3), the
component defaults for the rest. Persisted state **layers on top of** that
baseline; it never replaces it.

This is the difference between a feature and a bug:

> If `visibleColumns` defaulted to `[]` (or an entry defaulted to `{}` with a
> materialized column list), then the first time a user so much as opened the
> density menu on a table, that table's column set would be **frozen at the
> columns that existed on that day**. Every column added later would be
> silently hidden — from that user only, forever, with no error and nothing in
> the UI to explain it. The bug would surface months later as "the new
> `lastError` column doesn't show up for me".

So the schema has **no `.default()` anywhere in this namespace**, and the
service returns stored entries verbatim, absences included. `visibleColumns: []`
sent explicitly by a client is still legal and still means "hide everything" —
the rule is only that the *server* must never invent it. This is regression-
tested directly (`update-user-settings.dto.spec.ts` →
`"should NOT materialize visibleColumns as [] for an entry that omits it"`).

The corollary for the web half: resolve a stored `visibleColumns` against the
**current** column list at render time. A stored id for a column that no longer
exists is ignored, not an error.

### 14.4 Bounds

The namespace is user-controlled, unvalidated-key JSON inside a row the user can
write freely — i.e. exactly the shape of an accidental free storage service.
Every axis is therefore capped:

| Bound | Value | Rationale |
| ----- | ----- | --------- |
| Table ids per user (`DATA_TABLE_MAX_TABLES`) | **40** | Comfortably above the ~10 tables the app has, and above any plausible near-term growth. |
| `tableId` pattern (`DATA_TABLE_ID_PATTERN`) | `/^[a-z0-9][a-z0-9_-]*$/` | Lowercase alphanumeric plus `-`/`_`, starting alphanumeric. Keeps keys id-shaped, not free text. |
| `tableId` length (`DATA_TABLE_MAX_ID_LENGTH`) | **64** | Same cap applied to every column id and to `sort.field`. |
| `visibleColumns` entries (`DATA_TABLE_MAX_VISIBLE_COLUMNS`) | **60** | The widest table in the app declares well under 20 columns. |
| `pageSize` | integer **1–500** | Covers the `[10, 25, 50, 100]` default options (§5.1) with headroom, and stays inside the range the list endpoints themselves accept. |
| Unknown keys inside an entry | **rejected** (`.strict()`) | An entry is a closed contract, not a scratch pad. A typo (`desnity`) fails loudly with a 400 instead of being silently persisted or silently dropped. |

Worst case per user is therefore ~160 KB of JSON, and every dimension is a hard
`400` rather than a truncation.

### 14.5 PATCH semantics — merge granularity

`PATCH /api/user-settings` merges `dataTables` **per table id, one level deep**
(`UserSettingsService.mergeDataTables`):

| Patch payload | Effect |
| ------------- | ------ |
| table id absent from the patch | stored entry untouched — **patching one table never clobbers another** |
| `{ jobs: { pageSize: 100 } }` | the `jobs` entry is **replaced wholesale** (its previous `density`/`sort`/`visibleColumns` are gone) |
| `{ jobs: {} }` | `jobs` resets to defaults — every sub-key becomes absent again |
| `{ jobs: null }` | the `jobs` entry is **deleted** (JSON Merge Patch), freeing its slot against the 40-table cap |
| `dataTables` omitted entirely | the whole stored namespace is untouched |

Entry-level replace (rather than a deep per-field merge) is the deliberate
choice, and it matches the whole-object semantics `search` already has. A deep
merge would make "reset this table" inexpressible: with no way to *un*-set a
field, a user who once pinned `visibleColumns` could never get back to the
contract defaults, which is precisely the state §14.3 exists to protect. The
cost — a client must send the entry it wants, not a delta — is trivial, since
the client holds the full resolved layout in state anyway.

Two further notes:

- When the merge empties the namespace, it collapses back to **absent** rather
  than storing `{}`. Absent is the canonical "nothing persisted" state.
- The 40-table cap is re-checked **after** the merge, in the service, and raises
  a `BadRequestException`. A single-entry patch is under the payload cap but can
  still push a full namespace over the real one; enforcing it only in Zod would
  surface that as a raw `ZodError` → 500.

`PUT` is a full replacement as usual: omitting `dataTables` clears it.

### 14.6 Tests

- `apps/api/src/settings/dto/update-user-settings.dto.spec.ts` — schema: the
  absent-key rule, every bound in §14.4, the `tableId` pattern, `null` accepted
  on PATCH and rejected on PUT.
- `apps/api/src/settings/user-settings/user-settings.service.spec.ts` — merge
  semantics in §14.5, including the post-merge cap.
- `apps/api/test/settings/user-settings.integration.spec.ts` — the same through
  real HTTP: round-trip via PUT and PATCH, non-clobbering, and each rejection as
  a `400`.
