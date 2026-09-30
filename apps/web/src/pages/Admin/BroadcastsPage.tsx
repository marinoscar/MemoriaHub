/**
 * Admin → Operations → Broadcasts (`/admin/settings/broadcasts`). Epic #481,
 * issue #488 (ported from the reference implementation).
 *
 * A registry card and nothing else, per the Settings UI Pattern: one entry in
 * `ADMIN_SECTIONS` gated on the exact permission the API enforces
 * (`broadcasts:read`), one route, no tab. Writes need `broadcasts:write`; the
 * New button and every write action are then DISABLED WITH A REASON, never
 * absent, so the control set does not change shape between a read-only admin
 * and a writing one.
 *
 * Row actions are disabled by status too — a `sent` broadcast cannot be
 * cancelled, a `sending` one cannot be deleted, only a `failed` one resumes —
 * mirroring the API's own 409s (`services/broadcasts.ts` predicates).
 *
 * POLLING IS OFF UNLESS SOMETHING IS IN FLIGHT (`scheduled` or `sending`); see
 * `hooks/useBroadcasts.ts`. The open detail dialog follows the polled list, so
 * an operator watching one send sees its progress move.
 *
 * No selection column and no bulk bar: no endpoint takes a set of ids.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Container, Paper, Snackbar, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import CancelScheduleSendOutlinedIcon from '@mui/icons-material/CancelScheduleSendOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import ReplayOutlinedIcon from '@mui/icons-material/ReplayOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { Navigate } from 'react-router-dom';
import { DataTable } from '../../components/datatable';
import type { DataTableFilterModel, DataTableRowAction } from '../../components/datatable';
import { AdminPageHeader } from '../../components/admin/AdminPageHeader';
import { BroadcastComposer } from '../../components/admin/BroadcastComposer';
import { BroadcastDetailDialog } from '../../components/admin/BroadcastDetailDialog';
import { usePermissions } from '../../hooks/usePermissions';
import {
  BROADCASTS_POLL_INTERVAL_MS,
  useBroadcastActions,
  useBroadcasts,
  useVisiblePolling,
} from '../../hooks/useBroadcasts';
import {
  getBroadcast,
  getBroadcastAudience,
  getBroadcasts,
  isBroadcastCancelable,
  isBroadcastDeletable,
  isBroadcastResumable,
} from '../../services/broadcasts';
import type { Broadcast, BroadcastListParams } from '../../services/broadcasts';
import {
  STATUS_COLUMN_ID,
  TABLE_ID,
  asBroadcastStatus,
  buildBroadcastColumns,
  cancelDescription,
  deleteDescription,
  readIsFilter,
  resumeDescription,
} from './broadcastsTable';

const PAGE_TITLE = 'Broadcasts';
const PAGE_DESCRIPTION =
  'Write an announcement for every active user, send it now or schedule it, and watch it go out.';

function BroadcastsContent() {
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('broadcasts:write');

  const { broadcasts, total, isLoading, error, fetchBroadcasts, refresh } = useBroadcasts();

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [filters, setFilters] = useState<DataTableFilterModel>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [audience, setAudience] = useState<number | null>(null);

  const [detail, setDetail] = useState<Broadcast | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // A scalar, never the filters array — an effect keyed on the array refetches forever.
  const status = asBroadcastStatus(readIsFilter(filters, STATUS_COLUMN_ID));

  const query = useMemo<BroadcastListParams>(
    () => ({ page: page + 1, pageSize, ...(status ? { status } : {}) }),
    [page, pageSize, status],
  );

  useEffect(() => {
    void fetchBroadcasts(query);
  }, [fetchBroadcasts, query]);

  const actions = useBroadcastActions(refresh);

  const anyInFlight = broadcasts.some(
    (broadcast) => broadcast.status === 'scheduled' || broadcast.status === 'sending',
  );
  useVisiblePolling(refresh, anyInFlight ? BROADCASTS_POLL_INTERVAL_MS : 0);

  // The open detail follows the polled list, so its progress moves live.
  useEffect(() => {
    if (!detail) return;
    const fresh = broadcasts.find((broadcast) => broadcast.id === detail.id);
    if (fresh && fresh.updatedAt !== detail.updatedAt) setDetail(fresh);
  }, [broadcasts, detail]);

  // Re-read the audience every time the composer opens: a page left open for
  // an afternoon must not confirm a send against a number counted hours ago.
  useEffect(() => {
    if (!composerOpen) return undefined;
    let canceled = false;
    setAudience(null);
    getBroadcastAudience()
      .then((result) => {
        if (!canceled) setAudience(result.activeUsers);
      })
      .catch(() => {
        // Silent: the composer degrades to "all active users", which is true.
        if (!canceled) setAudience(null);
      });
    return () => {
      canceled = true;
    };
  }, [composerOpen]);

  const columns = useMemo(() => buildBroadcastColumns(), []);

  const openDetail = useCallback(async (broadcast: Broadcast) => {
    setDetailOpen(true);
    setDetail(broadcast);
    setDetailError(null);
    setDetailLoading(true);
    try {
      setDetail(await getBroadcast(broadcast.id));
    } catch {
      setDetailError('Failed to load the latest state of this broadcast.');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleCancel = useCallback(
    async (broadcast: Broadcast) => {
      const result = await actions.cancel(broadcast.id);
      if (result) {
        setNotice('Broadcast canceled.');
        setDetail((current) => (current?.id === result.id ? result : current));
      }
      return result !== null;
    },
    [actions],
  );

  const handleResume = useCallback(
    async (broadcast: Broadcast) => {
      const result = await actions.resume(broadcast.id);
      if (result) {
        setNotice('Broadcast resumed.');
        setDetail((current) => (current?.id === result.id ? result : current));
      }
      return result !== null;
    },
    [actions],
  );

  const handleDelete = useCallback(
    async (broadcast: Broadcast) => {
      const ok = await actions.remove(broadcast.id);
      if (ok) setNotice('Broadcast deleted.');
      return ok;
    },
    [actions],
  );

  const rowActions = useMemo(
    () =>
      [
        {
          id: 'view',
          label: 'View broadcast',
          icon: <VisibilityOutlinedIcon fontSize="small" />,
          onClick: (broadcast) => void openDetail(broadcast),
        },
        {
          id: 'resume',
          label: 'Resume broadcast',
          icon: <ReplayOutlinedIcon fontSize="small" />,
          disabled: (broadcast) => !canWrite || !isBroadcastResumable(broadcast) || actions.isWorking,
          confirm: {
            title: 'Resume this broadcast?',
            description: resumeDescription,
            confirmLabel: 'Resume broadcast',
          },
          onClick: (broadcast) => void handleResume(broadcast),
        },
        {
          id: 'cancel',
          label: 'Cancel broadcast',
          icon: <CancelScheduleSendOutlinedIcon fontSize="small" />,
          disabled: (broadcast) => !canWrite || !isBroadcastCancelable(broadcast) || actions.isWorking,
          confirm: {
            title: 'Cancel this broadcast?',
            description: cancelDescription,
            confirmLabel: 'Cancel broadcast',
          },
          onClick: (broadcast) => void handleCancel(broadcast),
        },
        {
          id: 'delete',
          label: 'Delete broadcast',
          icon: <DeleteIcon fontSize="small" />,
          destructive: true,
          disabled: (broadcast) => !canWrite || !isBroadcastDeletable(broadcast) || actions.isWorking,
          confirm: {
            title: 'Delete this broadcast?',
            description: deleteDescription,
            confirmLabel: 'Delete',
          },
          onClick: (broadcast) => void handleDelete(broadcast),
        },
      ] satisfies DataTableRowAction<Broadcast>[],
    [canWrite, actions.isWorking, openDetail, handleResume, handleCancel, handleDelete],
  );

  const emptyState = useMemo(
    () => (
      <Typography color="text.secondary">
        {filters.length > 0 ? 'No broadcasts match these filters' : 'Nothing has been announced yet'}
      </Typography>
    ),
    [filters.length],
  );

  return (
    <>
      <AdminPageHeader
        icon={<CampaignOutlinedIcon color="primary" />}
        title={PAGE_TITLE}
        description={
          <>
            {PAGE_DESCRIPTION}
            {!canWrite && ' (read-only)'}
          </>
        }
        actions={
          <Tooltip
            title={
              canWrite
                ? 'Compose an announcement for every active user'
                : 'You need the broadcasts:write permission to send a broadcast'
            }
          >
            <span>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                disabled={!canWrite || actions.isWorking}
                onClick={() => setComposerOpen(true)}
              >
                New broadcast
              </Button>
            </span>
          </Tooltip>
        }
      />

      {actions.error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={actions.clearError}>
          {actions.error}
        </Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Paper sx={{ width: '100%', p: { xs: 1, sm: 2 } }}>
        <Box sx={{ minWidth: 0 }}>
          <DataTable<Broadcast>
            tableId={TABLE_ID}
            ariaLabel="Broadcasts"
            columns={columns}
            rows={broadcasts}
            rowId={(broadcast) => broadcast.id}
            loading={isLoading}
            emptyState={emptyState}
            pagination={{
              page,
              pageSize,
              total,
              pageSizeOptions: [10, 20, 50, 100],
              onPaginationChange: (next) => {
                setPage(next.page);
                setPageSize(next.pageSize);
              },
            }}
            filters={filters}
            onFiltersChange={(next) => {
              setFilters(next);
              setPage(0);
            }}
            rowActions={rowActions}
            csvExport={{
              filename: 'broadcasts',
              fetchAllRows: async ({ page: exportPage, pageSize: exportPageSize }) => {
                const response = await getBroadcasts({
                  ...query,
                  page: exportPage + 1,
                  pageSize: exportPageSize,
                });
                return response.items;
              },
            }}
          />
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          Newest first.{' '}
          {anyInFlight
            ? `Something is queued or sending, so the list refreshes every ${
                BROADCASTS_POLL_INTERVAL_MS / 1000
              } seconds while this tab is visible.`
            : 'Nothing is queued or sending, so the list is not being refreshed automatically.'}
        </Typography>
      </Paper>

      <BroadcastComposer
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        audience={audience}
        isWorking={actions.isWorking}
        onSubmit={async (body) => {
          const result = await actions.create(body);
          if (!result) return false;
          setNotice(
            result.scheduledFor
              ? 'Broadcast scheduled. You can cancel it until it starts sending.'
              : 'Broadcast queued. It starts sending immediately.',
          );
          return true;
        }}
        onSendTest={(body) => actions.sendTest(body)}
      />

      <BroadcastDetailDialog
        open={detailOpen}
        broadcast={detail}
        isLoading={detailLoading}
        error={detailError}
        canWrite={canWrite}
        isWorking={actions.isWorking}
        onClose={() => {
          setDetailOpen(false);
          setDetail(null);
        }}
        onCancel={handleCancel}
        onResume={handleResume}
        onDelete={handleDelete}
      />

      <Snackbar
        open={notice !== null}
        autoHideDuration={6000}
        onClose={() => setNotice(null)}
        message={notice}
      />
    </>
  );
}

export default function BroadcastsPage() {
  const { hasPermission } = usePermissions();

  if (!hasPermission('broadcasts:read')) {
    return <Navigate to="/" replace />;
  }

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: { xs: 2, sm: 4 } }}>
        <BroadcastsContent />
      </Box>
    </Container>
  );
}
