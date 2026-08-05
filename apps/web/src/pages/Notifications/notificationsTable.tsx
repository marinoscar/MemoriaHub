/**
 * Notification Center — the DataTable declaration for `/notifications` (#250).
 *
 * Split out of `NotificationsPage.tsx` for the same reason `jobsTable.tsx` was
 * split out of `JobsPage.tsx` (issue #258): the column set and the pure
 * filter-model → query-param mapping are the two halves worth testing without
 * mounting a page that owns network state.
 *
 * ## Why the shared DataTable and not a bespoke list
 *
 * Epic #238 exists to delete page-level `<TableContainer>`s, and this page
 * would otherwise have grown one: it needs server-side pagination, a
 * responsive layout, per-row actions with a confirm step, and a circle filter.
 * All four are the component's. What the inbox needs *beyond* a table — a
 * whole-row tap that navigates — is expressed as an interactive PRIMARY cell
 * (see {@link TitleCell}), which both renderers draw verbatim: the grid puts it
 * in the first column, the card list makes it the headline.
 *
 * ## What is deliberately absent
 *
 * - **No `sortable` column.** `GET /api/notifications` orders by
 *   `(createdAt DESC, id DESC)` and accepts no sort param, so a sortable header
 *   would be the "looks live, does nothing" affordance the contract refuses.
 * - **No `quickSearch`.** The endpoint has no free-text param.
 * - **No `selection` / `bulkActions`.** The only bulk endpoints are
 *   `read-all` / `dismiss-all`, which take a scope (`{}` or `{circleId}`) and
 *   NOT a list of ids. Page-scoped selection could not be honoured, so the two
 *   bulk operations live in the page header where their real scope is visible.
 * - **No `status` filter column.** The tabs own `status` (issue #250 specifies
 *   them); a second control for the same param is worse than one.
 *
 * ## The `circleId` column carries the one filter this page does have
 *
 * Its cell shows the circle NAME (that is what a reader wants), while its enum
 * operands are circle IDs (that is what the endpoint wants). The chip strip
 * resolves the id back to a label through `enumValues`, so the user never sees
 * a UUID. `null` circleId — a global row such as `enrichment_failed` — is
 * rendered as an explicit "All circles" rather than a bare dash.
 */

import { Box, Chip, Link as MuiLink, Tooltip, Typography } from '@mui/material';
import type {
  DataTableColumn,
  DataTableEnumValue,
  DataTableFilterModel,
} from '../../components/datatable';
import { notificationMeta } from '../../components/notifications/notificationMeta';
import { relativeTime } from '../../utils/formatBytes';
import type { NotificationItem } from '../../types/notifications';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Persistence key for the user's column/density choices
 * (`user_settings.dataTables['notifications']`). Chosen by the page and never
 * derived from the route — it is the storage key, so it must survive a URL
 * change.
 */
export const NOTIFICATIONS_TABLE_ID = 'notifications';

/** Column id of the circle filter. Exported so the page can read it back. */
export const CIRCLE_COLUMN_ID = 'circleId';

/** Minimum comfortable touch target (WCAG 2.5.5 / Material). */
const TOUCH_TARGET = 44;

/** Local copy of MUI's `visuallyHidden` style object. */
const visuallyHidden = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute' as const,
  whiteSpace: 'nowrap' as const,
  width: '1px',
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type NotificationRowStatus = 'Unread' | 'Read' | 'Dismissed';

/**
 * The row's own state, independent of which tab is showing it.
 *
 * Dismissed wins over read/unread because dismissal implies read server-side
 * (`dismiss()` sets `read_at = COALESCE(read_at, now())`), so a dismissed row
 * would otherwise always read as "Read" and the Dismissed tab would carry no
 * per-row signal at all.
 */
export function notificationStatus(notification: NotificationItem): NotificationRowStatus {
  if (notification.dismissedAt) return 'Dismissed';
  return notification.readAt ? 'Read' : 'Unread';
}

const STATUS_COLORS: Record<NotificationRowStatus, 'primary' | 'default'> = {
  Unread: 'primary',
  Read: 'default',
  Dismissed: 'default',
};

// ---------------------------------------------------------------------------
// Filter-model → query param (pure)
// ---------------------------------------------------------------------------

/**
 * Read the active circle scope out of the normalized filter model.
 *
 * Returns `undefined` for "every circle", which is exactly what both
 * `GET /api/notifications` and the two bulk endpoints treat as unscoped — so
 * this one value feeds the list query AND `markAllRead(circleId)` /
 * `dismissAll(circleId)` without a second mapping.
 *
 * Only a COMPLETE `is` filter counts: a draft the user is still composing
 * carries `value: ''`, and sending that as `circleId=` would scope the whole
 * page to a circle that does not exist.
 */
