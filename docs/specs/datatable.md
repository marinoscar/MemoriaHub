# DataTable — Shared Column Contract & Renderers

**Status:** foundation shipped (issue #252); mobile + tablet layouts shipped
(issue #253); filtering + quick search shipped (issue #254); column visibility,
density and per-user layout persistence shipped (issue #255, §14–§15); row
virtualization + CSV export shipped (issue #256, §16); accessibility contract,
keyboard model and the shared conformance suite shipped (issue #257, §17);
pilot migration — Job Queue — shipped, adding `filterOnly` to the contract
(issue #258, §18); identity-and-access tables (Users, Allowlist, Personal Access
Tokens, Circle members/invites) migrated, establishing the `exportable: false`
secret-material rule and the gate-the-action-array rule (issue #260, §13.1) —
all of epic #238
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

This spec documents the contract as of #256. **Every field in the contract is
now live** — nothing is reserved any more.

§14 documents the storage contract for #255 (what the API accepts and how it
merges); §15 documents the client half (the `tableId` prop, the picker and
density surfaces, the resolution rules, and the write discipline); §16 documents
virtualization and CSV export (#256), including what was deliberately *not*
built.

`priority` drives column visibility on the grid *and* the card's
headline/body/detail split (§3). `filterable` is live together with its three
companions `filterType`, `enumValues` and `searchable` (§10), `hideable` is
consumed by the column picker (§15.2), and `exportable` is consumed by the CSV
writer (§16.4).

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
  layout/
    layoutModel.ts                # stored shape, encoding, resolution (pure)
    useDataTableLayoutPrefs.ts    # load / debounced fire-and-forget write
    DataTableViewBar.tsx          # column picker + density (+ export slot)
  export/
    csv.ts                        # escaping, formula neutralization, BOM (pure)
    exportModel.ts                # columns -> matrix -> file; the all-rows walk
    DataTableExportControl.tsx    # the control — one shape per layout
  virtualization/
    gridVirtualization.ts         # autoHeight-vs-viewport decision (pure)
    cardVirtualization.ts         # content-visibility + measured placeholders
  shared/
    rowActionConfirm.tsx          # one confirm dialog, shared by both renderers
    IndeterminateCheckbox.tsx     # indeterminate checkbox with the native DOM
                                   # property actually set (#257, §17.7)
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
  __tests__/DataTableLayoutPrefs.test.tsx # #255 visibility / density / persistence
  __tests__/DataTableExport.test.tsx      # #256 CSV export + virtualization
  __tests__/DataTableConformance.test.tsx # #257 — invokes the shared suite below
  __tests__/DataTableContrast.test.tsx    # #257 — WCAG contrast, computed against the real theme
  __tests__/conformance/
    runDataTableConformanceSuite.tsx      # #257 — THE reusable suite; see §17.8
  __tests__/testUtils/
    layoutStubs.ts                        # #257 — the jsdom container-width/ResizeObserver
                                           # recipe, extracted to one shared module
    a11yGuards.ts                         # #257 — the issue #243 "invisible but
                                           # tappable" sweep, consolidated to one module
    contrast.ts                           # #257 — pure WCAG contrast-ratio calculator
                                           # + its own unit tests (contrast.test.ts)
```

Consumers import from `components/datatable` only. `desktop/`, `mobile/`,
`layout/` and `shared/` are implementation detail.

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
`buildColumnVisibilityModel(columns, { hideDetailColumns, visibleColumns })`,
where `hideDetailColumns` is the resolved layout being `tablet` (§7), not a
viewport media query. The user's persisted choice (#255) is AND-ed with that
baseline rather than replacing it (§15.3), so a fresh table always opens in a
sane state and the tablet fold survives a layout stored on a desktop.

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
  filterOnly?: boolean;          // a filter with no cell — §18.1
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

### `filterOnly`

A filter that has no cell. The column feeds the filter surface and **nothing
else** — it is never drawn as a grid column or a card field, never offered in
the column picker, and never written to a CSV export. `priority` (still
required), `align`, `truncate` and the sizing hints are ignored.

This exists because an endpoint's query parameters are not always a subset of
its response's fields: `GET /api/admin/jobs` accepts `processedWithin`, a window
over `COALESCE(finishedAt, createdAt)` that is no single field a row carries.
Full rationale, and the one-seam implementation, in §18.1.

### `searchable`

Marks the column as covered by the global quick search (§10.4). Purely
declarative: the search term is a single free-text value sent to the server, so
this field documents *which* columns the endpoint's free-text param actually
searches, and is what the default placeholder is built from
(`"Search Type, Status or Last error"`). The table never searches rows.

### `exportable`

Default `true`. `false` keeps the column out of every CSV export — a
pure-affordance column, or one carrying material that must never leave the app
(a share token, PAT material). Export always writes the `value` scalar, never
the rendered node, so a `render`-only column exports empty cells. Full contract:
§16.4.

### `hideable`

`false` pins the column permanently visible and keeps it **out of the column
picker entirely** — a checkbox that cannot change anything is worse than no
checkbox. Default `true`. Also wired into the `GridColDef`. See §15.2.

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

  csvExport?: DataTableExportConfig<Row>;  // filename / all-rows fetch (§16)
  disableExport?: boolean;                 // removes the export control (§16.4)

  tableId?: string;            // turns on per-user layout persistence (§15)
  density?: DataTableDensity;  // 'compact' | 'standard' | 'comfortable'
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
| `csvExport`  | Optional. Every table exports its current page without configuration; this names the file and/or adds the "all matching rows" option by handing the table the page's own fetch callback (§16.5). |
| `disableExport` | Removes the export control from every layout. For a table that owns a bespoke export of its own — the Tags page's CSV vocabulary round trip (#259). |
| `tableId`    | Stable id of this table instance. Supplying it persists the layout per user (§15); omitting it keeps every control working but session-scoped. |
| `density`    | The page's **default** row-density preset, not a lock — a user's own choice overrides it. Maps onto DataGrid row density in the grid and onto card padding in the card list (§15.4). |
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
one at a time.

The **pilot is `JobsPage`** (#258, §18) — deliberately not the easiest table but
the worst-affected one, so the contract met its hardest case before fifteen
pages depended on it. It found one real gap (`filterOnly`, §18.1) and produced
three rules every later migration should follow (§18.2–§18.4).

**Migrated so far:**

| Table | `tableId` | Columns module | Issue |
| ----- | --------- | -------------- | ----- |
| Job Queue | `admin-jobs` | `pages/Admin/jobsTable.tsx` | #258 (pilot) |
| Users | `admin-users` | `components/admin/usersTable.tsx` | #260 |
| Allowlist | `admin-allowlist` | `components/admin/allowlistColumns.tsx` | #260 |
| Personal Access Tokens | `settings-pats` | `components/settings/patTable.tsx` | #260 |
| Circle members / invites | `circle-members` / `circle-invites` | `pages/Circles/circleMembersTable.tsx` | #260 |
| Public Sharing | `admin-shares` | `pages/Admin/sharesTable.tsx` | #259 |
| Job Insights (per-type) | `admin-job-insights` | `pages/Admin/jobInsightsTable.tsx` | #259 |
| Worker nodes / node credentials | `admin-nodes` / `admin-node-credentials` | `pages/Admin/workersTable.tsx` | #259 |
| Storage providers / migration runs | `admin-storage-providers` / `admin-storage-migrations` | `pages/Admin/storageProvidersTable.tsx` | #259 |
| Backup runs | `admin-backup-runs` | `pages/Admin/backupTable.tsx` | #259 |
| Tag vocabulary | `admin-tag-labels` | `pages/Admin/tagsTable.tsx` | #259 |

Still to come: the remaining media surfaces.

### 13.1 Decisions from the admin-operations batch (#259)

Six surfaces at once, and five of them settled a question the pilot had not:

- **A quick-filter preset can BE the filter model.** Public Sharing keeps its
  All / Active / Expired / Revoked tab strip, but the tabs now write into the
  table's own `filters` model and read the active tab back out of it
  (`statusFromFilters` / `withStatusFilter`). The `status` column deliberately
  declares **no `filterable`**, so the generic "Add filter" picker never offers a
  second control for the same param — and because `filters` is controlled, the
  chip the tabs produce is removable, which returns the strip to "All". One
  model, one source of truth, two entry points.
- **`exportable: false` is for material, not just secrets.** The share
  `publicUrl` column renders truncated with an explicit copy button and is kept
  out of every CSV: the token in it is a bearer credential for the media behind
  it (§16.6). The masked `••••••••last4` on Storage Providers is excluded on the
  same reasoning even though it is already redacted.
- **Declare a row-unique `primary` column, or every control is called the same
  thing.** Public Sharing's natural leading column was Type — which reads
  "Photo" on twenty consecutive rows, and therefore names twenty checkboxes
  "Select Photo" (§17.6). It leads with a short share id instead. Worth checking
  on any table whose obvious headline is a category rather than an identity.
- **A per-row `disabled` replaces "render nothing".** The old node-credentials
  table hid its revoke button on an already-revoked row. The contract has no
  per-row hide, and does not need one: `disabled: (row) => …` keeps the control
  (and its tooltip) discoverable instead of silently vanishing.
- **Client-side pagination is legal; client-side FILTERING is not.** Tag labels
  and the per-type job-insights rows arrive in one unpaginated response, so the
  *page* slices them and hands the table one page. That respects §5.1 exactly —
  the table still never slices `rows` — while keeping the vocabulary under the
  MIT DataGrid's 100-row page ceiling. The §10.1 prohibition is about filtering a
  server-paginated result, which neither of these is.
- **`disableExport` earns its keep.** Tags keeps the bespoke
  `GET /api/tag-labels/export` ⇄ `POST /api/tag-labels/import` round trip: the
  exported file carries the `id` column the importer needs, so a generic
  visibility-shaped CSV would look like the same file and silently fail to
  re-import.
- **An editable cell is a card-layout problem.** Tags' inline row edit (a
  `TextField` spliced into the name cell) has no card equivalent, so it became a
  rename dialog; its `window.confirm` delete became the row action's own
  `confirm`. Storage Providers went further: the three stacked credential CARDS
  became one table plus a per-row "Configure…" dialog holding the same form and
  the same save / test / remove calls.
- **MUI gotcha, worth one line:** `<Switch aria-label="…">` puts the label on
  the wrapper span, not on the `role="switch"` input, leaving the control
  nameless to assistive tech. Use
  `slotProps={{ input: { 'aria-label': … } }}` for a switch rendered inside a
  cell.

Each migration should delete the hand-rolled `Table`/`TablePagination`/`Menu`
block wholesale rather than wrapping it, and should declare `value` on every
column that has a scalar so the table is ready for filtering (§10) and #256
without a second pass, and should declare `filterable` / `filterType` /
`searchable` for the fields its endpoint can actually filter and search on —
replacing that page's bespoke filter controls (JobsPage's Status/Type/Processed
selects, Public Sharing's status tabs) as part of the same migration.

### 13.1 Two invariants the identity-and-access group (#260) established

Both apply to every later migration, not just to those four tables.

**Secret material declares `exportable: false`.** CSV export writes a column's
`value` scalar for every row on the page (§16.4), and a downloaded file outlives
the session that produced it. A column carrying token material — a PAT prefix, a
share token, a node credential, an API key — therefore opts out of export
explicitly, even when the value on screen is already masked. §16.6 is why this is
a *narrowing* control rather than the only barrier: an export can never reach a
field the list response did not already contain, so forgetting the flag leaks
nothing new, but the flag is what keeps material the user can see from becoming
material the user can forward. `settings-pats` sets it on `tokenPrefix`.

**A permission gate belongs on the action ARRAY, never on a rendered control.**
The pre-migration pages hid a whole `<TableCell>` or swapped a `<Select>` for
text when the caller lacked a permission — a grid-shaped gate that a card
renderer would have had to reimplement, and therefore could quietly have got
wrong. Build `rowActions` from the caller's permissions (and gate an inline
editor inside the column's `render`, which every renderer uses verbatim, §3), and
the gate holds in the grid, in the tablet row expander and on a phone card at
once. An action a caller may not perform is then absent from the DOM entirely
rather than merely off-screen. Each migrated surface's tests assert this in
*both* renderers.

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
exists is ignored, not an error — and a column added *after* the layout was
stored resolves to its default rather than to hidden. §15.3 documents how the
client encodes the extra bit that second rule needs.

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

---

## 15. Column visibility, density, and the client half of persistence (#255)

§14 is what the server stores. This section is what the browser does with it:
the `tableId` prop, the two controls, the rules that turn a stored blob plus the
current column list into pixels, and the write discipline.

Everything here lives in `apps/web/src/components/datatable/layout/`:
`layoutModel.ts` (pure), `useDataTableLayoutPrefs.ts` (state + network) and
`DataTableViewBar.tsx` (the controls).

### 15.1 `tableId` — the whole opt-in

```tsx
<DataTable {...props} tableId="jobs" />
```

One new prop. Supplying it turns on persistence; **omitting it makes
persistence inert** — no `GET`, no `PATCH` — while the picker and the density
toggle keep working for the session. The controls are a UI feature; only the
*backup* is opt-in.

`tableId` is chosen by the page and never derived from a route or a heading. It
is the storage key, so it has to survive a rename, a URL change and a
re-mount. It must match the API's `/^[a-z0-9][a-z0-9_-]*$/` (§14.4).

Nothing else changes for a calling page: sort and pagination stay controlled
props, and the table restores a stored value by handing it back through the
page's own `onSortChange` / `onPaginationChange` rather than keeping a second
copy of state the page already owns.

### 15.2 The surfaces, per layout

Drawn by `DataTable` itself, above the filter bar, for the same reason the
filter bar is (§7.4 / §10.3): the *shape* of these controls is decided by the
layout, and a renderer owning the menu's open state would discard it on every
resize.

| Layout    | Surface                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `desktop` | An inline density toggle (3 icon buttons) + a **"Columns" button opening a menu** of checkboxes, ending in "Reset to defaults". |
| `tablet`  | Identical. A menu still fits and still reads well at 800px; only the phone genuinely cannot hold one. |
| `mobile`  | One **"View" button opening a full-screen sheet** (MUI `Dialog fullScreen`) holding the density toggle, the checkbox list and Reset. |

The bar reports its resolved shape as `data-view-surface` on
`[data-testid="datatable-view-bar"]`, mirroring `data-layout` on the wrapper and
`data-filter-surface` on the filter bar.

Four deliberate decisions:

- **The phone gets a sheet, not a menu.** A checkbox list inside a `Menu` on a
  360px screen is a scrolling popover with 32px rows and no focus trap. The
  sheet mirrors the filter sheet exactly, and MUI's `Dialog` supplies the trap,
  the Escape handling and the `aria-modal` semantics.
- **The picker does not close when a column is toggled.** Hiding three columns
  is one trip, not three. (Consequence for tests: while the menu is open the
  rest of the app carries `aria-hidden`, so a role query against the grid
  underneath finds nothing until the menu is closed.)
- **The picker lists only columns it can actually change.** `hideable: false`
  columns are omitted (they are pinned), and so are `detail` columns *on a
  tablet* — those are already folded into the row expander (§9), so a checkbox
  for them would claim an effect it does not have.
- **"Reset to defaults" is always offered**, even when nothing has been
  customized. It is the only route back from a layout stored in an earlier
  session, or on another device, that the user cannot otherwise account for.
- **The hidden-column count is spoken, not just painted.** The button carries a
  `Badge` (class `datatable-hidden-column-count`) and an accessible name of
  `"Columns (2 hidden)"` — the same treatment, for the same reason, as the
  filter bar's active-filter count (§10.3). Putting the count in the *visible*
  label instead would make the accessible name no longer contain the visible
  text (WCAG 2.5.3).

Every control clears the 44px touch floor and none is hover-revealed; the menu
and the sheet are mounted only while open, so the issue #243 failure mode
(invisible but hit-testable) cannot arise. The #243 sweep is re-run against both
surfaces in `__tests__/DataTableLayoutPrefs.test.tsx`.

### 15.3 Resolving a stored layout against the CURRENT columns

Three rules, applied in this order.

**(a) Absent means "use the contract default", never "empty".** An absent
`dataTables`, an absent entry, or an absent `visibleColumns` inside one all
resolve to the priority-derived baseline (§3). This is §14.3's rule, enforced a
second time on the client because the client is where it would actually bite.

**(b) A stored list names columns; the current column list decides which of them
exist.** A stored id matching no current column is ignored, never an error.

**(c) A column added *after* the layout was stored is visible, not hidden.**

Rule (c) is the one that needs machinery. `visibleColumns` is a `string[]`,
which can say "these ids are visible" but not "…and these other ids existed and
were deliberately hidden". Without that second bit, a column added to a table
next month is indistinguishable from one the user unchecked last month — and
would be silently hidden, from that user only, forever. That is exactly the
failure §14.3 exists to prevent, merely relocated from the server to the client.

So the list carries **every column known at write time**: visible ones as bare
ids, hidden ones prefixed with `-`.

```jsonc
// user hid `attempts`; `type`, `status`, `lastError` are visible
"visibleColumns": ["type", "status", "lastError", "-attempts"]
```

Resolution then has three answers instead of two:

| Stored state for a current column | Result |
| --------------------------------- | ------ |
| no `visibleColumns` at all        | default — visible |
| listed bare (`type`)              | visible |
| listed with the marker (`-type`)  | hidden |
| **not listed at all** (added later) | default — visible |
| `hideable: false`                 | visible, whatever the list says |

The encoding is chosen so that it **degrades correctly under the naive
reading**: a consumer that treats the field as a plain list of visible ids sees
`-attempts` match no column id, ignores it, and is left with exactly the visible
set. The marker entries carry only the extra "we knew about this one" bit. Both
bounds from §14.4 are respected on write — entries are capped at 60 (visible ids
first, since losing a marker only costs the new-column protection while losing a
visible id would hide a column) and no entry exceeds 64 characters.

**Layout folding is AND-ed with the user's choice, never overridden by it.** The
user's choice is layout-independent; the tablet's `detail` fold is a
presentation decision. A user's "hide this" must win at every width, and the
tablet fold must survive a layout stored on a desktop — otherwise a `detail`
column marked visible there would reintroduce at 800px precisely the horizontal
scroll the fold exists to remove. A column the user hid is also kept out of the
tablet expander panel: hidden means hidden at every width.

`sort` is resolved the same way and rejected unless its field still names a
`sortable` column — restoring a sort the server would reject, or the header
cannot display, is worse than opening in the page's own default order.

### 15.4 Density reaches both renderers

The grid gets density for free (DataGrid's own `density` prop drives row
height). A card list has no such contract, so `layoutModel.ts` maps the same
setting onto card metrics — region padding, the gap between stacked fields, and
the gap between cards:

| Density       | Card padding (`px` / `py`) | Field gap | Card gap |
| ------------- | -------------------------- | --------- | -------- |
| `compact`     | 1 / 0.75                   | 0.75      | 0.75     |
| `standard`    | 1.5 / 1.25                 | 1.25      | 1.5      |
| `comfortable` | 2 / 1.75                   | 1.75      | 2.25     |

(MUI spacing units.) Density that only worked on the grid would silently stop
working the moment the table went narrow — on the layout where vertical space is
scarcest.

**Touch targets are not scaled by density.** 44px is a floor, not a style. The
one existing exception stays exactly as #253 left it: the tablet row expander
keeps the grid's own density at `compact`, where the row is only 36px tall
(§9.2).

The effective density is published as `data-density` on the table wrapper and on
the card list / each card, which is how both renderers' response to it is
assertable.

### 15.5 Write discipline — debounced, fire-and-forget, in-session authoritative

Three properties, all following from one observation: a layout preference is UI
state that happens to be backed up, not a form being submitted.

- **In-session state is authoritative; the server copy is a cache.** The layout
  on screen comes from React state and changes the instant the user clicks. The
  network is told afterwards, and its response is never read back — nothing in
  `useDataTableLayoutPrefs` calls `setState` from a response. A `GET` that lands
  *after* the user has already touched a control is discarded rather than
  applied, so a slow settings read can never clobber a choice already made.
- **Fire-and-forget.** A rejected write is logged and dropped. A user who
  unchecks a column while the network is down still gets an unchecked column;
  making the checkbox depend on a round trip would trade a working control for a
  spinner and, on failure, a control that snaps back for no visible reason. A
  failed *read* is equally harmless: the table opens in contract defaults and
  stays fully usable.
- **Debounced (500ms).** Flipping four checkboxes is one intent, so it is one
  request. The debounce is on the **write**, never on the state update — the
  same rule quick search follows for its input (§10.4). A pending write is
  *flushed*, not cancelled, on unmount, so the last change before a route change
  still lands.

#### Entry-replace, and why every write is a whole entry

`PATCH /api/user-settings` merges `dataTables` per table id but replaces each
**entry wholesale** (§14.5): a patch of `{ jobs: { pageSize: 100 } }` drops that
entry's stored density and column list. So every write here sends the **complete
in-session entry**, never a delta. That is cheap precisely because the hook
already holds the full resolved layout in state — which is also why the API
chose entry-replace over a deep merge in the first place.

#### `sort` and `pageSize` are mirrored, not owned

Those two stay controlled props belonging to the page (§5.1 / §5.2); the hook
only *watches* them. It seeds a baseline at hydration — the stored value where
there is one, the page's own value otherwise — and writes only on a later
divergence from it. Without that baseline, mounting any paginated table would
immediately persist its default page size as though the user had chosen it, and
fire a `PATCH` on every mount of every table in the app.

Restoring works the same way in reverse: a stored value is handed back through
the page's own `onSortChange` / `onPaginationChange` rather than kept as a
second copy of state the page already owns. A restored page size resets to page
0, because a different page size makes the current offset meaningless.

"Reset to defaults" is the merge-patch **delete**, `{ [tableId]: null }`, sent
immediately rather than debounced (a single deliberate gesture has nothing to
coalesce). It removes the entry entirely and frees its slot against the 40-table
cap, rather than storing `{}` — which would be a second way to spell "absent".
The same rule applies incidentally: if a change ever leaves the in-session entry
empty, the write goes out as `null`, not `{}`.

### 15.6 Tests

`__tests__/DataTableLayoutPrefs.test.tsx` (40 cases), on the #253 stub recipe
(container-driven width, `matchMedia` pinned to 1440px). It stubs the network by
spying on the real `api` singleton rather than mocking the module, so the
component under test goes through exactly the client every page uses.

Worth copying rather than reinventing:

1. **The resolution rules are tested twice** — once as pure functions over a
   fixture column set, once through the rendered table. The pure tests pin the
   contract (including the encode/decode round trip and its naive-reader
   degradation); the rendered tests prove it is wired to the control a user
   touches.
2. **The three named acceptance cases are explicit tests**: defaults apply when
   keys are absent, a newly-added column is visible rather than silently hidden,
   and a failed settings write does not disturb in-session state.
3. **The debounce is driven with fake timers.** Three toggles, then
   `advanceTimersByTime(499)` → nothing on the wire, then one more millisecond →
   exactly one `PATCH` carrying the final state.
4. **Density is asserted as geometry, not as a prop.** Grid row height comes
   from the `.MuiDataGrid-row` inline `min-height` (36 / 52 / 67px in jsdom);
   card density from the computed `padding-left` of the card header. A test that
   only asserted `data-density` would pass against a renderer that ignored it.
5. **The #243 guard is re-run** against the opened desktop menu and the opened
   phone sheet — both live in portals, so the sweep roots at the menu/dialog
   rather than at `[data-testid="datatable"]`.

### 15.7 Explicitly out of scope

Per-user layout persistence, **not** named or shareable views. There is no
multi-view model, no "save this view as…", and no sharing of a layout between
users — a table stores exactly one layout per user, and "Reset to defaults" is
the only other state it can be in. Adding named views later would be a new
namespace beside `dataTables`, not a reinterpretation of it.

---

## 16. Row virtualization and CSV export (#256)

Two features that share one property: both are about a table that has *more*
than fits — more rows than a frame can paint, or more rows than a screen can be
read from.

### 16.1 The honest framing

Every target table in this app is **server-paginated**, and the MIT DataGrid
throws above a 100-row page (`pageSize` cannot exceed 100). So the realistic
worst case a renderer ever holds is ~100 rows plus a handful of synthetic tablet
detail rows (§9.1).

Virtualization here is therefore **robustness for large page sizes, not the
performance strategy.** The performance strategy is server-side pagination and
it shipped in #252. This section says what is on per renderer, and — as
importantly — what was deliberately not built.

### 16.2 Desktop / tablet: DataGrid's own virtualizer, actually turned on

MUI X virtualizes rows out of the box. It also silently stops doing so under one
condition:

```js
// @mui/x-data-grid/hooks/features/virtualization/useGridVirtualization.js
enabledForRows: !disableVirtualization && !autoHeight && HAS_LAYOUT
```

`autoHeight` **disables row virtualization** — and `autoHeight` is exactly what
this renderer uses whenever the caller omits `height`, which is the documented
default (§5: the table grows with its rows and the *page* scrolls). From #252
until this issue, the default table therefore rendered every loaded row with the
virtualizer inert.

The fix is a threshold rather than a blanket "always take a fixed height", since
auto-height is the right behaviour for a 10- or 25-row page and turning every
table into an internally scrolling box would be a worse regression than the one
being fixed. `virtualization/gridVirtualization.ts` decides per render:

| Condition                          | `autoHeight` | Height                         | Virtualized |
| ---------------------------------- | ------------ | ------------------------------ | ----------- |
| explicit `height` prop             | `false`      | the caller's                   | yes         |
| `rows.length > 50`                 | `false`      | computed viewport (12 rows)    | yes         |
| anything else                      | `true`       | none — grows with its rows     | no          |

The computed viewport is `min(rowCount, 12) × rowHeight(density) + 109px` of
header/footer chrome, so a virtualized table is bounded but still shows a
screenful. `disableVirtualization` is never passed (it stays `false`); this
module only decides whether the grid is *allowed* to use what it already has.
The decision is published as `data-virtualized` on
`[data-testid="datatable-scroll-container"]`.

Three things that had to keep working, and do:

- **Server pagination.** `paginationMode="server"` still means the grid never
  slices `rows`; virtualization changes which rows are *painted*, never which
  rows exist.
- **Synthetic detail rows (§9.1).** They are ordinary rows with a computed
  height, so windowing treats them like any other; `isRowSelectable` still
  rejects them, and a select-all over a virtualized tablet grid still yields
  only real ids.
- **Select-all.** It never reads the DOM. The renderer materialises MUI X's
  *exclude* model against `rowIds` derived from the `rows` prop (§5.3), which is
  precisely why windowing cannot corrupt it. There is a test asserting a 60-row
  page selects 60 ids while `data-virtualized` is `true`.

### 16.3 Mobile: render skipping, and NOT a virtualizer

Cards are variable height — the body grows with the `secondary` column count and
the detail region expands in place. A windowing virtualizer needs a height
estimate per item, and a **wrong** estimate is not a small inefficiency; it is a
scroll position that jumps under the user's thumb. Issue #237 is that bug,
shipped: a gallery placeholder computed for the wrong column count made
scrolling jump. An incorrect virtualizer is worse than none.

So the card list does not virtualize. It uses the browser's own render
skipping, which needs no correct estimate to be correct:

- **`content-visibility: auto`** on each card past the 20-row mark lets the
  engine skip style, layout and paint for off-screen cards. Unlike
  `display: none`, the subtree stays focusable and find-in-page-able — the
  browser force-renders it when focus or Ctrl-F lands inside — so keyboard
  navigation is unaffected.
- **`contain-intrinsic-size: auto <measured>px`** supplies the placeholder while
  a card is skipped. Two deliberate details: the `auto` keyword makes the browser
  prefer each card's own *last rendered* size, so the number only has to be right
  for cards never yet seen; and the number is **measured from a real card in this
  very list** (a callback ref plus a `ResizeObserver`), never computed from a
  column count — which is the exact thing #237 got wrong.
- **`loading="lazy"` / `decoding="async"`** are applied to `<img>` elements a
  column's `render` produced. A column's render is used verbatim (§3) and belongs
  to the calling page, so the card annotates rather than rewrites it, and an
  explicit `loading` the page already wrote is never overridden.

Two cards deliberately opt out: the **first** card (it is the one being measured,
and it is on screen anyway) and any card whose **detail region is open** (a card
whose height is changing under the user's finger must stay fully rendered).

**Explicitly not built:** a true dynamic-height card virtualizer. It remains
available as a follow-up if a card list ever holds thousands of rows — which,
given server-side pagination, it currently cannot.

### 16.4 CSV export — scope and contract

**Ships here: "current page".** The rows the table is holding, with the columns
the user currently has visible, respecting `exportable`, written from each
column's `value` accessor. Available in **all three layouts**, and implemented
against the column contract — *not* DataGrid's `GridToolbarExport`, which
serializes the grid's own rows and therefore exists in one renderer out of two.
One code path, one file, whatever width the window happens to be.

Three rules decide what lands in the file:

1. **`value`, never `render`.** A column whose cell is a `<Chip label="FAILED">`
   exports `failed`. Serializing a `ReactNode` is either impossible or, worse,
   accidentally lossy. This is what `render` and `value` being two fields (§4) is
   *for*.
2. **Only what is on screen.** The column set is the user's resolved visibility
   (#255) minus `exportable: false`. Note this is the **user's** choice, which is
   layout-independent — deliberately *not* the tablet's `detail` fold. A column
   tucked into the row expander is still shown to the user, just elsewhere, and a
   CSV that changed shape because the window is 900px wide today would be a
   surprise, not a feature.
3. **Only what the API already returned.** See §16.6.

"Active filters" need no machinery: the table never filters `rows` (§10.1), so
the loaded page already *is* the filtered result and exporting it is exporting
the filtered set. The all-rows path (§16.5) inherits the same property by
replaying the page's own query.

`disableExport` removes the control from every layout. It exists for a table
that already owns a bespoke export — the Tags page keeps its own CSV vocabulary
import/export (#259), and two export buttons producing different files is worse
than one.

#### The surface, per layout

| Layout    | Surface                                                              |
| --------- | -------------------------------------------------------------------- |
| `desktop` | An **"Export" button** in the view bar. One click, one file, when no all-rows callback is supplied — a one-item menu is a click nobody needs. |
| `tablet`  | Identical.                                                            |
| `mobile`  | A `MoreVert` **overflow menu** ("Table actions") beside "View". A fourth labelled control at 360px is what pushes the chrome row into a horizontal scroller. |

It lives in `DataTableViewBar`'s trailing slot for the same reason the picker and
the filter bar live there (§7.4): its *shape* is a layout decision, not a
row-presentation one. Touch rules (§8.5) hold — ≥44px everywhere, nothing
hover-revealed, and the menu and progress dialog are mounted only while open.

#### Escaping rules

`export/csv.ts`, pure and unit-tested:

| Input                       | Output                    | Why |
| --------------------------- | ------------------------- | --- |
| `San José, Costa Rica`      | `"San José, Costa Rica"`  | RFC 4180 quoting |
| `say "hi"`                  | `"say ""hi"""`            | internal quotes doubled |
| `line one\nline two`        | `"line one\nline two"`    | embedded newline / CR |
| `  padded  `                | `"  padded  "`            | several parsers trim unquoted fields |
| `null` / `undefined`        | *(empty)*                 | never `—`; that em dash is a *display* convention (`formatColumnValue`) |
| `=cmd\|'/c calc'!A1`        | `'=cmd\|'/c calc'!A1`     | formula injection |
| `+1+1`, `-2+3+cmd`, `@SUM(…)` | `'…`                    | the other three prefixes |
| `\t=1+1`, `\r=1+1`          | `'…`                      | some spreadsheets strip leading whitespace *before* deciding |
| `-5` (number **or** string) | `-5`                      | see below |

Records are joined with **CRLF** and the file is prefixed with a **UTF-8 BOM**
(`U+FEFF`, `EF BB BF`) — without it, Excel on Windows reads UTF-8 as the local ANSI code
page and `José` opens as `JosÃ©`. The BOM is a property of the *file*
(`toCsvFile`), not of a field, so `toCsv` stays composable.

**Why numbers are exempt from neutralization.** Prefixing blindly turns `-5`
into the text `'-5` and breaks every numeric column that can go negative — a
real regression traded for a non-attack, since `-5` is not a formula. The
apostrophe is applied only to text that is not a well-formed number, so
`-1+cmd|calc` is still neutralized while `-5` and `+1.5e3` are not.

*(A test-harness note worth keeping: `Blob.text()` decodes UTF-8, and a UTF-8
decode **strips** a leading BOM. The BOM has to be asserted on the bytes
(`arrayBuffer()`), never on the decoded string.)*

Files are named `<slug>-<YYYY-MM-DD>.csv` from `csvExport.filename`, else
`tableId`, else `ariaLabel`, else `export`. An export is a snapshot; two of them
a week apart must not collide in a Downloads folder.

### 16.5 "All matching rows" — the page's query, replayed

Shipped, as the issue's stretch goal, and **opt-in**: it appears only when the
page hands the table a fetch callback, because the component cannot know the
endpoint, the auth scheme, or how this page maps a filter model onto params.

```tsx
<DataTable
  {...props}
  csvExport={{
    filename: 'jobs',
    // page is ZERO-BASED, matching DataTablePaginationConfig.
    fetchAllRows: ({ page, pageSize, signal }) =>
      fetchJobs({ page: page + 1, pageSize, signal, ...toJobQuery(filters), q: search }),
  }}
/>
```

The walk is deliberately dull: request page 0, 1, 2… and stop at the first short
or empty page. Termination is defensive on three axes — a short page, the row
ceiling, and a 200-request hard stop — because a callback that ignores `page`
and keeps returning a full page would otherwise loop until the tab dies.

- **Bounded at 10 000 rows** (`csvExport.maxRows`). Not a preference: without it
  one click against a 150 000-item library issues 1 500 requests and builds a
  ~100 MB string. Hitting the ceiling is *reported* — a warning alert naming the
  limit — rather than silently truncating, because a CSV that is quietly a prefix
  is a wrong answer the user believes.
- **250 rows per request** by default (`csvExport.fetchPageSize`). The fetch is
  headless, so the DataGrid's 100-row page cap does not apply.
- **A progress dialog with a Cancel**, determinate when `pagination.total` is
  known and indeterminate when it is not — a fake percentage that jumps backwards
  is worse than a spinner. Cancel aborts via `AbortSignal` and produces **no**
  file; a clean, complete export shows no dialog at the end, because the file
  is the feedback.
- **A failed page produces no file at all**, with the error surfaced in the
  dialog. Half an export that looks like a whole one is the worst outcome
  available here.

### 16.6 Security

**Export never re-queries with elevated access.** It can only ever serialize what
the API has already returned to this authenticated user:

- current-page export reads the `rows` prop — data already on screen;
- all-rows export replays the **page's own** callback, so it goes through the
  same endpoint, the same token, the same RBAC checks and the same active filters
  as the table itself. It is the first one's request, run more times.

There is no privileged export path, no server-side "export everything" endpoint,
and no field the table can reach that the list response did not contain.
Sensitive columns are excluded declaratively with `exportable: false`; the
migration issues (#259, #260) will set it on share tokens and PAT material. A
column author who forgets it exports what the API already sent to the browser —
which is why the flag is a *narrowing* control rather than the only barrier.

### 16.7 Tests

`__tests__/DataTableExport.test.tsx` (75 cases), on the #253 stub recipe
(container-driven width, `matchMedia` pinned to 1440px). Four things worth
copying rather than reinventing:

1. **The download is stubbed at the browser boundary**, not behind an injected
   seam: `URL.createObjectURL` captures the real `Blob` the component built and
   `HTMLAnchorElement.click` is spied so jsdom does not log a navigation. Every
   assertion about "what the user got" reads those bytes.
2. **The escaping rules are tested twice** — as pure functions (each of the four
   formula prefixes, quotes, commas, newlines, the numeric exemption) and through
   a rendered table (a chip column exports its scalar; an `exportable: false`
   column never appears; unchecking a column in the picker changes the header
   row).
3. **jsdom disables MUI X virtualization outright** (`HAS_LAYOUT =
   !platform.env.jsdom`), so the grid tests assert the *decision*
   (`data-virtualized`, the computed viewport height, the threshold boundary) and
   assert the property that makes windowing safe: a 60-row page still select-alls
   to 60 ids, and a virtualized tablet grid with an expanded row still selects no
   synthetic detail row.
4. **The #243 guard is re-run** against the export menu and the phone overflow
   menu, with `[role="menuitem"]` added to the sweep's selector — the export
   menu's controls are menu items rather than buttons or checkboxes.

---

## 17. Accessibility contract & keyboard model (#257)

The component replaces 16 hand-rolled tables, so whatever a11y quality it has
is inherited by every one of them at once — and whatever gap it has is
inherited too. This section is the contract every renderer must hold to, and
§17.8 is how a migrating page (#258 onward) gets that contract checked against
its own columns for free instead of re-deriving it.

**Target: WCAG 2.1 AA.** Every rule in this section exists to hold that line
for both renderers, in both themes, at both this component's default 44px
touch-target floor (§8.5) and its keyboard-only floor.

### 17.1 Renderer semantics

| Renderer | Announces as | Mechanism |
| -------- | ------------- | --------- |
| Desktop / tablet grid | a named **grid**, with real row/column context | DataGrid's own `role="grid"` / `role="row"` / `role="columnheader"` / `role="gridcell"` plus `aria-rowcount` / `aria-colcount` / `aria-rowindex` / `aria-colindex` — inherited for free, and asserted directly (not assumed) by the conformance suite's "renderer semantics" describe block |
| Mobile card list | a named **list** | `Stack component="ul" role="list" aria-label={ariaLabel}` (`mobile/CardListRenderer.tsx`); each `DataCard` is a real `<li>` (`component="li"`) |

**Every card is labelled by its primary column.** `DataCard.tsx` sets
`aria-label={headlineText}` on the card's own root — `headlineText` is exactly
the same value the card's visual headline and the row-actions menu's
disambiguating suffix (§17.6) already use, so a screen reader user tabbing
through list items hears each one named after the thing a sighted user reads
it by, never a generic "list item". Two rows sharing the same primary-column
value get the same accessible name — declare a primary column with row-unique
values (an id, a name) for tables where that would be ambiguous.

### 17.2 Live-region announcements

Two announcements, both `aria-live="polite"`:

- **Selection: "N of M selected"** — `BulkActionBar`'s `role="status"` text
  (§5.6), now carrying an explicit denominator. `total` is the number of
  selectABLE rows currently loaded (`rowIds.length`), never
  `pagination.total` — selection is page-scoped (§5.3), so the announcement's
  own scale must be too. Both renderers pass it; omitting `total` (a caller
  using `BulkActionBar` directly, outside a `DataTable` renderer) falls back
  to the bare "N selected" it always said.
- **Filtering: "Filtered to N results"** — a `data-testid="datatable-filter-live-region"`
  box in `DataTableFilterBar`, visually hidden (`@mui/utils/visuallyHidden`)
  but always mounted, so the announcement fires regardless of which filter
  surface (row / collapsed panel / sheet, §10.3) is currently drawn. It speaks
  only when there is an active filter **or** search term *and* the page
  reports `resultCount` (wired from `DataTable` as `pagination?.total`) — a
  table with nothing applied has nothing to announce, and a count the page
  never told it would be a lie the region has no way to double-check.
  Singular/plural aware ("Filtered to 1 result").

Neither announcement is read on initial mount with nothing applied — an empty
live region announces nothing, by design; only a genuine state *change*
should ever speak.

### 17.3 Focus management

Every overlay in this component is built on MUI's `Dialog` or `Menu`
(both `Modal`-based), and none of them disables the defaults
(`disableEnforceFocus` / `disableRestoreFocus` / `disableAutoFocus` are never
set anywhere in `components/datatable/`) — so the contract below is inherited,
not hand-rolled, and the conformance suite's "focus management" describe block
exists specifically to keep it that way rather than assume it:

- **Opening the filter sheet** (mobile, `DataTableFilterBar`), **the column
  picker** (desktop menu / mobile sheet, `DataTableViewBar`), or **a row's
  overflow menu** (`RowActionsCell`) moves focus inside and traps Tab there.
- **Closing any of them** (Escape, the close button, selecting an item)
  restores focus to the control that opened it — never to `<body>`.

This is also why every trigger button in this component is a real, focusable
element with a stable identity across the open/close cycle, never
recreated — a trigger that gets a fresh DOM node on close cannot receive
restored focus.

### 17.4 Keyboard model

#### Desktop / tablet grid

Inherited from DataGrid: arrow keys move a roving cell focus; Home/End and
Ctrl+Home/Ctrl+End jump within a row/to the grid's ends; Enter/Space activates
whatever the focused cell contains. That inheritance is **verified, not
assumed** (§17.8's fixture deliberately includes a `render`-only chip column
and a `render`-only interactive `<a href>` link column): a cell's custom
`render` content stays in the natural tab order and is reachable the same way
plain grid content is, because nothing in `columnAdapter.ts`'s mapping
strips or overrides `tabIndex` on rendered content.

Three controls that are DataGrid built-ins, not custom cells, get the same
guarantee for free — verified by the shared `checkboxColDef` override:

- **The row checkbox column** is reachable via arrow-key cell navigation like
  any other cell, and via a direct Tab into the cell that currently holds
  roving focus (DataGrid's own "move DOM focus onto the tabindex=0 descendant"
  behaviour, `GridCell.js`).
- **The header "select all" checkbox** and **the tablet row-expander button**
  are ordinary focusable controls (§17.6 covers their names).

#### Tablet row expansion

The expander (§9) is a real `IconButton` with `aria-expanded` — Enter/Space
toggles it exactly like any other button; no bespoke key handling was written
or is needed.

#### Mobile card list

A card has no column headers to click, so **every affordance the grid gets
from DataGrid is reproduced as a real, independently-focusable control**
rather than inherited:

- **Tab order** walks header checkbox → each card's own checkbox → primary
  content → row-actions trigger → (if expanded) detail-region content, in
  DOM order — there is no synthetic roving-focus model to fight; ordinary
  browser Tab semantics apply throughout.
- **Enter/Space expand** the "More details" region and the tap-to-expand
  truncated value (§8.3): both are a real `ButtonBase` with `aria-expanded`,
  not a `div` with an `onClick`.
- **Sort** is reachable via `CardSortControl` (§8.4) — a `select` plus a
  direction-toggle `IconButton`, both ordinary focusable form controls.
- **Pagination** (`CompactPagination`, §8.4) is two `IconButton`s with
  `aria-label`s, no different from the grid footer's.

#### The blanket rule

**Every action available by pointer is reachable by keyboard**: bulk
select-all, opening the filter sheet / column picker / row menu, changing
density, paging, and exporting. None of this component's controls are
`div`/`span` click handlers standing in for a real interactive element —
every one is a `button`, a native `input`, or a `Checkbox`/`ButtonBase`.

### 17.5 Sort state

`aria-sort` on the desktop grid's column headers is a DataGrid built-in,
wired automatically from the controlled `sort` prop (§5.2) — asserted
directly by the conformance suite (`toHaveAttribute('aria-sort', 'descending')`)
rather than re-derived. The mobile card list has no column headers to carry
`aria-sort`; `CardSortControl`'s own `select` value and its direction
button's `aria-label` ("Sorted descending, switch to ascending") communicate
the same state in the only way a card layout can.

### 17.6 Selection and action labelling

**No control is ever named with a bare, row-agnostic label.** Both renderers
derive a per-row accessible name — `rowAccessibleName()` in
`desktop/columnAdapter.ts` on the grid, `DataCard`'s own `headlineText` on a
card — from the first `primary`-priority column still on screen (respecting
the user's #255 visibility choice), falling back to the row id only when
there is no primary column or its value is empty/null:

| Control | Bare label (before #257) | Row-labelled (after) |
| ------- | ------------------------- | --------------------- |
| Grid row checkbox | "Select row" (DataGrid's own locale text, identical on every row) | "Select `{row}`" |
| Grid single row action | "`{action label}`" | "`{action label}` for `{row}`" |
| Grid multi-action menu trigger | "Row actions" | "Row actions for `{row}`" |
| Tablet row-expander | "Show details" / "Hide details" | "Show details for `{row}`" / "Hide details for `{row}`" |
| Card checkbox | "Select row" | "Select `{row}`" |

The card renderer's row-action button and its own checkbox already worked
this way before #257 (they were the pattern; the grid was the gap). The grid
row checkbox needed the most care: DataGrid's own per-row checkbox has ONE
static locale string for every row, with no per-row override point in its
public API — `desktop/DesktopGridRenderer.tsx` replaces it entirely via
`checkboxColDef` (DataGrid's own, documented, forward-compatible extension
point for the selection column; **not** a reach into an internal component),
rendering a plain `Checkbox` whose `aria-label` is computed the same way
every other per-row control's is.

### 17.7 Two upstream gaps this component fixes, not works around

The conformance suite's axe pass (§17.8) surfaced two REAL violations that
predate #257 and are not test-environment artifacts — both fixed in the
component, not suppressed:

1. **An indeterminate checkbox's `aria-checked="mixed"` had no matching
   native state.** MUI's `Checkbox` sets `aria-checked="mixed"` when
   `indeterminate` is true but — by its own documented design — never sets
   the native `HTMLInputElement.indeterminate` IDL property (which has no
   HTML attribute form and can only be set imperatively). `axe-core`'s
   `aria-conditional-attr` rule computes a checkbox's "real" state from that
   native property, sees it disagree with `aria-checked="mixed"`, and flags
   it — for both the card list's own select-all checkbox and, mediated
   through DataGrid's own indeterminate header checkbox, the desktop grid's.
   `shared/IndeterminateCheckbox.tsx` wraps `Checkbox`, syncs the native
   property via a DOM query on its own root, and is used two ways: directly
   in `CardListRenderer.tsx`, and as DataGrid's own public `slots.baseCheckbox`
   override in `DesktopGridRenderer.tsx` — one component, both gaps.
2. **The tablet expander column had no discernible header.** Its header is
   visually blank by design (§9) — a single ~48px icon-button column, not
   somewhere a visible label fits — but a `columnheader` cell with literally
   zero accessible text is axe's `empty-table-header`. Fixed with the
   standard technique: a visually-hidden ("Row details") text node via the
   column's `renderHeader`, present for assistive tech, invisible on screen —
   the same visually-hidden pattern §17.2's live regions use.

### 17.8 The shared conformance suite

`__tests__/conformance/runDataTableConformanceSuite.tsx` exports
`runDataTableConformanceSuite(options?)` — call it inside a `describe` block
and it registers the FULL mechanics + accessibility battery documented in
this section (plus §12's pre-existing pagination/sort/selection/CSV/
virtualization coverage) against a fixture table. `__tests__/DataTableConformance.test.tsx`
is that call with zero arguments — it runs the suite against the module's own
built-in fixture (`conformanceFixtureColumns` / `Rows` / `RowId`) and **is**
this component's own regression suite for everything in §17.

```tsx
import { runDataTableConformanceSuite } from
  '../../../components/datatable/__tests__/conformance/runDataTableConformanceSuite';

describe('JobsTable', () => {
  runDataTableConformanceSuite({
    label: 'JobsTable',
    columns: jobsTableColumns,   // the page's own DataTableColumn[]
    rows: sampleJobs,
    rowId: (job) => job.id,
  });

  // Page-specific tests only from here: business logic behind bulk actions,
  // the page's fetch-and-map layer, anything about ITS columns the shared
  // fixture can't stand in for. Table MECHANICS — everything above — never
  // need re-testing per page; they don't change per column set.
});
```

A migrating page (#258 onward) does not usually need to call this at all —
table mechanics are a property of the component, not of a page's column
declarations, so the zero-argument run already covers them. The one reason a
page WOULD call it with its own `columns`/`rows`/`rowId` is a column whose
`render` produces something the built-in fixture doesn't already exercise (a
multi-control cell, an embedded form) — "does keyboard nav survive THIS
specific custom content" is worth re-asking against the real thing.

**What it covers**, end to end: renderer switching and state preservation
across a resize; server-side pagination/sort/filter round-trips (including
the negative test that `rows` is never filtered/sorted/paginated locally);
selection and select-all, including past the virtualization threshold;
loading/empty/error states in both renderers; column visibility, density, and
the contract-default baseline; CSV escaping; the issue #243 "invisible but
tappable" guard (`__tests__/testUtils/a11yGuards.ts`, consolidated here from
four near-identical copies — see that file's docblock); "no horizontal
document scroll at 360px"; §17.1's renderer semantics; §17.2's live regions;
§17.3's focus management; and §17.4's keyboard model. Automated `axe-core`
checks run in both renderers and both themes (`vitest-axe`).

**`color-contrast` is deliberately disabled in the suite's axe pass.** jsdom
performs no real layout or paint, so the rule cannot resolve an element's true
effective background (every box measures 0×0) — a well-known false-negative
trap under jsdom, not a real signal. Real contrast coverage lives in
`__tests__/DataTableContrast.test.tsx` instead: a pure WCAG 2.1
relative-luminance / contrast-ratio calculator (`__tests__/testUtils/contrast.ts`,
with its own unit tests pinned against known references — black-on-white is
exactly 21:1) run directly against the real `lightTheme`/`darkTheme` palette
values for the specific pairs this component paints, including the
**translucent** selected-row tint correctly alpha-composited over its actual
backing surface before the ratio is computed — a case a naive two-color check
gets wrong. This is a *stronger* check than axe could give in this
environment, not a weaker substitute for one.

**The theme-aware checks use their own render wrapper.** The other DataTable
suites' shared `render` (`__tests__/utils/test-utils.tsx`) computes a theme
via `ThemeContextProvider` but never actually applies it with MUI's
`<ThemeProvider>` — only `App.tsx` does that — so every DataTable test outside
this suite in fact renders against MUI's zero-config default theme, not the
app's real palette. `runDataTableConformanceSuite`'s `renderWithTheme` wraps
directly with `<ThemeProvider theme={lightTheme|darkTheme}><CssBaseline/>…`
instead, since the both-themes checks need the REAL palette to mean anything.

---

## 18. The pilot migration — Job Queue (#258)

`JobsPage` (`/admin/settings/jobs`) is the first table migrated onto this
component, and it was chosen because it was the worst-affected one: 13 columns,
four bespoke fixed-width filter controls, a five-second auto-refresh poll, and
a `lastError` column carrying multi-line stack traces. Everything below is what
the migration actually found. §18.1 is a contract change; the rest are rules a
migrating page follows.

**Files:** `apps/web/src/pages/Admin/JobsPage.tsx` (the page) and
`apps/web/src/pages/Admin/jobsTable.tsx` (the column set + the pure
model → query-param mapping, split out so both halves are directly testable).
`tableId` is `admin-jobs`.

### 18.1 `filterOnly` — the contract gap the pilot exposed

**The gap.** The filter model is column-scoped: `DataTableFilter.columnId` names
a declared column, and `filterableColumns(columns)` is what the editor lists. So
a filter can only exist if a *column* exists. That silently assumes a table's
query parameters are a subset of its response's fields — and for this endpoint
two of the four are not:

| Param | Why it has no column |
| ----- | -------------------- |
| `processedWithin` (`4h`/`24h`/`7d`/`30d`) | A window over `COALESCE(finishedAt, createdAt)`. It is not `createdAt`, not `finishedAt`, and not a range over either — `filterType: 'date'`'s `before`/`after`/`between` would compile to a query the endpoint cannot answer. |
| `scheduled=true` | A queue-slice flag ("pending jobs currently in retry backoff"), not a field. |

Neither has a scalar worth printing once per row: a "Processed within" cell
would read `4h` on all 25 rows.

Before the flag there were only two ways out, and the pilot rejected both. Keep
a bespoke control beside the table — which is precisely the thing the shared
filter bar exists to delete, and would have left this page with two filter
surfaces. Or declare a decorative column and hide it in the picker — which
spends a `visibleColumns` slot, a CSV column and a card field on a cell that
says nothing, and puts a checkbox in the picker for a column no user asked for.

**The resolution.** `DataTableColumn.filterOnly?: boolean` — the column feeds
the filter surface (and the URL helper's type coercion) and nothing else.

```ts
{
  id: 'processedWithin',
  label: 'Processed within',
  priority: 'detail',          // required by the type; ignored when filterOnly
  filterOnly: true,
  filterable: ['is'],
  filterType: 'enum',
  enumValues: [
    { value: '4h',  label: 'Last 4 hours' },
    { value: '24h', label: 'Last 24 hours' },
    /* … */
  ],
}
```

The whole implementation is one split at one seam. `DataTable` computes
`drawableColumns(columns)` once and hands the **full** list to
`DataTableFilterBar` and the **drawable** list to `DataTableViewBar`,
`DataTableExportControl`, `useDataTableLayoutPrefs` and both renderers. No
renderer, adapter, picker or exporter learned a new field —
`drawableColumns` returns its input array unchanged when nothing opts out, so
the identity every downstream `useMemo` keys on is preserved for every other
table in the app.

`priority`, `align`, `truncate` and the sizing hints are ignored on a
`filterOnly` column. `priority` stays required rather than becoming optional:
making it nullable would push an `undefined` check into every consumer that
reads it, to save one line in the two declarations that need it.

**This generalizes.** Almost every remaining table in epic #238 has at least one
query-shaped filter that is not a column: the shares admin page's
`scope=mine|all`, `GET /api/media`'s `noFaces` / `missingCapturedAt` /
`missingCamera` booleans, the workflow-runs `windowDays`. They now all have a
home.

### 18.2 Mutually exclusive filters are the page's job, and that is correct

`scheduled=true` **forces `status=pending`** server-side, so "failed AND backing
off" is not a query the endpoint can answer. The normalized model is a flat,
AND-ed list with no notion of exclusion — and it should stay that way: exclusion
is an endpoint fact, not a table fact, and encoding it in the column contract
would mean teaching the component a per-endpoint constraint language.

The page reconciles instead, in `onFiltersChange`
(`normalizeJobFilters` in `jobsTable.tsx`): last-wins per column, and last-wins
per *exclusive group*, where `status` and `backingOff` share one group. This
works — and is the recommended pattern for the remaining migrations — because
of two existing properties of the contract:

- `onFiltersChange` receives the **whole next model**, never a delta (§10.2), so
  a page can rewrite it wholesale rather than reasoning about what changed;
- `filters` is **controlled** (§5.4), so the normalized model is what the chip
  strip renders. The superseded filter's chip visibly disappears instead of
  lingering as a chip with no effect on the query — which is exactly what the
  old page's two controls did to each other by hand.

`toJobQuery` then re-applies the invariant on the way out (a `scheduled` query
never carries a `status`), so a model that arrived some other way — a
hand-edited URL, a future caller — cannot produce a contradictory request.

### 18.3 Pin the operators to what the endpoint can answer

The `enum` default set is `is` / `isNot` / `isAnyOf`. `GET /api/admin/jobs`
takes a single `status=` and a single `type=`; it can express neither of the
other two. Every filterable column here therefore declares
`filterable: ['is']`.

The same reasoning made `scheduled` a **single-option enum** rather than
`filterType: 'boolean'`: the boolean editor offers Yes/No, and "No" has no
server semantics (there is no `scheduled=false`). One expressible state, one
option — rather than a control that looks live and, half the time, does nothing.

And nothing on this table is `sortable`: the endpoint accepts no `sortBy`, so
the page passes no `sort` config at all. This is the `sortable`-defaults-to-false
rule (§4) doing its job on a real table.

### 18.4 Surviving the five-second poll

The issue named this the single most likely regression, and it is worth stating
as a rule for every migration, because the failure is silent and easy to
reintroduce:

**Render the table unconditionally and pass `loading` as a prop.** The old page
did `{!jobsLoading && <TableContainer>…}`. Under a 5s poll that remounts the
renderer twelve times a minute, and a renderer's own state — which rows/cards
are expanded (§7.4) — dies with it, along with the page's scroll offset. The
`loading` overlay exists precisely so a refetch does not blank the table.

Two page-level rules complete it:

- **Every piece of user state lives above the table** — selection, the filter
  model and pagination are all page state, so a poll replacing `rows` cannot
  touch them. Selection is additionally pruned to ids still present, with a
  same-reference early return so a poll that changes nothing does not re-render.
- **Memoize `columns` on the data it derives from, not on the response.** The
  Type filter's `enumValues` come from `stats.byType`, and `stats` is a fresh
  object every poll. Keying the `useMemo` on the job-type *set* (a joined
  string) instead of on `stats` keeps the column array stable across ticks.

`__tests__/pages/JobsPage.test.tsx` asserts all three at once: apply a filter,
select a row, expand a row, then re-render with brand-new job objects carrying
the same ids — the chip, the checked checkbox and the expanded row all survive.

### 18.5 What a migrating page should NOT test

Table mechanics are a property of the component, so `JobsPage.test.tsx` tests
none of them — no pagination round-trip, no select-all, no CSV escaping, no
column picker, no axe pass. Those are `runDataTableConformanceSuite`'s, and
re-running the full battery per page would multiply the suite's runtime by 16
for no new signal (§17.8). The page tests only what the migration could break:
its own filter mapping, its mutations, the poll contract above, and permission
gating.
