/**
 * Tag vocabulary — the DataTable declaration for the Tags admin surface
 * (issue #259).
 *
 * ## The generic CSV export is DISABLED on this table
 *
 * `GET /api/tag-labels/export` / `POST /api/tag-labels/import` are a round trip:
 * the exported file carries the `id` column the importer needs to update or
 * delete a row. A generic column-visibility-shaped CSV would look like the same
 * file and silently fail to re-import, so the page passes `disableExport` and
 * keeps its own two buttons (docs/specs/datatable.md §16.4).
 *
 * ## Pagination is client-side, and that is not a contract violation
 *
 * `GET /api/tag-labels` returns the entire vocabulary in one response — there is
 * no server-side page to ask for. The DataTable still never slices `rows`; the
 * PAGE slices, exactly as it owns every other piece of controlled state. The
 * paging exists at all because a vocabulary is user-grown and the MIT DataGrid
 * throws above 100 rows on one page.
 */

import { Switch, Typography } from '@mui/material';
import type { DataTableColumn } from '../../components/datatable';
import type { TagLabel } from '../../services/tagLabels';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const TAG_LABELS_TABLE_ID = 'admin-tag-labels';

/** Rows per page for the client-side slice. */
export const TAG_LABELS_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export interface TagColumnHandlers {
  /** Flips a label's `enabled` flag. Wired to the in-cell switch. */
  onToggleEnabled: (label: TagLabel, enabled: boolean) => void;
}

/**
 * The three tag columns.
 *
 * Priorities:
 *   - primary   — Name
 *   - secondary — Enabled (the switch, live in the cell AND on the card)
 *   - detail    — Updated
 */
export function buildTagColumns({
  onToggleEnabled,
}: TagColumnHandlers): DataTableColumn<TagLabel>[] {
  return [
    {
      id: 'name',
      label: 'Name',
      priority: 'primary',
      value: (label) => label.name,
      minWidth: 200,
      flex: 1,
    },
    {
      id: 'enabled',
      label: 'Enabled',
      priority: 'secondary',
      // The scalar the CSV would carry if this table exported one; it does not
      // (see the module docblock), but the switch still needs a value behind it
      // for the card's label/value pair to make sense.
      value: (label) => (label.enabled ? 'true' : 'false'),
      render: (label) => (
        <Switch
          size="small"
          checked={label.enabled}
          onChange={(event) => onToggleEnabled(label, event.target.checked)}
          // On the INPUT, not the root span: MUI v9 spreads bare props onto the
          // wrapper, which carries no role, leaving the `switch` element itself
          // nameless to assistive tech.
          slotProps={{ input: { 'aria-label': `Toggle ${label.name}` } }}
        />
      ),
      width: 120,
    },
    {
      id: 'updatedAt',
      label: 'Updated',
      priority: 'detail',
      value: (label) => label.updatedAt,
      render: (label) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {label.updatedAt ? new Date(label.updatedAt).toLocaleDateString() : '—'}
        </Typography>
      ),
      minWidth: 140,
    },
  ];
}
