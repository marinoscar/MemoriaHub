import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
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
import BackIcon from '@mui/icons-material/ArrowBack';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import StarIcon from '@mui/icons-material/Star';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import ArchiveIcon from '@mui/icons-material/Archive';
import DeleteIcon from '@mui/icons-material/Delete';
import { useDuplicateGroupDetail } from '../../hooks/useDuplicates';
import { usePermissions } from '../../hooks/usePermissions';
import { useCircle } from '../../hooks/useCircle';
import { SelectionCheckboxOverlay } from '../../components/review/SelectionCheckboxOverlay';
import {
  MemberComparison,
  deriveComparisonRows,
} from '../../components/review/MemberComparison';
import type { ComparisonRowDef } from '../../components/review/MemberComparison';
import { formatBytes } from '../../utils/formatBytes';
import type { DuplicateGroupKind, DuplicateGroupMember, DuplicateResolveAction } from '../../services/duplicates';

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

interface FilmstripItemProps {
  member: DuplicateGroupMember;
  selected: boolean;
  isLeft: boolean;
  isRight: boolean;
  onToggleKeep: (id: string) => void;
  onAssignPane: (id: string) => void;
}

function FilmstripItem({ member, selected, isLeft, isRight, onToggleKeep, onAssignPane }: FilmstripItemProps) {
  const qualityPct = member.qualityScore != null ? Math.round(member.qualityScore * 100) : null;

  return (
    <Box
      onClick={() => onAssignPane(member.id)}
      sx={{
        position: 'relative',
        cursor: 'pointer',
        borderRadius: 2,
        border: '2px solid',
        borderColor: isLeft || isRight ? 'primary.main' : member.isSuggestedBest ? 'warning.main' : 'divider',
        overflow: 'hidden',
        userSelect: 'none',
        transition: 'border-color 0.15s',
        bgcolor: 'background.paper',
        // Below `md` the strip is a wrapping grid, so the tile must be free to
        // shrink to its cell; the fixed width only applies to the md+ scroller.
        minWidth: { xs: 0, md: 160 },
        flexShrink: { xs: 1, md: 0 },
      }}
    >
      <Box sx={{ position: 'relative', width: '100%', paddingBottom: '75%', bgcolor: 'action.hover' }}>
        {member.thumbnailUrl ? (
          <Box
            component="img"
            src={member.thumbnailUrl}
            alt=""
            sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ContentCopyIcon sx={{ fontSize: 32, color: 'text.disabled' }} />
          </Box>
        )}

        {/* Keep checkbox overlay */}
        <SelectionCheckboxOverlay
          checked={selected}
          onToggle={() => onToggleKeep(member.id)}
          ariaLabel="Keep photo"
        />

        {member.isSuggestedBest && (
          <Box sx={{ position: 'absolute', top: 4, right: 4 }}>
            <Tooltip title="Suggested best copy">
              <StarIcon sx={{ color: 'warning.main', fontSize: 22, filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.6))' }} />
            </Tooltip>
          </Box>
        )}

        {(isLeft || isRight) && (
          <Chip
            label={isLeft && isRight ? 'L / R' : isLeft ? 'L' : 'R'}
            size="small"
            color="primary"
            sx={{ position: 'absolute', bottom: 4, left: 4, height: 18, fontSize: '0.65rem' }}
          />
        )}
      </Box>

      <Box sx={{ p: 1 }}>
        {qualityPct != null && (
          <Box sx={{ mb: 0.5 }}>
            <Tooltip title={`Quality score: ${qualityPct}%`}>
              <LinearProgress
                variant="determinate"
                value={qualityPct}
                sx={{ height: 4, borderRadius: 2 }}
                color={qualityPct >= 70 ? 'success' : qualityPct >= 40 ? 'warning' : 'error'}
              />
            </Tooltip>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function ComparePane({
  member,
  label,
}: {
  member: DuplicateGroupMember | null;
  label: string;
}) {
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        {label}
      </Typography>
      <Box
        sx={{
          width: '100%',
          height: { xs: 260, sm: 360, md: 440 },
          bgcolor: 'action.hover',
          borderRadius: 1,
          border: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {member?.previewUrl ? (
          <Box
            component="img"
            src={member.previewUrl}
            alt=""
            sx={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        ) : (
          <Typography variant="body2" color="text.disabled">
            Select a photo from the filmstrip
          </Typography>
        )}
      </Box>
    </Box>
  );
}

function humanDims(m: DuplicateGroupMember): string | null {
  if (m.width == null || m.height == null) return null;
  return `${m.width}×${m.height}`;
}

/**
 * Attribute catalog for the member comparison. Derived ONCE (below) and fed to
 * both the md+ matrix and the stacked mobile cards — see MemberComparison.
 */
const COMPARISON_ROW_DEFS: ComparisonRowDef<DuplicateGroupMember>[] = [
  { key: 'dimensions', label: 'Dimensions', value: (m) => humanDims(m) ?? '—' },
  {
    key: 'fileSize',
    label: 'File size',
    value: (m) => (m.fileSize != null ? formatBytes(String(m.fileSize)) : '—'),
  },
  {
    key: 'capturedAt',
    label: 'Captured at',
    value: (m) =>
      m.capturedAt
        ? new Date(m.capturedAt).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })
        : '—',
  },
  {
    key: 'camera',
    label: 'Camera',
    value: (m) => [m.cameraMake, m.cameraModel].filter(Boolean).join(' ') || '—',
  },
  {
    key: 'gps',
    label: 'GPS',
    value: (m) => (m.hasGps ? 'Yes' : 'No'),
    render: (m) =>
      m.hasGps ? (
        <CheckCircleIcon fontSize="small" color="success" />
      ) : (
        <CancelIcon fontSize="small" color="disabled" />
      ),
  },
  { key: 'hash', label: 'Hash prefix', value: (m) => m.contentHash ?? '—' },
  {
    key: 'sharpness',
    label: 'Sharpness',
    value: (m) => (m.sharpnessScore != null ? m.sharpnessScore.toFixed(1) : '—'),
  },
  {
    key: 'similarity',
    label: 'Similarity to best',
    value: (m) =>
      m.similarityToBest != null ? `${Math.round(m.similarityToBest * 100)}%` : '—',
  },
  {
    key: 'quality',
    label: 'Quality score',
    // Per-member score — never a "difference" to flag.
    compare: false,
    value: (m) => (m.qualityScore != null ? `${Math.round(m.qualityScore * 100)}%` : '—'),
    render: (m) => {
      const pct = m.qualityScore != null ? Math.round(m.qualityScore * 100) : null;
      if (pct == null) return '—';
      return (
        <Box sx={{ minWidth: 80, width: '100%' }}>
          <LinearProgress
            variant="determinate"
            value={pct}
            sx={{ height: 6, borderRadius: 3, mb: 0.5 }}
            color={pct >= 70 ? 'success' : pct >= 40 ? 'warning' : 'error'}
          />
          <Typography variant="caption">{pct}%</Typography>
        </Box>
      );
    },
  },
];

export default function DuplicateGroupPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { activeCircleRole } = useCircle();
  const { isAdmin, hasPermission } = usePermissions();

  const groupId = id ?? '';
  const { group, isLoading, error, fetchGroup, resolve, dismiss, resolving, dismissing } =
    useDuplicateGroupDetail(groupId);

  const [keepIds, setKeepIds] = useState<Set<string>>(new Set());
  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string | null>(null);
  const [nextPane, setNextPane] = useState<'left' | 'right'>('right');
  const [action, setAction] = useState<DuplicateResolveAction>('archive');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dismissConfirmOpen, setDismissConfirmOpen] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canAct =
    isAdmin || activeCircleRole === 'collaborator' || activeCircleRole === 'circle_admin';
  const canTrash = hasPermission('media:delete');

  useEffect(() => {
    if (!groupId) return;
    void fetchGroup(groupId);
  }, [groupId, fetchGroup]);

  // Pre-select suggested best as the keep set, and seed compare panes.
  useEffect(() => {
    if (!group) return;
    const initialKeep = new Set<string>();
    if (group.suggestedBestItemId) {
      initialKeep.add(group.suggestedBestItemId);
    }
    setKeepIds(initialKeep);

    const best = group.suggestedBestItemId ?? group.members[0]?.id ?? null;
    const other = group.members.find((m) => m.id !== best)?.id ?? null;
    setLeftId(best);
    setRightId(other);
  }, [group]);

  const membersById = useMemo(() => {
    const map = new Map<string, DuplicateGroupMember>();
    group?.members.forEach((m) => map.set(m.id, m));
    return map;
  }, [group]);

  const handleToggleKeep = (memberId: string) => {
    setKeepIds((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) {
        next.delete(memberId);
      } else {
        next.add(memberId);
      }
      return next;
    });
  };

  const handleAssignPane = (memberId: string) => {
    if (nextPane === 'left') {
      setLeftId(memberId);
      setNextPane('right');
    } else {
      setRightId(memberId);
      setNextPane('left');
    }
  };

  const handleResolveConfirm = async () => {
    setConfirmOpen(false);
    setActionError(null);
    try {
      const ids = Array.from(keepIds);
      const result = await resolve(ids, action);
      const verb = action === 'trash' ? 'moved to Trash' : 'archived';
      setSuccessMsg(`Kept ${result.kept} photo${result.kept !== 1 ? 's' : ''}; ${result.removed} ${verb}.`);
      setTimeout(() => navigate('/duplicates'), 1500);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to resolve duplicate group');
    }
  };

  const handleDismissConfirm = async () => {
    setDismissConfirmOpen(false);
    setActionError(null);
    try {
      await dismiss();
      setSuccessMsg('Duplicate group dismissed — all photos kept.');
      setTimeout(() => navigate('/duplicates'), 1500);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to dismiss duplicate group');
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

  const keepCount = keepIds.size;
  const removeCount = group.members.length - keepCount;

  const capturedDate = group.capturedAt
    ? new Date(group.capturedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : null;

  const leftMember = leftId ? membersById.get(leftId) ?? null : null;
  const rightMember = rightId ? membersById.get(rightId) ?? null : null;

  // Build the comparison model once; both orientations render from it.
  const comparisonColumns = group.members.map((m, index) => ({
    id: m.id,
    label: `Photo ${index + 1}`,
    isSuggestedBest: m.isSuggestedBest,
  }));
  const comparisonRows = deriveComparisonRows(group.members, COMPARISON_ROW_DEFS);

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
        <IconButton onClick={() => navigate('/duplicates')} aria-label="Back to duplicates list">
          <BackIcon />
        </IconButton>
        <Box sx={{ flex: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="h5" component="h1">
              Duplicate Group
            </Typography>
            <Chip label={KIND_LABELS[group.kind]} size="small" color={KIND_COLORS[group.kind]} />
            {group.confidence != null && (
              <Chip
                label={`${Math.round(group.confidence * 100)}% match`}
                size="small"
                variant="outlined"
                color={
                  group.confidence >= 0.7 ? 'success' : group.confidence >= 0.4 ? 'warning' : 'error'
                }
              />
            )}
          </Box>
          {capturedDate && (
            <Typography variant="body2" color="text.secondary">
              {capturedDate} &middot; {group.members.length} photos
            </Typography>
          )}
        </Box>
      </Box>

      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {actionError}
        </Alert>
      )}

      <Alert severity="info" sx={{ mb: 3 }}>
        Select the photos you want to <strong>keep</strong>. Click any filmstrip thumbnail to load it
        into the compare panes below. The suggested best photo is pre-selected.
      </Alert>

      {/* Side-by-side compare */}
      <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', md: 'row' }, mb: 3 }}>
        <ComparePane member={leftMember} label="Left" />
        <ComparePane member={rightMember} label="Right" />
      </Box>

      {/* Filmstrip */}
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        All members — click to compare, checkbox to keep
      </Typography>
      <Box
        sx={{
          // Below `md` the whole group must be visible at once, so the strip
          // wraps into a 2-up / 3-up grid instead of scrolling sideways.
          display: { xs: 'grid', md: 'flex' },
          gridTemplateColumns: {
            xs: 'repeat(2, minmax(0, 1fr))',
            sm: 'repeat(3, minmax(0, 1fr))',
          },
          gap: 2,
          overflowX: { xs: 'visible', md: 'auto' },
          pb: 1,
          mb: 3,
        }}
      >
        {group.members.map((member) => (
          <FilmstripItem
            key={member.id}
            member={member}
            selected={keepIds.has(member.id)}
            isLeft={member.id === leftId}
            isRight={member.id === rightId}
            onToggleKeep={handleToggleKeep}
            onAssignPane={handleAssignPane}
          />
        ))}
      </Box>

      {/* Member comparison — attribute matrix at md+, stacked cards below */}
      <MemberComparison columns={comparisonColumns} rows={comparisonRows} />

      {/* Action bar */}
      {canAct && (
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button
            variant="contained"
            color="primary"
            disabled={keepCount === 0 || resolving || dismissing}
            onClick={() => {
              setAction('archive');
              setConfirmOpen(true);
            }}
            startIcon={resolving ? <CircularProgress size={16} /> : <ArchiveIcon />}
          >
            {keepCount === 0
              ? 'Select photos to keep'
              : `Keep ${keepCount}, archive ${removeCount} other${removeCount !== 1 ? 's' : ''}`}
          </Button>

          {canTrash && (
            <Button
              variant="contained"
              color="error"
              disabled={keepCount === 0 || resolving || dismissing}
              onClick={() => {
                setAction('trash');
                setConfirmOpen(true);
              }}
              startIcon={resolving ? <CircularProgress size={16} /> : <DeleteIcon />}
            >
              {keepCount === 0
                ? 'Select photos to keep'
                : `Keep ${keepCount}, delete ${removeCount} other${removeCount !== 1 ? 's' : ''}`}
            </Button>
          )}

          <Button
            variant="outlined"
            color="inherit"
            disabled={resolving || dismissing}
            onClick={() => setDismissConfirmOpen(true)}
            startIcon={dismissing ? <CircularProgress size={16} /> : undefined}
          >
            {dismissing ? 'Dismissing…' : 'Not duplicates — dismiss'}
          </Button>
        </Box>
      )}

      {/* Resolve confirm dialog */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Confirm {action === 'trash' ? 'trash' : 'archive'}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            You are about to keep <strong>{keepCount}</strong> photo{keepCount !== 1 ? 's' : ''} and{' '}
            {action === 'trash' ? (
              <>
                move <strong>{removeCount}</strong> other{removeCount !== 1 ? 's' : ''} to{' '}
                <strong>Trash</strong>. Trashed items can be restored within the retention window.
              </>
            ) : (
              <>
                <strong>archive</strong> <strong>{removeCount}</strong> other
                {removeCount !== 1 ? 's' : ''}. Archived items can be unarchived later.
              </>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            color={action === 'trash' ? 'error' : 'primary'}
            onClick={() => void handleResolveConfirm()}
          >
            {action === 'trash' ? 'Move to Trash' : 'Archive'} {removeCount} photo{removeCount !== 1 ? 's' : ''}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Dismiss confirm dialog */}
      <Dialog open={dismissConfirmOpen} onClose={() => setDismissConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Dismiss duplicate group</DialogTitle>
        <DialogContent>
          <DialogContentText>
            All {group.members.length} photos will be kept and this group will be dismissed as not
            actually duplicates. No photos will be archived or deleted.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDismissConfirmOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void handleDismissConfirm()}>
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
