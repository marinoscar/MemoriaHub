import { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Badge,
  Snackbar,
} from '@mui/material';
import { BurstMode as BurstModeIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { usePermissions } from '../../hooks/usePermissions';
import { useBurstGroups } from '../../hooks/useBursts';
import { runBurstBackfill } from '../../services/bursts';
import type { BurstGroupSummary } from '../../services/bursts';

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

function BurstGroupCard({ group }: { group: BurstGroupSummary }) {
  const navigate = useNavigate();

  const capturedDate = group.capturedAt
    ? new Date(group.capturedAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;

  return (
    <Card variant="outlined">
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
            <Typography variant="body2" color="text.secondary">
              {capturedDate}
            </Typography>
          )}
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export default function BurstsPage() {
  const { activeCircle, activeCircleId, activeCircleRole } = useCircle();
  const { isAdmin } = usePermissions();
  const { items, isLoading, error, fetchGroups } = useBurstGroups();
  const [backfilling, setBackfilling] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);

  const canBackfill =
    isAdmin || activeCircleRole === 'collaborator' || activeCircleRole === 'circle_admin';

  useEffect(() => {
    if (!activeCircleId) return;
    void fetchGroups({ circleId: activeCircleId, status: 'pending' });
  }, [activeCircleId, fetchGroups]);

  const handleBackfill = async () => {
    if (!activeCircleId) return;
    setBackfilling(true);
    setBackfillError(null);
    try {
      const result = await runBurstBackfill(activeCircleId);
      setSuccessMsg(`Burst scan enqueued: ${result.enqueued} item${result.enqueued !== 1 ? 's' : ''} queued.`);
      // Refresh the list after a brief moment
      setTimeout(() => {
        void fetchGroups({ circleId: activeCircleId, status: 'pending' });
      }, 1500);
    } catch (err) {
      setBackfillError(err instanceof Error ? err.message : 'Failed to start burst scan');
    } finally {
      setBackfilling(false);
    }
  };

  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to review burst groups.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 3,
          flexWrap: 'wrap',
          gap: 1,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <BurstModeIcon color="primary" />
          <Typography variant="h5" component="h1">
            Review Bursts
          </Typography>
        </Box>
        {canBackfill && (
          <Button
            variant="outlined"
            onClick={() => void handleBackfill()}
            disabled={backfilling}
            startIcon={backfilling ? <CircularProgress size={16} /> : <BurstModeIcon />}
          >
            {backfilling ? 'Scanning…' : 'Scan for bursts'}
          </Button>
        )}
      </Box>

      {backfillError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {backfillError}
        </Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
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
          {canBackfill && (
            <Button
              variant="contained"
              onClick={() => void handleBackfill()}
              disabled={backfilling}
              sx={{ mt: 3 }}
              startIcon={backfilling ? <CircularProgress size={16} /> : <BurstModeIcon />}
            >
              {backfilling ? 'Scanning…' : 'Scan for bursts'}
            </Button>
          )}
        </Box>
      )}

      {!isLoading && items.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {items.length} burst group{items.length !== 1 ? 's' : ''} pending review
          </Typography>
          {items.map((group) => (
            <BurstGroupCard key={group.id} group={group} />
          ))}
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
