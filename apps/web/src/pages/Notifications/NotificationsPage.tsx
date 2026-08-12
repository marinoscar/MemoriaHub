/**
 * Notification Center — `/notifications` (issue #250, epic #240).
 *
 * The full inbox behind the AppBar bell: every notification, paginated,
 * filterable by status (tabs) and by circle (the DataTable filter bar), with
 * the two bulk operations the API offers.
 *
 * ## One poller, three surfaces
 *
 * The unread badge on the bell (#249), the sidebar entry (#250) and every
 * mutation on this page all go through the SAME module-level store,
 * `useNotifications`. This page adds no timer of its own — it only fetches a
 * page of rows on demand through `useNotificationList`. So a user sitting on
 * this page still issues exactly one background request per minute (the badge
 * count), not two.
 *
 * The division of labour, restated because it is easy to break:
 *
 *   - `useNotifications` — unread count + mutations (`markRead`, `dismiss`,
 *     `markAllRead`). Every write goes through it so the badge cannot drift.
 *   - `useNotificationList` — this page's `items` + `meta`. Re-fetched
 *     SILENTLY after each mutation so rows swap in place.
 *
 * `dismissAll` is the one write with no store method (the store has no
 * optimistic model for "dismiss rows I have never loaded"), so the page calls
 * the service directly and then reconciles the store with `refreshCount()` +
 * `refreshList()`.
 *
 * ## Circle-switch-then-navigate
 *
 * Identical to `NotificationPanel.handleOpenNotification` (#249) and for the
 * same reason: the review-queue links are circle-AGNOSTIC routes (`/bursts`,
 * `/duplicates`, …) that render whatever circle is active, so tapping a row
 * for a non-active circle must switch the active circle first or the user
 * lands on the right page showing the wrong circle's data. The membership
 * guard is also carried over verbatim — a notification can outlive the user's
 * access to its circle, and persisting an id that resolves to no circle leaves
 * the whole app stuck with no active circle. `circles.length === 0` means "not
 * loaded yet", never "member of nothing".
 *
 * ## Bulk confirmation
 *
 * Both bulk actions confirm above {@link BULK_CONFIRM_THRESHOLD} affected rows,
 * matching the gallery's convention (`BulkActionToolbar`, >25 items). The count
 * is not guessed: the page asks the server for `meta.totalItems` under exactly
 * the scope the bulk call will use, so the dialog states a real number and a
 * no-op is caught before any write.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import DoneIcon from '@mui/icons-material/DoneOutlined';
import NotificationsNoneIcon from '@mui/icons-material/NotificationsNone';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  DataTable,
  type DataTableFilterModel,
  type DataTableRowAction,
} from '../../components/datatable';
import { useCircle } from '../../hooks/useCircle';
import { useNotifications } from '../../hooks/useNotifications';
import { useNotificationList } from '../../hooks/useNotificationList';
import { dismissAllNotifications, listNotifications } from '../../services/notifications';
import {
  NOTIFICATIONS_TABLE_ID,
  buildNotificationColumns,
  circleScopeFromFilters,
} from './notificationsTable';
import type {
  NotificationItem,
  NotificationStatusFilter,
} from '../../types/notifications';

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/**
 * Tab keys. These are the `?status=` values on the wire AND the endpoint's own
 * `status` param, so they are part of the page's URL contract — renaming one
 * breaks a bookmark and a query at the same time.
 */
const TABS = ['unread', 'all', 'dismissed'] as const;
type NotificationsTab = (typeof TABS)[number];

const DEFAULT_TAB: NotificationsTab = 'unread';

function parseTab(raw: string | null): NotificationsTab {
  return (TABS as readonly string[]).includes(raw ?? '')
    ? (raw as NotificationsTab)
    : DEFAULT_TAB;
}

const DEFAULT_PAGE_SIZE = 25;

/** Affected-row count above which a bulk action confirms first. */
export const BULK_CONFIRM_THRESHOLD = 25;

type BulkKind = 'read' | 'dismiss';

