/**
 * Run-item tables — the shared DataTable declaration (issue #261, epic #238).
 *
 * Three pages render "the items this run could not process": the workflow run
 * page, the generic review-run page, and the empty-trash run page. Before this
 * migration each one hand-rolled the *same* three-column
 * `<TableContainer><Table size="small">` block plus a `<Pagination>` footer, so
 * all three scrolled sideways on a phone and all three had to be fixed
 * separately. They now share one column declaration.
 *
 * ## Why one module rather than three column files
 *
 * The three item types are structurally the same row — `types/runs.ts`'s
 * {@link BaseRunItem} is exactly the intersection the API already guarantees
 * (`id`, `status`, `error`, `updatedAt`, `media`, `thumbnailUrl`). Only two
 * things genuinely differ per queue: what a row is *called* (a filename, or a
 * burst-group id when the subject has no media row) and where "View" goes. Both
 * are parameters.
 *
 * ## Priorities
 *
 *   - primary   — Subject (thumbnail + label), Status
 *   - secondary — Error, Captured
 *   - detail    — Item id
 *
 * `status` is `primary` deliberately: it is the signal every one of these
 * surfaces exists to convey (`matched` / `applied` / `failed` / `skipped`), so
 * it belongs in the card headline rather than folded behind "More details".
 *
 * The signed thumbnail rides **inside the Subject column's `render`** rather
 * than in a column of its own. A column's `render` is used verbatim by every
 * layout (docs/specs/datatable.md §3), so this puts the thumbnail in the card's
 * headline area — while keeping the column's `value` a real scalar (the label),
 * which is what names every per-row control (§17.6) and what a CSV export
 * writes. A thumbnail-only column would have neither.
 *
 * ## Nothing is `sortable`, nothing is `filterable`
 *
 * `GET /workflow-runs/:id/items`, `GET /review-runs/:id/items` and
 * `GET /trash-empty-runs/:id/items` accept `status`, `page` and `pageSize` and
 * nothing else — no `sortBy`, no free-text search. Per the
 * `sortable`-defaults-to-false rule (§4) no column opts in, and the pages pass
 * no `sort` config. `status` is not offered as a generic filter either: the
 * page pins it to `failed` for the "failed items" surface, and a second control
 * writing the same param is the drift §13.1 warns about.
 */

import type { ReactNode } from 'react';
import { Avatar, Box, Chip, Stack, Typography } from '@mui/material';
import { BrokenImage as BrokenImageIcon } from '@mui/icons-material';
import type { DataTableColumn } from '../datatable';
import type { BaseRunItem, RunItemStatus } from '../../types/runs';
import { formatCaptureDate } from '../../utils/runFormat';

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

const ITEM_STATUS_COLORS: Record<
  RunItemStatus,
  'default' | 'info' | 'success' | 'warning' | 'error'
> = {
  matched: 'default',
  processing: 'info',
  excluded: 'default',
  applied: 'success',
  partially_applied: 'warning',
  deleted: 'success',
  failed: 'error',
  skipped: 'default',
};

/** Title-cased, space-separated label for a run-item status. */
export function runItemStatusLabel(status: RunItemStatus): string {
  const words = status.split('_');
  return words
    .map((word, index) =>
      index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word,
    )
    .join(' ');
}

function RunItemStatusChip({ status }: { status: RunItemStatus }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      label={runItemStatusLabel(status)}
      color={ITEM_STATUS_COLORS[status] ?? 'default'}
    />
  );
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export interface RunItemColumnOptions<Item extends BaseRunItem> {
  /**
   * Header/field label for the leading column — "File" for media-backed runs,
   * "Subject" where a row may be a burst or duplicate group instead.
   */
  subjectLabel: string;
  /**
   * The row's human handle. Also the column's `value`, so it is what names the
   * row's checkbox and its action control (docs/specs/datatable.md §17.6) and
   * what a CSV export writes.
   */
  itemLabel: (item: Item) => string;
}

export function buildRunItemColumns<Item extends BaseRunItem>({
  subjectLabel,
  itemLabel,
}: RunItemColumnOptions<Item>): DataTableColumn<Item>[] {
  return [
    // --- primary ------------------------------------------------------------
    {
      id: 'subject',
      label: subjectLabel,
      priority: 'primary',
      value: (item) => itemLabel(item),
      render: (item) => {
        const label = itemLabel(item);
        return (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Avatar
              variant="rounded"
              src={item.thumbnailUrl ?? undefined}
              alt=""
              sx={{ width: 36, height: 36, flexShrink: 0, bgcolor: 'action.hover' }}
            >
              <BrokenImageIcon sx={{ fontSize: 18, color: 'text.disabled' }} />
            </Avatar>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" noWrap title={label}>
                {label}
              </Typography>
            </Box>
          </Stack>
        );
      },
      minWidth: 200,
      flex: 1.2,
      // A thumbnail has no scalar; the label is the scalar, and it is exported.
      hideable: false,
    },
    {
      id: 'status',
      label: 'Status',
      priority: 'primary',
      value: (item) => item.status,
      render: (item) => <RunItemStatusChip status={item.status} />,
      width: 150,
    },

    // --- secondary ----------------------------------------------------------
    {
      id: 'error',
      label: 'Error',
      priority: 'secondary',
      value: (item) => item.error,
      // One line + tooltip on the grid; a tap-to-expand value on a card. This
      // is what stops a stack trace turning every row into a five-line block.
      truncate: true,
      render: (item) => (
        <Typography variant="body2" color="error">
          {item.error ?? 'Unknown error'}
        </Typography>
      ),
      minWidth: 200,
      flex: 2,
    },
    {
      id: 'capturedAt',
      label: 'Captured',
      priority: 'secondary',
      value: (item) => item.media?.capturedAt ?? null,
      render: (item) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatCaptureDate(item.media?.capturedAt ?? null)}
        </Typography>
      ),
      minWidth: 130,
    },

    // --- detail -------------------------------------------------------------
    {
      id: 'id',
      label: 'Item ID',
      priority: 'detail',
      value: (item) => item.id,
      render: (item) => (
        <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
          {item.id.slice(0, 8)}
        </Typography>
      ),
      width: 140,
    },
  ];
}

/** Default page size for every run-item table. */
export const RUN_ITEMS_PAGE_SIZE = 25;

/** The empty-state node, shared by all three run-item tables. */
export const RUN_ITEMS_EMPTY_STATE: ReactNode = <span>No items to show.</span>;
