import { useEffect, useState } from 'react';
import {
  Drawer,
  Box,
  Typography,
  IconButton,
  Stack,
  Button,
  CircularProgress,
  Alert,
  Divider,
  Collapse,
  FormControlLabel,
  Switch,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from '@mui/material';
import {
  Close as CloseIcon,
  AutoFixHigh as AutoFixHighIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  WarningAmber as WarningAmberIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import type { MediaItem } from '../../types/media';
import { useMediaEnhance } from '../../hooks/useMediaEnhance';
import type {
  EnhanceParams,
  EnhanceStrength,
  EnhanceImageInfo,
  ApplyDecision,
} from '../../services/enhance';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MediaEnhancementDrawerProps {
  item: MediaItem;
  open: boolean;
  onClose: () => void;
  /** Optional model label, shown in the params step (from ai.features.enhance). */
  modelLabel?: string | null;
  /** Called after a successful "replace" so the parent can bust its cache/reload. */
  onReplaced?: () => void;
  /** Called after a successful "keep both" with a success message. */
  onKeptBoth?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(size: string | null): string | null {
  if (size == null) return null;
  const n = Number(size);
  if (!Number.isFinite(n)) return null;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function dimsLabel(info: EnhanceImageInfo | null): string {
  if (!info || info.width == null || info.height == null) return '—';
  return `${info.width}×${info.height}`;
}

// Local compare pane (mirrors DuplicateGroupPage's ComparePane).
function ComparePane({ url, label }: { url: string | null; label: string }) {
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        {label}
      </Typography>
      <Box
        sx={{
          width: '100%',
          height: { xs: 200, sm: 240 },
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
        {url ? (
          <Box
            component="img"
            src={url}
            alt={label}
            sx={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        ) : (
          <CircularProgress size={20} />
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ADJUSTMENT_FIELDS: { key: keyof AdjustmentsState; label: string }[] = [
  { key: 'color', label: 'Correct color & white balance' },
  { key: 'tone', label: 'Balance exposure & tone' },
  { key: 'sharpness', label: 'Increase clarity & sharpness' },
  { key: 'denoise', label: 'Reduce noise' },
  { key: 'dehaze', label: 'Remove haze' },
  { key: 'straighten', label: 'Straighten horizon' },
];

interface AdjustmentsState {
  color: boolean;
  tone: boolean;
  sharpness: boolean;
  denoise: boolean;
  dehaze: boolean;
  straighten: boolean;
}

const DEFAULT_ADJUSTMENTS: AdjustmentsState = {
  color: true,
  tone: true,
  sharpness: true,
  denoise: true,
  dehaze: false,
  straighten: false,
};

/**
 * Right-side drawer that walks the user through the enhance → poll → review →
 * decide flow. Structurally modeled on MediaOrientationEditor (right Drawer,
 * zIndex above the lightbox, busy/error states).
 */
export function MediaEnhancementDrawer({
  item,
  open,
  onClose,
  modelLabel,
  onReplaced,
  onKeptBoth,
}: MediaEnhancementDrawerProps) {
  const theme = useTheme();
  const { status, data, error, polling, start, resumeLatest, apply, discard, reset } =
    useMediaEnhance(item.id);

  // Params state
  const [customize, setCustomize] = useState(false);
  const [adjustments, setAdjustments] = useState<AdjustmentsState>(DEFAULT_ADJUSTMENTS);
  const [strength, setStrength] = useState<EnhanceStrength>('balanced');
  const [preserveFaces, setPreserveFaces] = useState(true);
  const [instructions, setInstructions] = useState('');

  // Decision confirmation + commit state
  const [pendingDecision, setPendingDecision] = useState<ApplyDecision | 'discard' | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  // When the drawer opens, try to resume any in-flight/ready enhancement.
  useEffect(() => {
    if (open) {
      void resumeLatest();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id]);

  const handleClose = () => {
    setPendingDecision(null);
    setCommitError(null);
    onClose();
  };

  const buildParams = (): EnhanceParams => {
    if (!customize) return {};
    return {
      intent: 'custom',
      adjustments: { ...adjustments },
      strength,
      preserveFaces,
      instructions: instructions.trim() ? instructions.trim() : undefined,
    };
  };

  const handleStart = () => {
    setCommitError(null);
    void start(buildParams());
  };

  const confirmDecision = async () => {
    if (!pendingDecision) return;
    setCommitting(true);
    setCommitError(null);
    try {
      if (pendingDecision === 'discard') {
        await discard();
        reset();
        handleClose();
      } else if (pendingDecision === 'keep_both') {
        await apply('keep_both');
        onKeptBoth?.('Enhanced copy saved as a new photo');
        reset();
        handleClose();
      } else {
        await apply('replace');
        onReplaced?.();
        reset();
        handleClose();
      }
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'Failed to apply the enhancement');
      setPendingDecision(null);
    } finally {
      setCommitting(false);
    }
  };

  const enhanced = data?.enhanced ?? null;
  const original = data?.original ?? null;
  const downscaled =
    data?.downscaled ??
    (enhanced?.width != null &&
      original?.width != null &&
      enhanced.width * (enhanced.height ?? 0) < original.width * (original.height ?? 0));

  // ---- Step selection ----
  const showCompare = status === 'ready';
  const showProgress = polling;
  const showParams = !showCompare && !showProgress;

  return (
    <>
      <Drawer
        anchor="right"
        open={open}
        onClose={handleClose}
        variant="temporary"
        sx={{
          zIndex: (t: Theme) => t.zIndex.modal + 2,
          '& .MuiDrawer-paper': {
            width: { xs: '100vw', sm: 420 },
            maxWidth: '100vw',
            display: 'flex',
            flexDirection: 'column',
          },
        }}
      >
        {/* Header */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            px: 2,
            py: 1,
            borderBottom: `1px solid ${theme.palette.divider}`,
          }}
        >
          <IconButton
            onClick={handleClose}
            size="small"
            aria-label="Close enhancer"
            sx={{ minWidth: 44, minHeight: 44 }}
          >
            <CloseIcon />
          </IconButton>
          <AutoFixHighIcon sx={{ ml: 1, color: 'primary.main' }} fontSize="small" />
          <Typography variant="h6" sx={{ ml: 1, flex: 1 }} noWrap>
            AI Enhance
          </Typography>
        </Box>

        {/* Body */}
        <Box sx={{ flex: 1, overflowY: 'auto', px: 2, py: 2 }}>
          {/* ---------- Params step ---------- */}
          {showParams && (
            <Stack spacing={2}>
              {status === 'failed' && error && (
                <Alert severity="error">{error}</Alert>
              )}
              {commitError && <Alert severity="error">{commitError}</Alert>}

              <Typography variant="body2" color="text.secondary">
                Let AI improve exposure, color, clarity and noise. The result is a
                preview you review before anything is saved.
              </Typography>

              {modelLabel && (
                <Typography variant="caption" color="text.secondary">
                  Model: <strong>{modelLabel}</strong>
                </Typography>
              )}

              <Button
                size="small"
                onClick={() => setCustomize((v) => !v)}
                endIcon={customize ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                sx={{ alignSelf: 'flex-start' }}
              >
                Customize
              </Button>

              <Collapse in={customize} unmountOnExit>
                <Stack spacing={1.5}>
                  {ADJUSTMENT_FIELDS.map(({ key, label }) => (
                    <FormControlLabel
                      key={key}
                      control={
                        <Switch
                          size="small"
                          checked={adjustments[key]}
                          onChange={(e) =>
                            setAdjustments((prev) => ({ ...prev, [key]: e.target.checked }))
                          }
                        />
                      }
                      label={label}
                    />
                  ))}

                  <FormControl size="small" fullWidth>
                    <InputLabel>Strength</InputLabel>
                    <Select
                      label="Strength"
                      value={strength}
                      onChange={(e) => setStrength(e.target.value as EnhanceStrength)}
                    >
                      <MenuItem value="subtle">Subtle</MenuItem>
                      <MenuItem value="balanced">Balanced</MenuItem>
                      <MenuItem value="strong">Strong</MenuItem>
                    </Select>
                  </FormControl>

                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={preserveFaces}
                        onChange={(e) => setPreserveFaces(e.target.checked)}
                      />
                    }
                    label="Preserve faces & identities"
                  />

                  <TextField
                    label="Additional instructions"
                    size="small"
                    fullWidth
                    multiline
                    minRows={2}
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value.slice(0, 500))}
                    placeholder="Optional guidance (max 500 chars)"
                    helperText={`${instructions.length}/500`}
                  />
                </Stack>
              </Collapse>

              <Button
                variant="contained"
                startIcon={<AutoFixHighIcon />}
                onClick={handleStart}
              >
                Enhance
              </Button>

              <Typography variant="caption" color="text.secondary">
                Uses AI credits. Nothing is changed until you choose an outcome.
              </Typography>
            </Stack>
          )}

          {/* ---------- Progress step ---------- */}
          {showProgress && (
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
                py: 6,
              }}
            >
              <CircularProgress />
              <Typography variant="body2" color="text.secondary">
                Enhancing your photo… this can take up to a minute.
              </Typography>
            </Box>
          )}

          {/* ---------- Compare step ---------- */}
          {showCompare && (
            <Stack spacing={2}>
              {commitError && <Alert severity="error">{commitError}</Alert>}

              <Stack direction="row" spacing={1.5}>
                <ComparePane url={original?.url ?? item.thumbnailUrl ?? null} label="Original" />
                <ComparePane url={enhanced?.url ?? null} label="Enhanced" />
              </Stack>

              {/* Metadata delta row */}
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr 1fr',
                  columnGap: 1.5,
                  rowGap: 0.5,
                  fontSize: 13,
                }}
              >
                <Box />
                <Typography variant="caption" color="text.secondary">Original</Typography>
                <Typography variant="caption" color="text.secondary">Enhanced</Typography>

                <Typography variant="caption" color="text.secondary">Dimensions</Typography>
                <Typography variant="caption">{dimsLabel(original)}</Typography>
                <Typography variant="caption">{dimsLabel(enhanced)}</Typography>

                <Typography variant="caption" color="text.secondary">Size</Typography>
                <Typography variant="caption">{formatBytes(original?.size ?? null) ?? '—'}</Typography>
                <Typography variant="caption">{formatBytes(enhanced?.size ?? null) ?? '—'}</Typography>
              </Box>

              {downscaled && (
                <Alert severity="warning" icon={<WarningAmberIcon fontSize="inherit" />}>
                  The enhanced image is smaller than the original. Replacing will
                  lower this photo&apos;s resolution.
                </Alert>
              )}

              <Divider />

              {/* Decision bar */}
              <Stack spacing={1}>
                <Button variant="contained" onClick={() => setPendingDecision('keep_both')}>
                  Keep both
                </Button>
                <Button
                  variant="outlined"
                  color="warning"
                  onClick={() => setPendingDecision('replace')}
                >
                  Replace original
                </Button>
                <Button color="inherit" onClick={() => setPendingDecision('discard')}>
                  Discard
                </Button>
              </Stack>
            </Stack>
          )}
        </Box>
      </Drawer>

      {/* Decision confirmation dialog */}
      <Dialog
        open={pendingDecision !== null}
        onClose={() => !committing && setPendingDecision(null)}
        maxWidth="xs"
        fullWidth
        sx={{ zIndex: (t) => t.zIndex.modal + 3 }}
      >
        <DialogTitle>
          {pendingDecision === 'keep_both' && 'Keep both photos?'}
          {pendingDecision === 'replace' && 'Replace the original?'}
          {pendingDecision === 'discard' && 'Discard this enhancement?'}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {pendingDecision === 'keep_both' &&
              'The enhanced photo will be saved as a new item. The original stays untouched.'}
            {pendingDecision === 'replace' &&
              'The original photo will be overwritten with the enhanced version. This cannot be undone.'}
            {pendingDecision === 'discard' &&
              'The enhanced preview will be discarded. Your original photo is unchanged.'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDecision(null)} disabled={committing}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color={pendingDecision === 'replace' ? 'warning' : 'primary'}
            onClick={() => void confirmDecision()}
            disabled={committing}
            startIcon={committing ? <CircularProgress size={16} /> : undefined}
          >
            {pendingDecision === 'keep_both' && 'Keep both'}
            {pendingDecision === 'replace' && 'Replace'}
            {pendingDecision === 'discard' && 'Discard'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
