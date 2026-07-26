import { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
  Alert,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Badge,
  Snackbar,
  Pagination,
  Button,
  IconButton,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from '@mui/material';
import {
  BurstMode as BurstModeIcon,
  Settings as SettingsIcon,
  Archive as ArchiveIcon,
  Delete as DeleteIcon,
  Block as BlockIcon,
} from '@mui/icons-material';
import { useNavigate, useSearchParams, Link as RouterLink } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { useBurstGroups } from '../../hooks/useBursts';
import { GroupBulkResolveToolbar } from '../../components/review/GroupBulkResolveToolbar';
import { SelectionCheckboxOverlay } from '../../components/review/SelectionCheckboxOverlay';
import { ConfidenceMeter } from '../../components/review/ConfidenceMeter';
import { ReviewSortSelect } from '../../components/review/ReviewSortSelect';
import type { BurstGroupSummary, BurstSortBy, GroupResolveAction } from '../../services/bursts';
import type { SortOrder } from '../../types/media';

// Safety ceiling for the threshold auto-loop so a misbehaving backend can never
// spin forever. Each iteration resolves a bounded batch of eligible groups.
const MAX_THRESHOLD_ITERATIONS = 100;

// ---------------------------------------------------------------------------
// Sort model. The API defaults to `capturedAt` / `asc`, so those two values are
// never sent on the wire — an untouched page issues exactly the request it did
// before this control existed.
// ---------------------------------------------------------------------------

const DEFAULT_SORT_BY: BurstSortBy = 'capturedAt';
const DEFAULT_SORT_ORDER: SortOrder = 'asc';

const SORT_BY_VALUES: BurstSortBy[] = ['capturedAt', 'confidence', 'mediaCount'];

const SORT_OPTIONS = [
  { value: 'capturedAt:asc', label: 'Captured — Oldest' },
  { value: 'capturedAt:desc', label: 'Captured — Newest' },
  { value: 'confidence:desc', label: 'Cohesion — Highest' },
  { value: 'confidence:asc', label: 'Cohesion — Lowest' },
  { value: 'mediaCount:desc', label: 'Largest group' },
  { value: 'mediaCount:asc', label: 'Smallest group' },
];

/** Coerce an untrusted URL value to a supported column, else the page default. */
function parseSortBy(raw: string | null): BurstSortBy {
  return SORT_BY_VALUES.includes(raw as BurstSortBy) ? (raw as BurstSortBy) : DEFAULT_SORT_BY;
}

/** Coerce an untrusted URL value to a supported direction, else the page default. */
function parseSortOrder(raw: string | null): SortOrder {
  return raw === 'asc' || raw === 'desc' ? raw : DEFAULT_SORT_ORDER;
}

function CoverStack({ coverUrls, mediaCount }: { coverUrls: string[]; mediaCount: number }) {
  return (
    <Box sx={{ position: 'relative', width: 120, height: 90, flexShrink: 0, isolation: 'isolate' }}>
      {coverUrls.slice(0, 3).map((url, i) => (
        <Box
          key={i}
          component="img"
          src={url}
          alt=""
          sx={{
            position: 'absolute',
            top: i * 4,
            left: i * 4,
            width: 100,
            height: 80,
            objectFit: 'cover',
            borderRadius: 1,
            border: '2px solid',
            borderColor: 'background.paper',
            boxShadow: 1,
            zIndex: coverUrls.length - i,
          }}
        />
      ))}
      <Badge
        badgeContent={mediaCount}
        color="primary"
        sx={{ position: 'absolute', top: 2, right: 2, zIndex: 10 }}
      />
    </Box>
  );
}

interface BurstGroupCardProps {
  group: BurstGroupSummary;
  selected: boolean;
  onToggle: (id: string) => void;
}

function BurstGroupCard({ group, selected, onToggle }: BurstGroupCardProps) {
  const navigate = useNavigate();

  const capturedDate = group.capturedAt
    ? new Date(group.capturedAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;

  return (
    <Card variant="outlined" sx={{ position: 'relative' }}>
      {/* Selection checkbox overlay — sibling of the action area to avoid nested buttons */}
      <SelectionCheckboxOverlay
        checked={selected}
        onToggle={() => onToggle(group.id)}
        ariaLabel="Select burst group"
      />
      <CardActionArea
        onClick={() => navigate(`/bursts/${group.id}`)}
        sx={{ display: 'flex', alignItems: 'center', gap: 2, p: 2, justifyContent: 'flex-start' }}
      >
        <CoverStack coverUrls={group.coverThumbnailUrls} mediaCount={group.mediaCount} />
        <CardContent sx={{ flex: 1, p: 0, '&:last-child': { pb: 0 } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
            <Typography variant="subtitle2" component="span">
              {group.mediaCount} photos
            </Typography>
            <Chip label="Pending review" size="small" color="warning" variant="outlined" />
          </Box>
          {capturedDate && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {capturedDate}
            </Typography>
          )}
          <ConfidenceMeter confidence={group.confidence} label="Cohesion" />
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export default function BurstsPage() {
  const { activeCircle, activeCircleId } = useCircle();
  const { hasPermission, isAdmin } = usePermissions();
  const { settings } = useSystemSettings();
  const {
    items,
    meta,
    isLoading,
    error,
    fetchGroups,
    bulkResolve,
    bulkResolveByThreshold,
    dismissByThreshold,
    fetchAllPendingIds,
  } = useBurstGroups();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sortBy, setSortBy] = useState<BurstSortBy>(() => parseSortBy(searchParams.get('sortBy')));
  const [sortOrder, setSortOrder] = useState<SortOrder>(() =>
    parseSortOrder(searchParams.get('sortOrder')),
  );
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [thresholdAction, setThresholdAction] = useState<GroupResolveAction | null>(null);
  const [thresholdLoading, setThresholdLoading] = useState(false);
  const [dismissDialogOpen, setDismissDialogOpen] = useState(false);
  const [dismissLoading, setDismissLoading] = useState(false);

  const canTrash = hasPermission('media:delete');
  const threshold = settings?.burst?.autoResolveThreshold ?? 60;

  useEffect(() => {
    if (!activeCircleId) return;
    void fetchGroups({
      circleId: activeCircleId,
      status: 'pending',
      page,
      // Only non-default values go on the wire, so the default view's request
      // is byte-identical to the pre-sort-control one.
      ...(sortBy !== DEFAULT_SORT_BY ? { sortBy } : {}),
      ...(sortOrder !== DEFAULT_SORT_ORDER ? { sortOrder } : {}),
    });
  }, [activeCircleId, page, sortBy, sortOrder, fetchGroups]);

  // Mirror a non-default sort to the URL so the view is shareable/restorable.
  // `searchParams` is deliberately excluded from the deps — including it would
  // re-run on every replace and loop.
  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    if (sortBy !== DEFAULT_SORT_BY) params.set('sortBy', sortBy);
    else params.delete('sortBy');
    if (sortOrder !== DEFAULT_SORT_ORDER) params.set('sortOrder', sortOrder);
    else params.delete('sortOrder');
    setSearchParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortBy, sortOrder, setSearchParams]);

  useEffect(() => {
    setPage(1);
  }, [activeCircleId, sortBy, sortOrder]);

  // Clear selection whenever the visible set changes (page, sort, or circle).
  useEffect(() => {
    setSelected(new Set());
  }, [page, sortBy, sortOrder, activeCircleId]);

  const handleSortChange = (by: string, order: SortOrder) => {
    setSortBy(parseSortBy(by));
    setSortOrder(order);
  };

  const handleToggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Select ALL pending groups across every page, not just the visible one.
  const handleSelectAll = async () => {
    setActionError(null);
    try {
      const ids = await fetchAllPendingIds();
      setSelected(new Set(ids));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to select all burst groups');
    }
  };

  const handleResolve = async (action: GroupResolveAction) => {
    setActionError(null);
    try {
      const result = await bulkResolve(Array.from(selected), action);
      setSelected(new Set());
      const verb = action === 'trash' ? 'moved to Trash' : 'archived';
      setSuccessMsg(
        `Resolved ${result.resolvedGroups} group${result.resolvedGroups !== 1 ? 's' : ''}; ${result.removedCount} photo${result.removedCount !== 1 ? 's' : ''} ${verb}.`,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to resolve burst groups');
    }
  };

  const handleThresholdConfirm = async () => {
    const action = thresholdAction;
    setThresholdAction(null);
    if (!action || !activeCircleId) return;
    setActionError(null);
    setThresholdLoading(true);
    const verb = action === 'trash' ? 'moved to Trash' : 'archived';
    let totalGroups = 0;
    let totalRemoved = 0;
    let totalSkipped = 0;
    try {
      // The endpoint resolves at most a bounded batch per call and reports how
      // many eligible groups remain. Auto-loop until the queue is drained.
      for (let iteration = 0; iteration < MAX_THRESHOLD_ITERATIONS; iteration += 1) {
        const result = await bulkResolveByThreshold(threshold, action);
        totalGroups += result.resolvedGroups;
        totalRemoved += result.removedCount;
        totalSkipped += result.skipped;
        // Stop if nothing left, or if a batch made no progress (avoids a spin
        // when the remaining groups are all ineligible).
        if (result.remaining <= 0 || result.resolvedGroups === 0) break;
        setSuccessMsg(`Resolved ${totalGroups} group${totalGroups !== 1 ? 's' : ''} so far…`);
      }
      setSelected(new Set());
      const skippedNote = totalSkipped > 0 ? ` (${totalSkipped} skipped)` : '';
      setSuccessMsg(
        `Resolved ${totalGroups} group${totalGroups !== 1 ? 's' : ''}; ${totalRemoved} photo${totalRemoved !== 1 ? 's' : ''} ${verb}${skippedNote}.`,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to resolve burst groups');
      if (totalGroups > 0) {
        setSuccessMsg(
          `Resolved ${totalGroups} group${totalGroups !== 1 ? 's' : ''} before the error.`,
        );
      }
    } finally {
      setThresholdLoading(false);
    }
  };

  const handleDismissConfirm = async () => {
    setDismissDialogOpen(false);
    if (!activeCircleId) return;
    setActionError(null);
    setDismissLoading(true);
    try {
      const result = await dismissByThreshold(threshold);
      setSelected(new Set());
      const skippedNote = result.skipped > 0 ? ` (${result.skipped} skipped)` : '';
      setSuccessMsg(
        `Dismissed ${result.dismissedGroups} group${result.dismissedGroups !== 1 ? 's' : ''}${skippedNote}.`,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to dismiss burst groups');
    } finally {
      setDismissLoading(false);
    }
  };

  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to review burst groups.</Alert>
      </Box>
    );
  }

  const total = meta?.total ?? items.length;
  const pageCount = meta ? Math.max(1, Math.ceil(meta.total / meta.pageSize)) : 1;

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          mb: 3,
          gap: 1,
        }}
      >
        <BurstModeIcon color="primary" />
        <Typography variant="h5" component="h1">
          Review Bursts
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        {isAdmin && (
          <Tooltip title="Burst detection settings">
            <IconButton
              component={RouterLink}
              to="/admin/settings/bursts"
              aria-label="Burst detection settings"
            >
              <SettingsIcon />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {/* Sort control */}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
        <ReviewSortSelect
          value={`${sortBy}:${sortOrder}`}
          onChange={handleSortChange}
          options={SORT_OPTIONS}
        />
      </Box>

      {/* Resolve-above-threshold actions */}
      {items.length > 0 && (
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 2 }}>
          <Button
            variant="outlined"
            color="primary"
            startIcon={<ArchiveIcon />}
            disabled={thresholdLoading || !activeCircleId}
            onClick={() => setThresholdAction('archive')}
          >
            Archive above {threshold}
          </Button>
          {canTrash && (
            <Button
              variant="outlined"
              color="error"
              startIcon={<DeleteIcon />}
              disabled={thresholdLoading || !activeCircleId}
              onClick={() => setThresholdAction('trash')}
            >
              Delete above {threshold}
            </Button>
          )}
          <Button
            variant="outlined"
            color="warning"
            startIcon={<BlockIcon />}
            disabled={dismissLoading || !activeCircleId}
            onClick={() => setDismissDialogOpen(true)}
          >
            Reject below {threshold}
          </Button>
        </Box>
      )}

      {/* Bulk resolve toolbar (only when a selection exists) */}
      <GroupBulkResolveToolbar
        selectedIds={selected}
        onClear={() => setSelected(new Set())}
        onSelectAll={handleSelectAll}
        onResolve={handleResolve}
        canTrash={canTrash}
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}

      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      )}

      {!isLoading && items.length === 0 && !error && (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <BurstModeIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
          <Typography variant="h6" color="text.secondary" gutterBottom>
            No burst groups to review
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Burst groups are created when multiple similar photos are taken within a short time.
          </Typography>
        </Box>
      )}

      {!isLoading && items.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {total} burst group{total !== 1 ? 's' : ''} pending review
          </Typography>
          {items.map((group) => (
            <BurstGroupCard
              key={group.id}
              group={group}
              selected={selected.has(group.id)}
              onToggle={handleToggle}
            />
          ))}
          {pageCount > 1 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
              <Pagination count={pageCount} page={page} onChange={(_, p) => setPage(p)} color="primary" />
            </Box>
          )}
        </Box>
      )}

      {/* Resolve-above-threshold confirm dialog */}
      <Dialog
        open={Boolean(thresholdAction)}
        onClose={() => setThresholdAction(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>
          {thresholdAction === 'trash'
            ? `Delete non-best photos above ${threshold}?`
            : `Archive non-best photos above ${threshold}?`}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            Every pending burst group with a cohesion score at or above <strong>{threshold}</strong>{' '}
            will keep only its suggested best photo; every other photo is{' '}
            {thresholdAction === 'trash' ? (
              <>
                moved to <strong>Trash</strong>. Trashed items can be restored within the retention
                window.
              </>
            ) : (
              <>
                <strong>archived</strong>. Archived items can be unarchived later.
              </>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setThresholdAction(null)}>Cancel</Button>
          <Button
            variant="contained"
            color={thresholdAction === 'trash' ? 'error' : 'primary'}
            onClick={() => void handleThresholdConfirm()}
          >
            {thresholdAction === 'trash' ? 'Move to Trash' : 'Archive'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Dismiss-below-threshold confirm dialog */}
      <Dialog
        open={dismissDialogOpen}
        onClose={() => setDismissDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Dismiss burst groups below {threshold}%?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Every pending burst group with a cohesion score below <strong>{threshold}</strong> will
            be marked <strong>&ldquo;not a burst&rdquo;</strong> and ungrouped. Nothing is archived
            or deleted.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDismissDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" color="warning" onClick={() => void handleDismissConfirm()}>
            Reject all
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(successMsg)}
        autoHideDuration={3000}
        onClose={() => setSuccessMsg(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSuccessMsg(null)} severity="success" sx={{ width: '100%' }}>
          {successMsg}
        </Alert>
      </Snackbar>
    </Box>
  );
}
