import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Checkbox,
  Chip,
  Snackbar,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  LinearProgress,
  Tooltip,
} from '@mui/material';
import { ArrowBack as BackIcon, FilterNone as SimilarIcon } from '@mui/icons-material';
import { useSimilarGroupDetail } from '../../hooks/useSimilar';
import { usePermissions } from '../../hooks/usePermissions';
import { useCircle } from '../../hooks/useCircle';
import type { SimilarGroupMember } from '../../services/similar';

interface MemberCardProps {
  member: SimilarGroupMember;
  selected: boolean;
  onToggle: (id: string) => void;
}

function MemberCard({ member, selected, onToggle }: MemberCardProps) {
  const capturedTime = member.capturedAt
    ? new Date(member.capturedAt).toLocaleTimeString(undefined, { timeStyle: 'medium' })
    : null;

  const resolution =
    member.width != null && member.height != null
      ? `${member.width}×${member.height}`
      : null;

  const similarityPct =
    member.similarityScore != null ? Math.round(member.similarityScore * 100) : null;

  return (
    <Box
      onClick={() => onToggle(member.id)}
      sx={{
        position: 'relative',
        cursor: 'pointer',
        borderRadius: 2,
        border: '2px solid',
        borderColor: member.isSuggestedBest
          ? 'primary.main'
          : selected
          ? 'secondary.main'
          : 'divider',
        overflow: 'hidden',
        userSelect: 'none',
        transition: 'border-color 0.15s',
        bgcolor: 'background.paper',
        minWidth: 200,
        flexShrink: 0,
      }}
    >
      {/* Thumbnail */}
      <Box sx={{ position: 'relative', width: '100%', paddingBottom: '75%', bgcolor: 'action.hover' }}>
        {member.thumbnailUrl ? (
          <Box
            component="img"
            src={member.thumbnailUrl}
            alt=""
            sx={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        ) : (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <SimilarIcon sx={{ fontSize: 40, color: 'text.disabled' }} />
          </Box>
        )}

        {/* Checkbox overlay */}
        <Box
          sx={{
            position: 'absolute',
            top: 4,
            left: 4,
            bgcolor: 'rgba(0,0,0,0.4)',
            borderRadius: '50%',
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(member.id);
          }}
        >
          <Checkbox
            checked={selected}
            size="small"
            sx={{ color: 'white', p: 0.5, '&.Mui-checked': { color: 'white' } }}
            tabIndex={-1}
          />
        </Box>

        {/* Best pick chip */}
        {member.isSuggestedBest && (
          <Box sx={{ position: 'absolute', top: 4, right: 4 }}>
            <Chip label="Best pick" size="small" color="primary" />
          </Box>
        )}
      </Box>

      {/* Info section */}
      <Box sx={{ p: 1 }}>
        {similarityPct != null && (
          <Box sx={{ mb: 0.5 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.25 }}>
              <Typography variant="caption" color="text.secondary">
                Similarity
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {similarityPct}%
              </Typography>
            </Box>
            <Tooltip title={`Similarity score: ${similarityPct}%`}>
              <LinearProgress
                variant="determinate"
                value={similarityPct}
                sx={{ height: 4, borderRadius: 2 }}
                color={similarityPct >= 70 ? 'error' : similarityPct >= 40 ? 'warning' : 'success'}
              />
            </Tooltip>
          </Box>
        )}
        {capturedTime && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {capturedTime}
          </Typography>
        )}
        {resolution && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {resolution}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

export default function SimilarGroupPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { activeCircleRole } = useCircle();
  const { isAdmin } = usePermissions();

  const groupId = id ?? '';
  const { group, isLoading, error, fetchGroup, resolve, dismiss, resolving, dismissing } =
    useSimilarGroupDetail(groupId);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dismissConfirmOpen, setDismissConfirmOpen] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canAct =
    isAdmin || activeCircleRole === 'collaborator' || activeCircleRole === 'circle_admin';

  useEffect(() => {
    if (!groupId) return;
    void fetchGroup(groupId);
  }, [groupId, fetchGroup]);

  // Pre-select suggested best on load
  useEffect(() => {
    if (!group) return;
    const initialSelected = new Set<string>();
    if (group.suggestedBestItemId) {
      initialSelected.add(group.suggestedBestItemId);
    }
    setSelectedIds(initialSelected);
  }, [group]);

  const handleToggle = (memberId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) {
        next.delete(memberId);
      } else {
        next.add(memberId);
      }
      return next;
    });
  };

  const handleResolveConfirm = async () => {
    setConfirmOpen(false);
    setActionError(null);
    try {
      const keepIds = Array.from(selectedIds);
      const result = await resolve(keepIds);
      setSuccessMsg(`Kept ${result.kept} photo${result.kept !== 1 ? 's' : ''}, deleted ${result.deleted}.`);
      setTimeout(() => navigate('/similar'), 1500);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to resolve similar photo group');
    }
  };

  const handleDismissConfirm = async () => {
    setDismissConfirmOpen(false);
    setActionError(null);
    try {
      await dismiss();
      setSuccessMsg('Group dismissed — all photos kept.');
      setTimeout(() => navigate('/similar'), 1500);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to dismiss similar photo group');
    }
  };

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  if (!group) return null;

  const keepCount = selectedIds.size;
  const deleteCount = group.members.length - keepCount;

  const createdDate = group.createdAt
    ? new Date(group.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : null;

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
        <IconButton onClick={() => navigate('/similar')} aria-label="Back to similar photos list">
          <BackIcon />
        </IconButton>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" component="h1">
            Similar Photos Group
          </Typography>
          {createdDate && (
            <Typography variant="body2" color="text.secondary">
              Detected {createdDate} &middot; {group.members.length} photos
            </Typography>
          )}
        </Box>
      </Box>

      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {actionError}
        </Alert>
      )}

      {/* Instructions */}
      <Alert severity="info" sx={{ mb: 3 }}>
        Select the photos you want to <strong>keep</strong>. Unselected photos will be deleted
        when you confirm. The suggested best photo is pre-selected.
      </Alert>

      {/* Photo grid */}
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 2,
          mb: 3,
        }}
      >
        {group.members.map((member: SimilarGroupMember) => (
          <MemberCard
            key={member.id}
            member={member}
            selected={selectedIds.has(member.id)}
            onToggle={handleToggle}
          />
        ))}
      </Box>

      {/* Action bar */}
      {canAct && (
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button
            variant="contained"
            color="primary"
            disabled={keepCount === 0 || resolving || dismissing}
            onClick={() => setConfirmOpen(true)}
            startIcon={resolving ? <CircularProgress size={16} /> : undefined}
          >
            {resolving
              ? 'Saving…'
              : keepCount === 0
              ? 'Select photos to keep'
              : `Keep ${keepCount}, delete ${deleteCount} other${deleteCount !== 1 ? 's' : ''}`}
          </Button>

          <Button
            variant="outlined"
            color="inherit"
            disabled={resolving || dismissing}
            onClick={() => setDismissConfirmOpen(true)}
            startIcon={dismissing ? <CircularProgress size={16} /> : undefined}
          >
            {dismissing ? 'Dismissing…' : 'Not similar — dismiss'}
          </Button>
        </Box>
      )}

      {/* Resolve confirm dialog */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Confirm deletion</DialogTitle>
        <DialogContent>
          <DialogContentText>
            You are about to keep <strong>{keepCount}</strong> photo{keepCount !== 1 ? 's' : ''} and
            permanently delete <strong>{deleteCount}</strong> other
            {deleteCount !== 1 ? 's' : ''}. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => void handleResolveConfirm()}
          >
            Delete {deleteCount} photo{deleteCount !== 1 ? 's' : ''}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Dismiss confirm dialog */}
      <Dialog open={dismissConfirmOpen} onClose={() => setDismissConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Dismiss similar photo group</DialogTitle>
        <DialogContent>
          <DialogContentText>
            All {group.members.length} photos will be kept and this group will be dismissed. No
            photos will be deleted.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDismissConfirmOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => void handleDismissConfirm()}
          >
            Dismiss
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
