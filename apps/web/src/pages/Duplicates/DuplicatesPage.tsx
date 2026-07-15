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
  Stack,
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
  ContentCopy as ContentCopyIcon,
  Settings as SettingsIcon,
  Archive as ArchiveIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import { useNavigate, Link as RouterLink } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { useDuplicateGroups } from '../../hooks/useDuplicates';
import { GroupBulkResolveToolbar } from '../../components/review/GroupBulkResolveToolbar';
import { SelectionCheckboxOverlay } from '../../components/review/SelectionCheckboxOverlay';
import { ConfidenceMeter } from '../../components/review/ConfidenceMeter';
import type { DuplicateGroupKind, DuplicateGroupSummary, DuplicateResolveAction } from '../../services/duplicates';

const KIND_LABELS: Record<DuplicateGroupKind, string> = {
  exact_variant: 'Exact copy',
  edited: 'Edited variant',
  similar: 'Similar',
};

const KIND_COLORS: Record<DuplicateGroupKind, 'default' | 'success' | 'warning' | 'info'> = {
  exact_variant: 'success',
  edited: 'warning',
  similar: 'info',
};

const KIND_FILTERS: Array<{ label: string; value: DuplicateGroupKind | null }> = [
  { label: 'All', value: null },
  { label: 'Exact copy', value: 'exact_variant' },
  { label: 'Edited variant', value: 'edited' },
  { label: 'Similar', value: 'similar' },
];

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

interface DuplicateGroupCardProps {
  group: DuplicateGroupSummary;
  selected: boolean;
  onToggle: (id: string) => void;
}

function DuplicateGroupCard({ group, selected, onToggle }: DuplicateGroupCardProps) {
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
        ariaLabel="Select duplicate group"
      />
      <CardActionArea
        onClick={() => navigate(`/duplicates/${group.id}`)}
        sx={{ display: 'flex', alignItems: 'center', gap: 2, p: 2, justifyContent: 'flex-start' }}
      >
        <CoverStack coverUrls={group.coverThumbnailUrls} mediaCount={group.mediaCount} />
        <CardContent sx={{ flex: 1, p: 0, '&:last-child': { pb: 0 } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
            <Typography variant="subtitle2" component="span">
              {group.mediaCount} photos
            </Typography>
            <Chip
              label={KIND_LABELS[group.kind]}
              size="small"
              color={KIND_COLORS[group.kind]}
              variant="outlined"
            />
          </Box>
          {capturedDate && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {capturedDate}
            </Typography>
          )}
          <ConfidenceMeter confidence={group.confidence} label="Match" />
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export default function DuplicatesPage() {
  const { activeCircle, activeCircleId } = useCircle();
  const { hasPermission, isAdmin } = usePermissions();
  const { settings } = useSystemSettings();
  const { items, meta, isLoading, error, fetchGroups, bulkResolve, bulkResolveByThreshold } =
    useDuplicateGroups();
  const [kindFilter, setKindFilter] = useState<DuplicateGroupKind | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [thresholdAction, setThresholdAction] = useState<DuplicateResolveAction | null>(null);
  const [thresholdLoading, setThresholdLoading] = useState(false);

  const canTrash = hasPermission('media:delete');
  const threshold = settings?.dedup?.autoResolveThreshold ?? 60;

  useEffect(() => {
    if (!activeCircleId) return;
    void fetchGroups({
      circleId: activeCircleId,
      status: 'pending',
      kind: kindFilter ?? undefined,
      page,
    });
  }, [activeCircleId, kindFilter, page, fetchGroups]);

  useEffect(() => {
    setPage(1);
  }, [kindFilter, activeCircleId]);

  // Clear selection whenever the visible set changes (filter, page, or circle).
  useEffect(() => {
    setSelected(new Set());
  }, [kindFilter, page, activeCircleId]);

  const handleToggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelected(new Set(items.map((g) => g.id)));
  };

  const handleResolve = async (action: DuplicateResolveAction) => {
    setActionError(null);
    try {
      const result = await bulkResolve(Array.from(selected), action);
      setSelected(new Set());
      const verb = action === 'trash' ? 'moved to Trash' : 'archived';
      setSuccessMsg(
        `Resolved ${result.resolvedGroups} group${result.resolvedGroups !== 1 ? 's' : ''}; ${result.removedCount} photo${result.removedCount !== 1 ? 's' : ''} ${verb}.`,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to resolve duplicate groups');
    }
  };

  const handleThresholdConfirm = async () => {
    const action = thresholdAction;
    setThresholdAction(null);
    if (!action || !activeCircleId) return;
    setActionError(null);
    setThresholdLoading(true);
    try {
      const result = await bulkResolveByThreshold(threshold, action);
      setSelected(new Set());
      const verb = action === 'trash' ? 'moved to Trash' : 'archived';
      const skippedNote = result.skipped > 0 ? ` (${result.skipped} skipped)` : '';
      setSuccessMsg(
        `Resolved ${result.resolvedGroups} group${result.resolvedGroups !== 1 ? 's' : ''}; ${result.removedCount} photo${result.removedCount !== 1 ? 's' : ''} ${verb}${skippedNote}.`,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to resolve duplicate groups');
    } finally {
      setThresholdLoading(false);
    }
  };

  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to review duplicate photos.</Alert>
      </Box>
    );
  }

  const pageCount = meta ? Math.max(1, Math.ceil(meta.total / meta.pageSize)) : 1;

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 3, gap: 1 }}>
        <ContentCopyIcon color="primary" />
        <Typography variant="h5" component="h1">
          Review Duplicates
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        {isAdmin && (
          <Tooltip title="Duplicate detection settings">
            <IconButton
              component={RouterLink}
              to="/admin/settings/duplicates"
              aria-label="Duplicate detection settings"
            >
              <SettingsIcon />
            </IconButton>
          </Tooltip>
        )}
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

      {/* Kind filter chips */}
      <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', rowGap: 1 }}>
        {KIND_FILTERS.map((f) => (
          <Chip
            key={f.label}
            label={f.label}
            size="small"
            color={kindFilter === f.value ? 'primary' : 'default'}
            variant={kindFilter === f.value ? 'filled' : 'outlined'}
            onClick={() => setKindFilter(f.value)}
          />
        ))}
      </Stack>

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
          <ContentCopyIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
          <Typography variant="h6" color="text.secondary" gutterBottom>
            No duplicate groups to review
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Near-duplicate photos — like recompressed re-shares — are grouped here for review.
          </Typography>
        </Box>
      )}

      {!isLoading && items.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {meta?.total ?? items.length} duplicate group{(meta?.total ?? items.length) !== 1 ? 's' : ''} pending review
          </Typography>
          {items.map((group) => (
            <DuplicateGroupCard
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
            Every pending duplicate group with a match score at or above <strong>{threshold}</strong>{' '}
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
