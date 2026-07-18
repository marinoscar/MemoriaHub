import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
  Alert,
  Card,
  CardContent,
  Chip,
  Stack,
  Pagination,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Snackbar,
} from '@mui/material';
import {
  MyLocation as MyLocationIcon,
  Warning as WarningIcon,
  Check as CheckIcon,
  EditLocationAlt as EditLocationAltIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { useCircle } from '../../hooks/useCircle';
import { useLocationSuggestions } from '../../hooks/useLocationSuggestions';
import { LocationMiniMap } from '../../components/media/LocationMiniMap';
import { AdjustLocationDialog } from './AdjustLocationDialog';
import type { LocationSuggestionSummary } from '../../services/locationSuggestions';

const BULK_ACCEPT_THRESHOLD = 0.8;

// Bulk-accept is asynchronous (backend enqueues a job). Poll the pending list
// to reflect progress: every 4s for up to ~2 minutes, stopping early once the
// count reaches zero or stalls across several consecutive polls.
const BULK_POLL_INTERVAL_MS = 4000;
const MAX_BULK_POLL_TICKS = 30;
const BULK_POLL_STALL_TICKS = 3;

function confidenceChipColor(confidence: number): 'success' | 'warning' | 'default' {
  if (confidence >= 0.8) return 'success';
  if (confidence >= 0.5) return 'warning';
  return 'default';
}

function formatMinutes(seconds: number | null): string | null {
  if (seconds === null) return null;
  const minutes = seconds / 60;
  if (minutes < 1) return `${Math.round(seconds)}s`;
  return `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`;
}

function anchorSummary(s: LocationSuggestionSummary): string {
  const hasBefore = s.anchorBeforeId !== null;
  const hasAfter = s.anchorAfterId !== null;

  if (hasBefore && hasAfter) {
    const before = formatMinutes(s.gapBeforeSeconds);
    const after = formatMinutes(s.gapAfterSeconds);
    const gapText = before && after ? `${before} before, ${after} after` : before ?? after ?? '';
    const distanceText = s.anchorDistanceKm != null ? ` · anchors ${s.anchorDistanceKm.toFixed(2)} km apart` : '';
    return `Interpolated between 2 nearby photos (${gapText})${distanceText}`;
  }

  const singleGap = hasBefore ? formatMinutes(s.gapBeforeSeconds) : formatMinutes(s.gapAfterSeconds);
  const direction = hasBefore ? 'before' : 'after';
  return `Estimated from a single nearby photo (${singleGap ?? '—'} ${direction})`;
}

function SpeedWarning({ impliedSpeedKmh }: { impliedSpeedKmh: number | null }) {
  if (impliedSpeedKmh == null || impliedSpeedKmh < 60) return null;
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mt: 0.5 }}>
      <WarningIcon fontSize="small" color="warning" />
      <Typography variant="caption" color="warning.main">
        Anchors imply ~{Math.round(impliedSpeedKmh)} km/h — subject may have been traveling
      </Typography>
    </Stack>
  );
}

interface SuggestionRowProps {
  suggestion: LocationSuggestionSummary;
  acting: boolean;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAdjust: (suggestion: LocationSuggestionSummary) => void;
}

