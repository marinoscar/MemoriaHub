import { useCallback, useEffect, useState } from 'react';
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
  IconButton,
  Tooltip,
  TextField,
} from '@mui/material';
import {
  MyLocation as MyLocationIcon,
  Warning as WarningIcon,
  Check as CheckIcon,
  EditLocationAlt as EditLocationAltIcon,
  Close as CloseIcon,
  Settings as SettingsIcon,
} from '@mui/icons-material';
import { useNavigate, Link as RouterLink } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { useLocationSuggestions } from '../../hooks/useLocationSuggestions';
import {
  startLocationAcceptRun,
  startLocationRejectRun,
} from '../../services/locationSuggestionRuns';
import { LocationMiniMap } from '../../components/media/LocationMiniMap';
import { AdjustLocationDialog } from './AdjustLocationDialog';
import type { LocationSuggestionSummary } from '../../services/locationSuggestions';

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
  const navigate = useNavigate();
  const { activeCircle, activeCircleId } = useCircle();
  const { isAdmin } = usePermissions();
  const { settings } = useSystemSettings();
  const { items, meta, isLoading, error, fetchSuggestions, accept, reject, actingIds } =
    useLocationSuggestions();
  const [page, setPage] = useState(1);
  const [adjustTarget, setAdjustTarget] = useState<LocationSuggestionSummary | null>(null);
  const [bulkAction, setBulkAction] = useState<'accept' | 'reject' | null>(null);
  const [bulkStarting, setBulkStarting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Persisted default confidence floor (0–100 int); user can adjust inline.
  const persisted = settings?.locationInference?.bulkAcceptThreshold ?? 80;
  const [thresholdPct, setThresholdPct] = useState(persisted);

  // Re-sync the inline threshold whenever the persisted default loads/changes.
  useEffect(() => {
    setThresholdPct(persisted);
  }, [persisted]);

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

  const handleBulkConfirm = async () => {
    const action = bulkAction;
    setBulkAction(null);
    if (!action || !activeCircleId) return;
    setActionError(null);
    setBulkStarting(true);
    try {
      const res =
        action === 'accept'
          ? await startLocationAcceptRun({ circleId: activeCircleId, threshold: thresholdPct })
          : await startLocationRejectRun({ circleId: activeCircleId, threshold: thresholdPct });
      navigate(`/location-suggestion-runs/${res.runId}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to start bulk run');
      setBulkStarting(false);
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
          <MyLocationIcon color="primary" />
          <Typography variant="h5" component="h1">
            Location Suggestions
          </Typography>
          {isAdmin && (
            <Tooltip title="Location inference settings">
              <IconButton
                component={RouterLink}
                to="/admin/settings/location-inference"
                aria-label="Location inference settings"
                size="small"
              >
                <SettingsIcon />
              </IconButton>
            </Tooltip>
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <TextField
            label="Threshold %"
            type="number"
            size="small"
            value={thresholdPct}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isNaN(n)) return;
              setThresholdPct(Math.max(0, Math.min(100, Math.round(n))));
            }}
            slotProps={{ htmlInput: { min: 0, max: 100, step: 1 } }}
            sx={{ width: 120 }}
          />
          <Button
            variant="outlined"
            color="success"
            disabled={items.length === 0 || bulkStarting}
            startIcon={bulkStarting ? <CircularProgress size={16} /> : undefined}
            onClick={() => setBulkAction('accept')}
          >
            Accept all &ge; {thresholdPct}%
          </Button>
          <Button
            variant="outlined"
            color="warning"
            disabled={items.length === 0 || bulkStarting}
            startIcon={bulkStarting ? <CircularProgress size={16} /> : undefined}
            onClick={() => setBulkAction('reject')}
          >
            Reject all &lt; {thresholdPct}%
          </Button>
        </Box>
      </Box>

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

      {/* Bulk accept/reject confirm dialog */}
      <Dialog
        open={Boolean(bulkAction)}
        onClose={() => setBulkAction(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>
          {bulkAction === 'reject'
            ? `Reject suggestions below ${thresholdPct}%?`
            : `Accept suggestions ≥ ${thresholdPct}%?`}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {bulkAction === 'reject' ? (
              <>
                This starts a background run that rejects every pending suggestion below{' '}
                {thresholdPct}% confidence and shows live progress. Large backlogs are processed in
                the background.
              </>
            ) : (
              <>
                This starts a background run that accepts every pending suggestion at/above{' '}
                {thresholdPct}% confidence and shows live progress. Large backlogs are processed in
                the background.
              </>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkAction(null)}>Cancel</Button>
          <Button
            variant="contained"
            color={bulkAction === 'reject' ? 'warning' : 'success'}
            onClick={() => void handleBulkConfirm()}
          >
            {bulkAction === 'reject' ? 'Reject all' : 'Accept all'}
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
