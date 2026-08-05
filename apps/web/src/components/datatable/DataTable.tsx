/**
 * DataTable — public component.
 *
 * A thin layout-switch shell over one shared column contract. It resolves ONE
 * of three layouts from the table's own container width and hands the same
 * `DataTableRendererProps` to whichever renderer serves it:
 *
 *   | layout    | renderer module              | `detail` columns          |
 *   | --------- | ---------------------------- | ------------------------- |
 *   | `mobile`  | `mobile/CardListRenderer`    | collapsed "More details"  |
 *   | `tablet`  | `desktop/DesktopGridRenderer`| hidden; row expansion     |
 *   | `desktop` | `desktop/DesktopGridRenderer`| visible                   |
 *
 * ## Container width, not viewport width
 *
 * The switch measures THIS table's wrapper. A DataTable in a 400px drawer on a
 * 1440px desktop gets cards; a viewport media query would give it the desktop
 * grid and it would be unusable. See `useContainerLayout.ts` for the mechanics
 * and the pre-measurement fallback.
 *
 * ## State lives above the renderers
 *
 * Selection, pagination, sort and filters are all controlled props owned by the
 * calling page. Nothing a user chose is stored inside a renderer, so rotating a
 * device, dragging a drawer wider, or resizing a window swaps the layout without
 * losing a single selected id, the current page, the active sort, or an applied
 * filter. The only state a renderer owns is which rows/cards happen to be
 * expanded right now — pure presentation, and meaningless in the layout being
 * switched to.
 *
 * ## The filter surface belongs here, not to a renderer
 *
 * `DataTableFilterBar` is drawn by this component, above whichever renderer is
 * active, because filtering is the one control whose SHAPE is decided by the
 * layout (a row / a collapsed panel / a full-screen sheet) rather than by how
 * rows are presented — and because a renderer owning the panel's open state
 * would discard it on every resize.
 *
 * `DataTableViewBar` (column visibility + density, #255) sits here for exactly
 * the same two reasons — and one more: the visible column SET must be resolved
 * once, from the layout baseline and the user's stored choice together, so the
 * two renderers can never disagree about which columns exist.
 *
 * `DataTableExportControl` (CSV export, #256) rides in that bar's trailing slot
 * on the same logic: one code path serves every renderer, so a phone and a
 * desktop download byte-identical files, and the control's SHAPE (a button, or
 * an overflow menu at 360px) is the only thing the layout decides.
 *
 * ## Layout persistence
 *
 * Supplying `tableId` stores the resolved layout under
 * `user_settings.dataTables[tableId]`; omitting it keeps every control working
 * but session-scoped. In-session state is authoritative either way — the write
 * is debounced and fire-and-forget, and its outcome never feeds back into what
 * is on screen. See `layout/useDataTableLayoutPrefs.ts`.
 */

import { useRef } from 'react';
import { Box } from '@mui/material';
import type {
  DataTableFilterModel,
  DataTableLayout,
  DataTableProps,
  DataTableRendererKind,
  DataTableRendererMode,
} from './types';
import { DesktopGridRenderer } from './desktop/DesktopGridRenderer';
import { CardListRenderer } from './mobile/CardListRenderer';
import { DataTableFilterBar } from './filter/DataTableFilterBar';
import { DataTableViewBar } from './layout/DataTableViewBar';
import { DataTableExportControl } from './export/DataTableExportControl';
import { useDataTableLayoutPrefs } from './layout/useDataTableLayoutPrefs';
import { useDataTableLayout, useViewportLayout } from './useContainerLayout';

/** Stable identity so an unfiltered table never re-renders the bar needlessly. */
const NO_FILTERS: DataTableFilterModel = [];

/**
 * The card-list registration. This is the seam #252 left behind; it now points
 * at the real renderer.
 */
const MOBILE_RENDERER = CardListRenderer;

/** Which renderer module serves a given layout. */
export function rendererForLayout(layout: DataTableLayout): DataTableRendererKind {
  return layout === 'mobile' ? 'mobile' : 'desktop';
}

/**
 * Viewport-based renderer resolution.
 *
 * Retained as the public, ref-free helper (and used as the layout hook's
 * pre-measurement fallback). Prefer `DataTable`'s own container-driven switch:
 * this one cannot see that its table is inside a narrow drawer.
 */
export function useDataTableRenderer(
  mode: DataTableRendererMode = 'auto',
): DataTableRendererKind {
  const viewportLayout = useViewportLayout();
  if (mode !== 'auto') return rendererForLayout(mode);
  return rendererForLayout(viewportLayout);
}

export function DataTable<Row>(props: DataTableProps<Row>) {
  const {
    renderer = 'auto',
    mobileBreakpoint,
    tabletBreakpoint,
    filters,
    onFiltersChange,
    quickSearch,
    tableId,
    csvExport,
    disableExport = false,
    density: densityProp,
    'data-testid': testId,
    ...rendererProps
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const layout = useDataTableLayout(containerRef, renderer, {
    mobile: mobileBreakpoint,
    tablet: tabletBreakpoint,
  });
  const mode = rendererForLayout(layout);

  const prefs = useDataTableLayoutPrefs({
    tableId,
    columns: props.columns,
    layout,
    densityProp,
    sort: props.sort,
    pagination: props.pagination,
  });

  return (
    <Box
      ref={containerRef}
      data-testid={testId ?? 'datatable'}
      // `data-renderer` is which module drew this (two values); `data-layout`
      // is which of the three layouts it drew. Both are test hooks and
      // debugging aids.
      data-renderer={mode}
      data-layout={layout}
      // The effective density, after the user's own choice has overridden the
      // page's default — the one place both renderers' density is observable.
      data-density={prefs.density}
      // The horizontal-containment contract starts here: no DataTable may ever
      // make the document body scroll sideways, at any viewport width.
      sx={{ width: '100%', maxWidth: '100%', minWidth: 0 }}
    >
      <DataTableViewBar
        columns={props.columns}
        layout={layout}
        visibleColumnIds={prefs.userVisibleColumnIds}
        density={prefs.density}
        onToggleColumn={prefs.toggleColumn}
        onDensityChange={prefs.setDensity}
        onReset={prefs.reset}
        trailing={
          disableExport ? undefined : (
            <DataTableExportControl
              layout={layout}
              columns={props.columns}
              rows={props.rows}
              // The USER's choice, not the layout's fold: a `detail` column the
              // tablet tucks into its row expander is still on screen, so a CSV
              // must not change shape because the window got narrower.
              visibleColumnIds={prefs.userVisibleColumnIds}
              config={csvExport}
              filenameBase={csvExport?.filename ?? tableId ?? props.ariaLabel}
              total={props.pagination?.total}
            />
          )
        }
      />

      <DataTableFilterBar
        columns={props.columns}
        layout={layout}
        filters={filters ?? NO_FILTERS}
        onFiltersChange={onFiltersChange}
        quickSearch={quickSearch}
      />

      {mode === 'mobile' ? (
        <MOBILE_RENDERER
          {...rendererProps}
          density={prefs.density}
          visibleColumnIds={prefs.userVisibleColumnIds}
        />
      ) : (
        <DesktopGridRenderer
          {...rendererProps}
          density={prefs.density}
          visibleColumnIds={prefs.userVisibleColumnIds}
          variant={layout === 'tablet' ? 'tablet' : 'desktop'}
        />
      )}
    </Box>
  );
}
