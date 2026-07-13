import { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
  Alert,
  Card,
  CardActionArea,
  CardContent,
  Checkbox,
  Chip,
  Badge,
  Snackbar,
  Pagination,
} from '@mui/material';
import { BurstMode as BurstModeIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { usePermissions } from '../../hooks/usePermissions';
import { useBurstGroups } from '../../hooks/useBursts';
import { GroupBulkResolveToolbar } from '../../components/review/GroupBulkResolveToolbar';
import { ConfidenceMeter } from '../../components/review/ConfidenceMeter';
import type { BurstGroupSummary, GroupResolveAction } from '../../services/bursts';

function CoverStack({ coverUrls, mediaCount }: { coverUrls: string[]; mediaCount: number }) {
  return (
    <Box sx={{ position: 'relative', width: 120, height: 90, flexShrink: 0 }}>
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
      <Box
        sx={{
          position: 'absolute',
          top: 8,
          left: 8,
          zIndex: 2,
          bgcolor: 'rgba(0,0,0,0.45)',
          borderRadius: '50%',
        }}
      >
        <Checkbox
          checked={selected}
          onChange={() => onToggle(group.id)}
          onClick={(e) => e.stopPropagation()}
          size="small"
          sx={{ color: 'common.white', p: 0.5, '&.Mui-checked': { color: 'common.white' } }}
          inputProps={{ 'aria-label': 'Select burst group' }}
        />
      </Box>
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
  const { hasPermission } = usePermissions();
  const { items, meta, isLoading, error, fetchGroups, bulkResolve } = useBurstGroups();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canTrash = hasPermission('media:delete');

  useEffect(() => {
    if (!activeCircleId) return;
    void fetchGroups({ circleId: activeCircleId, status: 'pending', page });
  }, [activeCircleId, page, fetchGroups]);

  useEffect(() => {
    setPage(1);
  }, [activeCircleId]);

  // Clear selection whenever the visible set changes (page or circle).
  useEffect(() => {
    setSelected(new Set());
  }, [page, activeCircleId]);

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
      </Box>

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