interface PendingBulk {
  kind: BulkKind;
  count: number;
}

const EMPTY_STATE_TEXT: Record<NotificationsTab, string> = {
  unread: "You're all caught up",
  all: 'No notifications yet',
  dismissed: 'Nothing dismissed',
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function NotificationsPage() {
  const navigate = useNavigate();
  const { circles, activeCircleId, setActiveCircle } = useCircle();
  const {
    unreadCount,
    markRead,
    dismiss,
    markAllRead,
    refreshCount,
    refreshList,
  } = useNotifications();

  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<NotificationsTab>(() =>
    parseTab(searchParams.get('status')),
  );
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [filters, setFilters] = useState<DataTableFilterModel>([]);

  const [pendingBulk, setPendingBulk] = useState<PendingBulk | null>(null);
  const [busy, setBusy] = useState(false);
  const [snack, setSnack] = useState<{
    message: string;
    severity: 'success' | 'error' | 'info';
  } | null>(null);

  // Mirror a non-default tab to the URL so the view is shareable/restorable.
  // `searchParams` is deliberately excluded from the deps — including it would
  // re-run on every replace and loop (same rationale as EnhancementsPage).
  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    if (tab !== DEFAULT_TAB) params.set('status', tab);
    else params.delete('status');
    setSearchParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, setSearchParams]);

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  const circleScope = useMemo(() => circleScopeFromFilters(filters), [filters]);

  const listParams = useMemo(
    () => ({
      // Every tab key IS a valid `status` param value — that is the point of
      // the tuple, and why there is no tab→param lookup table here.
      status: tab satisfies NotificationStatusFilter,
      circleId: circleScope,
      page: page + 1, // the table is zero-based, the API is one-based
      pageSize,
    }),
    [tab, circleScope, page, pageSize],
  );

  const { items, meta, isLoading, error, refresh, reload } =
    useNotificationList(listParams);

  /**
   * A mutation can empty the page the user is standing on (mark the last
   * unread row on page 3 read and page 3 no longer exists). Step back rather
   * than stranding them on a permanently empty page they cannot leave.
   */
  useEffect(() => {
    if (!isLoading && page > 0 && items.length === 0 && (meta?.totalItems ?? 0) > 0) {
      setPage((p) => Math.max(0, p - 1));
    }
  }, [isLoading, items.length, meta?.totalItems, page]);

  // -------------------------------------------------------------------------
  // Circles
  // -------------------------------------------------------------------------

  const circleNames = useMemo(
    () => new Map(circles.map((c) => [c.id, c.name])),
    [circles],
  );

  const circleOptions = useMemo(
    () => circles.map((c) => ({ value: c.id, label: c.name })),
    [circles],
  );

  // -------------------------------------------------------------------------
  // Row interactions
  // -------------------------------------------------------------------------

  /**
   * Open a notification: mark it read, switch the active circle if the row
   * belongs to another one, then navigate. See the module docblock.
   */
  const handleOpen = useCallback(
    (notification: NotificationItem) => {
      if (!notification.readAt) {
        void markRead(notification.id).then(() => reload());
      }

      const circleKnown =
        circles.length === 0 || circles.some((c) => c.id === notification.circleId);

      if (
        notification.circleId &&
        notification.circleId !== activeCircleId &&
        circleKnown
      ) {
        void setActiveCircle(notification.circleId);
      }

      if (notification.link) navigate(notification.link);
    },
    [markRead, reload, circles, activeCircleId, setActiveCircle, navigate],
  );

  const handleMarkRead = useCallback(
    (notification: NotificationItem) => {
      void markRead(notification.id).then(() => reload());
    },
    [markRead, reload],
  );

  const handleDismiss = useCallback(
    (notification: NotificationItem) => {
      void dismiss(notification.id).then(() => reload());
    },
    [dismiss, reload],
  );

  const columns = useMemo(
    () => buildNotificationColumns({ circleNames, circleOptions, onOpen: handleOpen }),
    [circleNames, circleOptions, handleOpen],
  );

  const rowActions = useMemo<DataTableRowAction<NotificationItem>[]>(
    () => [
      {
        id: 'open',
        label: 'Open',
        icon: <OpenInNewIcon fontSize="small" />,
        onClick: handleOpen,
        disabled: (n) => !n.link,
      },
      {
        id: 'mark-read',
        label: 'Mark as read',
        icon: <DoneIcon fontSize="small" />,
        onClick: handleMarkRead,
        disabled: (n) => n.readAt !== null,
      },
      {
        id: 'dismiss',
        label: 'Dismiss',
        icon: <CloseIcon fontSize="small" />,
        onClick: handleDismiss,
        disabled: (n) => n.dismissedAt !== null,
      },
    ],
    [handleOpen, handleMarkRead, handleDismiss],
  );

  // -------------------------------------------------------------------------
  // Bulk actions
  // -------------------------------------------------------------------------

  /**
   * How many rows a bulk action would actually touch, under exactly the scope
   * it will use.
   *
   * `read-all` flips live, unread rows (`status=unread`); `dismiss-all` flips
   * every live row (`status=all`, which the API defines as "not dismissed").
   * `pageSize: 1` because only `meta.totalItems` is wanted.
   */
  const countAffected = useCallback(
    async (kind: BulkKind): Promise<number> => {
      const result = await listNotifications({
        status: kind === 'read' ? 'unread' : 'all',
        circleId: circleScope,
        page: 1,
        pageSize: 1,
      });
      return result.meta?.totalItems ?? 0;
    },
    [circleScope],
  );

  const runBulk = useCallback(
    async (kind: BulkKind) => {
      try {
        if (kind === 'read') {
          // The store owns this write so the badge follows it. `circleScope`
          // is `undefined` when unfiltered, which the store treats as "every
          // circle" and lands on an exact 0.
          await markAllRead(circleScope);
          setSnack({ message: 'All notifications marked as read', severity: 'success' });
        } else {
          // No store method for dismiss-all — call the service, then reconcile
          // the store's count and panel rows rather than guessing at them.
          const result = await dismissAllNotifications(circleScope);
          await Promise.all([refreshCount(), refreshList()]);
          setSnack({
            message: `${result.updated} notification${result.updated === 1 ? '' : 's'} dismissed`,
            severity: 'success',
          });
        }
        await reload();
      } catch (err) {
        setSnack({
          message:
            err instanceof Error
              ? err.message
              : kind === 'read'
                ? 'Failed to mark all as read'
                : 'Failed to dismiss all',
          severity: 'error',
        });
      }
    },
    [markAllRead, circleScope, refreshCount, refreshList, reload],
  );

  /** Confirm above the threshold, otherwise fire immediately. */
  const requestBulk = useCallback(
    async (kind: BulkKind) => {
      setBusy(true);
      try {
        const affected = await countAffected(kind);
        if (affected === 0) {
          setSnack({
            message:
              kind === 'read' ? 'Nothing left to mark as read' : 'Nothing left to dismiss',
            severity: 'info',
          });
          return;
        }
        if (affected > BULK_CONFIRM_THRESHOLD) {
          setPendingBulk({ kind, count: affected });
          return;
        }
        await runBulk(kind);
      } catch (err) {
        setSnack({
          message: err instanceof Error ? err.message : 'Failed to load notifications',
          severity: 'error',
        });
      } finally {
        setBusy(false);
      }
    },
    [countAffected, runBulk],
  );

  const confirmBulk = useCallback(async () => {
    const pending = pendingBulk;
    setPendingBulk(null);
    if (!pending) return;
    setBusy(true);
    try {
      await runBulk(pending.kind);
    } finally {
      setBusy(false);
    }
  }, [pendingBulk, runBulk]);

  // -------------------------------------------------------------------------
  // Handlers that must reset pagination
  // -------------------------------------------------------------------------

  const handleTabChange = useCallback((_: React.SyntheticEvent, next: NotificationsTab) => {
    setTab(next);
    setPage(0);
  }, []);

  const handleFiltersChange = useCallback((next: DataTableFilterModel) => {
    setFilters(next);
    setPage(0);
  }, []);

  const handlePaginationChange = useCallback(
    ({ page: nextPage, pageSize: nextPageSize }: { page: number; pageSize: number }) => {
      setPage(nextPageSize !== pageSize ? 0 : nextPage);
      setPageSize(nextPageSize);
    },
    [pageSize],
  );

  const scopeLabel = circleScope
    ? (circleNames.get(circleScope) ?? 'this circle')
    : 'all circles';

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
        <NotificationsNoneIcon color="primary" />
        <Typography variant="h4" component="h1">
          Notifications
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Everything MemoriaHub has flagged for you, newest first.
      </Typography>

      {/* Header actions */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ mb: 2, alignItems: { xs: 'stretch', sm: 'center' }, flexWrap: 'wrap' }}
      >
        <Button
          variant="outlined"
          startIcon={<DoneAllIcon />}
          disabled={busy || (!circleScope && unreadCount === 0)}
          onClick={() => void requestBulk('read')}
        >
          Mark all as read
        </Button>
        <Button
          variant="outlined"
          color="warning"
          startIcon={<CloseIcon />}
          disabled={busy}
          onClick={() => void requestBulk('dismiss')}
        >
          Dismiss all
        </Button>
        <Button
          variant="outlined"
          startIcon={busy || isLoading ? <CircularProgress size={16} /> : <RefreshIcon />}
          disabled={busy || isLoading}
          onClick={() => void refresh()}
          sx={{ ml: { sm: 'auto' } }}
        >
          Refresh
        </Button>
      </Stack>

      {/* Status tabs */}
      <Paper variant="outlined" sx={{ mb: 2 }}>
        <Tabs value={tab} onChange={handleTabChange} variant="scrollable" scrollButtons="auto">
          <Tab label="Unread" value="unread" />
          <Tab label="All" value="all" />
          <Tab label="Dismissed" value="dismissed" />
        </Tabs>
      </Paper>

      {/*
        Rendered unconditionally: swapping the table for a spinner while loading
        remounts the renderer and takes card-expansion state and scroll position
        with it (the lesson from #258). `loading` is a prop — the overlay draws
        over rows that stay mounted.
      */}
      <DataTable<NotificationItem>
        columns={columns}
        rows={items}
        rowId={(n) => n.id}
        tableId={NOTIFICATIONS_TABLE_ID}
        ariaLabel="Notifications"
        loading={isLoading}
        error={error}
        emptyState={<span>{EMPTY_STATE_TEXT[tab]}</span>}
        pagination={{
          page,
          pageSize,
          total: meta?.totalItems ?? items.length,
          onPaginationChange: handlePaginationChange,
          pageSizeOptions: [10, 25, 50, 100],
        }}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        rowActions={rowActions}
      />

      {/* Bulk confirm (large scopes) */}
      <Dialog
        open={Boolean(pendingBulk)}
        onClose={() => setPendingBulk(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>
          {pendingBulk?.kind === 'read' ? 'Mark' : 'Dismiss'} {pendingBulk?.count}{' '}
          notification{pendingBulk?.count === 1 ? '' : 's'}
          {pendingBulk?.kind === 'read' ? ' as read?' : '?'}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {pendingBulk?.kind === 'read'
              ? `This marks every unread notification in ${scopeLabel} as read.`
              : `This dismisses every notification in ${scopeLabel}. Dismissed notifications stay visible under the Dismissed tab.`}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingBulk(null)}>Cancel</Button>
          <Button variant="contained" onClick={() => void confirmBulk()}>
            {pendingBulk?.kind === 'read' ? 'Mark all as read' : 'Dismiss all'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(snack)}
        autoHideDuration={4000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {snack ? (
          <Alert severity={snack.severity} onClose={() => setSnack(null)} variant="filled">
            {snack.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}