export function circleScopeFromFilters(filters: DataTableFilterModel): string | undefined {
  const filter = filters.find(
    (f) => f.columnId === CIRCLE_COLUMN_ID && f.operator === 'is',
  );
  return typeof filter?.value === 'string' && filter.value ? filter.value : undefined;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

interface TitleCellProps {
  notification: NotificationItem;
  onOpen: (notification: NotificationItem) => void;
}

/**
 * The primary cell: type icon, the title as the row's tap target, unread dot.
 *
 * The title is a real `button` (via `Link component="button"`) rather than an
 * anchor, because opening a notification is not a plain navigation: it marks
 * the row read and, for a circle-scoped row, switches the active circle FIRST
 * (see `NotificationsPage.handleOpen`). A row with no `link` renders as plain
 * text — a control that navigates nowhere is worse than no control.
 *
 * `minHeight: 44` is the touch-target floor (issue #243). It fits the grid's
 * `standard` 52px row, which is why the page does not run this table compact.
 */
function TitleCell({ notification, onOpen }: TitleCellProps) {
  const meta = notificationMeta(notification.type);
  const isUnread = notification.readAt === null && notification.dismissedAt === null;

  const titleSx = {
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical' as const,
    overflow: 'hidden',
    fontWeight: isUnread ? 700 : 400,
    textAlign: 'left' as const,
    overflowWrap: 'anywhere' as const,
  };

  return (
    <Box
      sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0, width: '100%' }}
    >
      <Tooltip title={meta.label}>
        <Box
          aria-hidden
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            width: 28,
            height: 28,
            borderRadius: '50%',
            color: `${meta.tone}.main`,
            backgroundColor: 'action.selected',
          }}
        >
          {meta.icon}
        </Box>
      </Tooltip>

      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
        {notification.link ? (
          <MuiLink
            component="button"
            type="button"
            underline="hover"
            variant="body2"
            color="inherit"
            onClick={() => onOpen(notification)}
            sx={{
              ...titleSx,
              minHeight: TOUCH_TARGET,
              width: '100%',
              background: 'none',
              border: 0,
              p: 0,
              cursor: 'pointer',
            }}
          >
            {notification.title}
          </MuiLink>
        ) : (
          <Typography variant="body2" component="div" sx={titleSx}>
            {notification.title}
          </Typography>
        )}
      </Box>

      {isUnread && (
        <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          <Box
            aria-hidden
            sx={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: 'primary.main' }}
          />
          <Box component="span" sx={visuallyHidden}>
            Unread
          </Box>
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export interface NotificationColumnOptions {
  /** circleId → display name, for the circle cell. */
  circleNames: Map<string, string>;
  /** Circle options for the enum filter. Operands are circle IDs. */
  circleOptions: DataTableEnumValue[];
  /** Tap handler for the primary cell. */
  onOpen: (notification: NotificationItem) => void;
}

/**
 * The six columns, in `priority` order:
 *
 *   - primary   — Notification (icon + title + unread dot)
 *   - secondary — Message, Circle, Received  (+ the Actions column the
 *                 DataTable appends for `rowActions`)
 *   - detail    — Status, Type
 *
 * So a phone card leads with the title and folds Status/Type behind
 * "More details"; a tablet keeps the four and reaches the rest through the row
 * expander; a desktop shows everything. Status sits in `detail` on purpose —
 * unread state is already carried in the primary cell (bold + dot), and two
 * of the three tabs make it redundant.
 */
export function buildNotificationColumns({
  circleNames,
  circleOptions,
  onOpen,
}: NotificationColumnOptions): DataTableColumn<NotificationItem>[] {
  return [
    {
      id: 'title',
      label: 'Notification',
      priority: 'primary',
      minWidth: 260,
      flex: 2,
      hideable: false,
      value: (n) => n.title,
      render: (n) => <TitleCell notification={n} onOpen={onOpen} />,
    },
    {
      id: 'body',
      label: 'Message',
      priority: 'secondary',
      minWidth: 200,
      flex: 2,
      truncate: true,
      value: (n) => n.body ?? '',
    },
    {
      id: CIRCLE_COLUMN_ID,
      label: 'Circle',
      priority: 'secondary',
      minWidth: 160,
      filterable: ['is'],
      filterType: 'enum',
      enumValues: circleOptions,
      // The cell shows the NAME; the filter operand is the ID (see the module
      // docblock). An id with no matching circle — a notification that outlived
      // the user's membership — falls back to a muted "Unknown circle" rather
      // than printing a UUID.
      value: (n) =>
        n.circleId === null ? 'All circles' : (circleNames.get(n.circleId) ?? 'Unknown circle'),
    },
    {
      id: 'createdAt',
      label: 'Received',
      priority: 'secondary',
      minWidth: 130,
      value: (n) => n.createdAt,
      render: (n) => (
        <Tooltip title={new Date(n.createdAt).toLocaleString()}>
          <Typography variant="body2" color="text.secondary" component="span">
            {relativeTime(n.createdAt)}
          </Typography>
        </Tooltip>
      ),
    },
    {
      id: 'status',
      label: 'Status',
      priority: 'detail',
      minWidth: 120,
      value: (n) => notificationStatus(n),
      render: (n) => {
        const status = notificationStatus(n);
        return (
          <Chip
            label={status}
            size="small"
            variant="outlined"
            color={STATUS_COLORS[status]}
          />
        );
      },
    },
    {
      id: 'type',
      label: 'Type',
      priority: 'detail',
      minWidth: 160,
      value: (n) => notificationMeta(n.type).label,
    },
  ];
}
