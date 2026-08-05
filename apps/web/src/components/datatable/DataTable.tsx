/**
 * DataTable — public component.
 *
 * A thin renderer-switch shell over one shared column contract. Today the only
 * registered renderer is the DataGrid-backed desktop one; issue #253 registers
 * `mobile/CardListRenderer` beside it and the switch below starts resolving to
 * two different layouts from the *same* `DataTableColumn[]`.
 *
 * Nothing about a table's declaration changes when that happens — which is the
 * whole point of the contract living in `types.ts` rather than in either
 * renderer.
 */

import { Box, useMediaQuery, useTheme } from '@mui/material';
import type { DataTableProps, DataTableRendererMode } from './types';
import { DesktopGridRenderer } from './desktop/DesktopGridRenderer';

/**
 * Placeholder registration for the card-list renderer.
 *
 * TODO(#253): replace with `mobile/CardListRenderer`. Until then `'mobile'`
 * resolves to the desktop grid so the switch is exercised end to end (the
 * `data-renderer` attribute below reports the *resolved* mode either way) and
 * narrow viewports still get a working table.
 */
const MOBILE_RENDERER = DesktopGridRenderer;

/**
 * Resolve which renderer to use.
 *
 * `'auto'` breaks at the `md` boundary — below it a table cannot show more than
 * about two columns without horizontal scrolling, which is exactly where cards
 * beat rows.
 */
export function useDataTableRenderer(mode: DataTableRendererMode = 'auto'): 'desktop' | 'mobile' {
  const theme = useTheme();
  const isNarrow = useMediaQuery(theme.breakpoints.down('md'));
  if (mode !== 'auto') return mode;
  return isNarrow ? 'mobile' : 'desktop';
}

export function DataTable<Row>(props: DataTableProps<Row>) {
  const { renderer = 'auto', 'data-testid': testId, ...rendererProps } = props;
  const mode = useDataTableRenderer(renderer);
  const Renderer = mode === 'mobile' ? MOBILE_RENDERER : DesktopGridRenderer;

  return (
    <Box
      data-testid={testId ?? 'datatable'}
      data-renderer={mode}
      // The horizontal-containment contract starts here: no DataTable may ever
      // make the document body scroll sideways, at any viewport width.
      sx={{ width: '100%', maxWidth: '100%', minWidth: 0 }}
    >
      <Renderer {...rendererProps} />
    </Box>
  );
}