function SuggestionRow({ suggestion, acting, onAccept, onReject, onAdjust }: SuggestionRowProps) {
  const capturedDate = suggestion.capturedAt
    ? new Date(suggestion.capturedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : null;

  return (
    <Card variant="outlined">
      <CardContent>
        <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', md: 'row' } }}>
          {/* Thumbnail */}
          <Box
            sx={{
              width: { xs: '100%', md: 140 },
              height: { xs: 200, md: 140 },
              flexShrink: 0,
              borderRadius: 1,
              overflow: 'hidden',
              bgcolor: 'action.hover',
            }}
          >
            {suggestion.thumbnailUrl ? (
              <Box
                component="img"
                src={suggestion.thumbnailUrl}
                alt=""
                sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                <MyLocationIcon sx={{ fontSize: 32, color: 'text.disabled' }} />
              </Box>
            )}
          </Box>

          {/* Details */}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
              {capturedDate && <Typography variant="subtitle2">{capturedDate}</Typography>}
              <Chip
                label={`${Math.round(suggestion.confidence * 100)}% confidence`}
                size="small"
                color={confidenceChipColor(suggestion.confidence)}
              />
              <Chip
                label={suggestion.method === 'interpolated' ? 'Interpolated' : 'Nearest anchor'}
                size="small"
                variant="outlined"
              />
            </Box>

            {[suggestion.cameraMake, suggestion.cameraModel].filter(Boolean).length > 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                {[suggestion.cameraMake, suggestion.cameraModel].filter(Boolean).join(' ')}
              </Typography>
            )}

            <Typography variant="body2" color="text.secondary">
              {anchorSummary(suggestion)}
            </Typography>
            <SpeedWarning impliedSpeedKmh={suggestion.impliedSpeedKmh} />

            <Box sx={{ mt: 1.5, maxWidth: 320 }}>
              <LocationMiniMap lat={suggestion.lat} lng={suggestion.lng} />
            </Box>
          </Box>

          {/* Actions */}
          <Stack
            direction={{ xs: 'row', md: 'column' }}
            spacing={1}
            sx={{ flexShrink: 0, justifyContent: { xs: 'flex-start', md: 'center' } }}
          >
            <Button
              variant="contained"
              size="small"
              color="success"
              startIcon={acting ? <CircularProgress size={14} color="inherit" /> : <CheckIcon />}
              disabled={acting}
              onClick={() => onAccept(suggestion.id)}
            >
              Confirm
            </Button>
            <Button
              variant="outlined"
              size="small"
              startIcon={<EditLocationAltIcon />}
              disabled={acting}
              onClick={() => onAdjust(suggestion)}
            >
              Adjust
            </Button>
            <Button
              variant="outlined"
              size="small"
              color="error"
              startIcon={<CloseIcon />}
              disabled={acting}
              onClick={() => onReject(suggestion.id)}
            >
              Reject
            </Button>
          </Stack>
        </Box>
      </CardContent>
    </Card>
  );
}

