/**
 * Notification Center — `/notifications` (issue #250, epic #240; the platform
 * notifications slice since RETRO-D3, #576).
 *
 * The full inbox behind the AppBar bell: every notification, paginated and
 * filterable by status (tabs), with the two bulk operations.
 *
 * ## One store, three surfaces
 *
 * The bell, the shell's unread badge and every mutation on this page go
 * through the platform's `NotificationProvider` (`useNotifications()` from
 * `@marinoscar/platform-web/notifications/headless`), which also holds the
 * live stream. This page only fetches a page of rows on demand
 * (`useNotificationList`, over the platform `GET /api/notifications`) and
 * re-fetches it silently after each mutation, so rows swap in place.
 *
 * ## Opening a row
 *
 * A row is marked read and its link followed. A circle's row carries
 * `?c=<circleId>` in its link, which the shell (`useCircleLinkParam`) turns
 * into an active-circle switch before the circle-agnostic route (`/bursts`,
 * `/duplicates`, ...) renders, so a row for another circle never lands on the
 * wrong circle's data.
 *
 * ## Bulk confirmation
 *
 * Both bulk actions confirm above {@link BULK_CONFIRM_THRESHOLD} affected rows,
 * matching the gallery's convention (`BulkActionToolbar`, >25 items). The count
 * is not guessed: the page asks the server for `meta.totalItems` under exactly
 * the scope the bulk call will use, so the dialog states a real number and a
 * no-op is caught before any write. Since RETRO-D3 both act on every circle:
 * the platform list has no scope filter (a documented seam gap).
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
import { DataTable } from '@marinoscar/platform-web/datatable/ui';
import type { DataTableRowAction } from '@marinoscar/platform-web/datatable/headless';
import { useNotifications } from '@marinoscar/platform-web/notifications/headless';
import { useCircle } from '../../hooks/useCircle';
import { useNotificationList } from '../../hooks/useNotificationList';
import { listNotifications } from '../../services/notifications';
import { isInternalLink } from '../../utils/internalLink';
import { NOTIFICATIONS_TABLE_ID, buildNotificationColumns } from './notificationsTable';
import type {
  NotificationItem,
  NotificationStatusFilter,
} from '../../types/notifications';
import { scrollableTabsProps } from '../../components/common/tabs';

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
  const { circles } = useCircle();
  const navigate = useNavigate();
  const store = useNotifications();
  const unreadCount = store?.unreadCount ?? 0;
  const markRead = useCallback(async (id: string) => store?.markRead(id), [store]);
  const dismiss = useCallback(async (id: string) => store?.dismiss(id), [store]);

  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<NotificationsTab>(() =>
    parseTab(searchParams.get('status')),
  );
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

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

  const listParams = useMemo(
    () => ({
      // Every tab key IS a valid `status` param value — that is the point of
      // the tuple, and why there is no tab→param lookup table here.
      status: tab satisfies NotificationStatusFilter,
      page: page + 1, // the table is zero-based, the API is one-based
      pageSize,
    }),
    [tab, page, pageSize],
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

  // -------------------------------------------------------------------------
  // Row interactions
  // -------------------------------------------------------------------------

  /** Open a notification: mark it read, then follow its link. See the module docblock. */
  const handleOpen = useCallback(
    (notification: NotificationItem) => {
      if (!notification.readAt) {
        void markRead(notification.id).then(() => reload());
      }
      if (isInternalLink(notification.link)) navigate(notification.link);
    },
    [markRead, reload, navigate],
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
    () => buildNotificationColumns({ circleNames, onOpen: handleOpen }),
    [circleNames, handleOpen],
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
        page: 1,
        pageSize: 1,
      });
      return result.meta?.totalItems ?? 0;
    },
    [],
  );

  const runBulk = useCallback(
    async (kind: BulkKind, count: number) => {
      try {
        if (!store) throw new Error('Notifications are unavailable');
        // The provider owns both writes, so the badge and the bell follow them.
        if (kind === 'read') {
          await store.markAllRead();
          setSnack({ message: 'All notifications marked as read', severity: 'success' });
        } else {
          await store.dismissAll();
          setSnack({
            message: `${count} notification${count === 1 ? '' : 's'} dismissed`,
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
    [store, reload],
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
        await runBulk(kind, affected);
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
      await runBulk(pending.kind, pending.count);
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

  const handlePaginationChange = useCallback(
    ({ page: nextPage, pageSize: nextPageSize }: { page: number; pageSize: number }) => {
      setPage(nextPageSize !== pageSize ? 0 : nextPage);
      setPageSize(nextPageSize);
    },
    [pageSize],
  );

  const scopeLabel = 'all circles';

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
          disabled={busy || unreadCount === 0}
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
        <Tabs {...scrollableTabsProps} value={tab} onChange={handleTabChange}>
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