export default function LocationSuggestionsPage() {
  const { activeCircle, activeCircleId } = useCircle();
  const { items, meta, isLoading, error, fetchSuggestions, accept, reject, bulkAccept, actingIds, bulkAccepting } =
    useLocationSuggestions();
  const [page, setPage] = useState(1);
  const [adjustTarget, setAdjustTarget] = useState<LocationSuggestionSummary | null>(null);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [bulkInfo, setBulkInfo] = useState<string | null>(null);
  const [bulkPolling, setBulkPolling] = useState(false);

  // Mirror the latest pending count into a ref so the poll can compare across
  // ticks without re-creating the interval on every render.
  const pendingTotalRef = useRef<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(() => {
    if (!activeCircleId) return;
    void fetchSuggestions({ circleId: activeCircleId, status: 'pending', page });
  }, [activeCircleId, page, fetchSuggestions]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    setPage(1);
  }, [activeCircleId]);

  useEffect(() => {
    pendingTotalRef.current = meta?.total ?? items.length;
  }, [meta, items.length]);

  const stopBulkPoll = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setBulkPolling(false);
  }, []);

  // Clean up the poll on unmount.
  useEffect(() => stopBulkPoll, [stopBulkPoll]);

  // Stop polling if the circle changes out from under an in-flight job.
  useEffect(() => stopBulkPoll, [activeCircleId, stopBulkPoll]);

  const startBulkPoll = useCallback(() => {
    stopBulkPoll();
    setBulkPolling(true);
    let ticks = 0;
    let stallTicks = 0;
    let lastTotal = pendingTotalRef.current;
    refresh();
    pollRef.current = setInterval(() => {
      ticks += 1;
      const current = pendingTotalRef.current ?? 0;
      if (current === 0) {
        stopBulkPoll();
        setBulkInfo(null);
        setSuccessMsg('Accepted all high-confidence suggestions');
        return;
      }
      if (current === lastTotal) {
        stallTicks += 1;
      } else {
        stallTicks = 0;
        lastTotal = current;
      }
      if (stallTicks >= BULK_POLL_STALL_TICKS || ticks >= MAX_BULK_POLL_TICKS) {
        stopBulkPoll();
        setBulkInfo(null);
        return;
      }
      refresh();
    }, BULK_POLL_INTERVAL_MS);
  }, [refresh, stopBulkPoll]);

  const handleAccept = async (id: string) => {
    setActionError(null);
    try {
      await accept(id);
      setSuccessMsg('Location confirmed');
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to accept suggestion');
    }
  };

  const handleReject = async (id: string) => {
    setActionError(null);
    try {
      await reject(id);
      setSuccessMsg('Suggestion rejected');
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reject suggestion');
    }
  };

  const handleBulkAcceptConfirm = async () => {
    setBulkConfirmOpen(false);
    if (!activeCircleId) return;
    setActionError(null);
    try {
      await bulkAccept(activeCircleId, BULK_ACCEPT_THRESHOLD);
      setBulkInfo('Queued — accepting high-confidence suggestions in the background…');
      startBulkPoll();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to queue bulk-accept');
    }
  };

  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to review location suggestions.</Alert>
      </Box>
    );
  }

  const pageCount = meta ? Math.max(1, Math.ceil(meta.total / meta.pageSize)) : 1;

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <MyLocationIcon color="primary" />
          <Typography variant="h5" component="h1">
            Location Suggestions
          </Typography>
        </Box>
        <Button
          variant="outlined"
          disabled={items.length === 0 || bulkAccepting || bulkPolling}
          startIcon={bulkAccepting || bulkPolling ? <CircularProgress size={16} /> : undefined}
          onClick={() => setBulkConfirmOpen(true)}
        >
          Accept all &ge; 80% confidence
        </Button>
      </Box>

      {bulkInfo && (
        <Alert severity="info" sx={{ mb: 2 }} icon={<CircularProgress size={18} />}>
          {bulkInfo}
        </Alert>
      )}

      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
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
          <MyLocationIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
          <Typography variant="h6" color="text.secondary" gutterBottom>
            No location suggestions to review
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Photos missing GPS data will be matched against nearby same-device photos here.
          </Typography>
        </Box>
      )}

      {!isLoading && items.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {meta?.total ?? items.length} suggestion{(meta?.total ?? items.length) !== 1 ? 's' : ''} pending review
          </Typography>
          {items.map((s) => (
            <SuggestionRow
              key={s.id}
              suggestion={s}
              acting={actingIds.has(s.id)}
              onAccept={(id) => void handleAccept(id)}
              onReject={(id) => void handleReject(id)}
              onAdjust={(s2) => setAdjustTarget(s2)}
            />
          ))}
          {pageCount > 1 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
              <Pagination count={pageCount} page={page} onChange={(_, p) => setPage(p)} color="primary" />
            </Box>
          )}
        </Box>
      )}

      {/* Adjust dialog */}
      {adjustTarget && (
        <AdjustLocationDialog
          open={!!adjustTarget}
          suggestion={adjustTarget}
          onClose={() => setAdjustTarget(null)}
          onSuccess={(message) => {
            setAdjustTarget(null);
            setSuccessMsg(message);
            refresh();
          }}
        />
      )}

      {/* Bulk accept confirm dialog */}
      <Dialog open={bulkConfirmOpen} onClose={() => setBulkConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Accept high-confidence suggestions</DialogTitle>
        <DialogContent>
          <DialogContentText>
            All pending suggestions in this circle with confidence &ge; {Math.round(BULK_ACCEPT_THRESHOLD * 100)}%
            will be accepted as-is (unmodified coordinates). This runs in the background — the list updates as items
            are accepted, so it may take a moment to fully drain. This cannot be bulk-undone, though each item can
            still be individually reverted afterward.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkConfirmOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void handleBulkAcceptConfirm()}>
            Accept all
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
