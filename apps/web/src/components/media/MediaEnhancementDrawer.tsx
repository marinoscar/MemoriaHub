import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Drawer,
  Box,
  Typography,
  IconButton,
  Stack,
  Button,
  CircularProgress,
  LinearProgress,
  Alert,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ScheduleIcon from '@mui/icons-material/Schedule';
import { useTheme } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import type { MediaItem } from '../../types/media';
import { useMediaEnhance } from '../../hooks/useMediaEnhance';
import type { EnhanceUiStatus } from '../../hooks/useMediaEnhance';
import { BeforeAfterSlider } from './BeforeAfterSlider';
import { ReplaceDownscaleNotice, describeResolutionLoss } from './ReplaceDownscaleNotice';
import type {
  EnhanceQuality,
  EnhanceStrength,
  EnhanceImageInfo,
  ApplyDecision,
} from '../../services/enhance';
// Presets, the customize panel and the params mapping are SHARED with
// BatchEnhanceDialog (issue #422) so the two surfaces cannot drift.
import {
  DEFAULT_ADJUSTMENTS,
  PRESET_BY_KEY,
  PresetPicker,
  EnhanceCustomizePanel,
  buildEnhanceParams,
} from './enhancePresets';
import type { AdjustmentsState, EnhanceFormState, PresetKey } from './enhancePresets';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MediaEnhancementDrawerProps {
  item: MediaItem;
  open: boolean;
  onClose: () => void;
  /**
   * Open directly onto a KNOWN enhancement instead of the item's latest one.
   * Used by the AI Enhancements hub (issue #201), where the user has already
   * picked the row they want to review. Omitted by the per-item call sites
   * (gallery selection bar, lightbox), which keep resolving the latest.
   */
  enhancementId?: string;
  /** Optional model label, shown in the params step (from ai.features.enhance). */
  modelLabel?: string | null;
  /**
   * Server-resolved replace policy (from GET /api/features). Consumed by the
   * compare step so the user learns replacing is unavailable BEFORE confirming
   * a destructive action instead of after a 400.
   */
  replacePolicy?: {
    allowReplace: boolean;
    blockReplaceOnDownscale: boolean;
  };
  /** Called after a successful "replace" so the parent can bust its cache/reload. */
  onReplaced?: () => void;
  /** Called after a successful "keep both" with a success message. */
  onKeptBoth?: (message: string) => void;
  /**
   * Fired when the enhancement reaches a terminal state while this drawer is
   * CLOSED, so the parent can surface a snackbar. Polling continues while the
   * drawer is closed as long as the parent keeps this component mounted (both
   * current call sites do); reopening restores the review via `resumeLatest`.
   */
  onFinishedInBackground?: (status: 'ready' | 'failed') => void;
}

// ---------------------------------------------------------------------------
// Progress copy
// ---------------------------------------------------------------------------

/**
 * Deliberately generic. The API gives us no insight into the model's internal
 * stage, so these must not claim to know one.
 */
const PROGRESS_MESSAGES = [
  'Sending your photo to the model…',
  'Recovering detail…',
  'Balancing color and light…',
  'Almost there — large photos can take a minute.',
];
const MESSAGE_ROTATE_MS = 6000;

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

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Right-side drawer that walks the user through the enhance → poll → review →
 * decide flow. Structurally modeled on MediaOrientationEditor (right Drawer,
 * zIndex above the lightbox, busy/error states).
 */
export function MediaEnhancementDrawer({
  item,
  open,
  onClose,
  enhancementId,
  modelLabel,
  replacePolicy,
  onReplaced,
  onKeptBoth,
  onFinishedInBackground,
}: MediaEnhancementDrawerProps) {
  const theme = useTheme();
  const { status, data, error, polling, startedAt, start, resumeLatest, apply, discard, reset } =
    useMediaEnhance(item.id);

  // Params state
  const [presetKey, setPresetKey] = useState<PresetKey>('auto');
  const [customize, setCustomize] = useState(false);
  const [adjustments, setAdjustments] = useState<AdjustmentsState>(DEFAULT_ADJUSTMENTS);
  const [strength, setStrength] = useState<EnhanceStrength>('balanced');
  const [preserveFaces, setPreserveFaces] = useState(true);
  const [instructions, setInstructions] = useState('');
  /** Empty string = "let the server's pictureEnhancement.defaultQuality apply". */
  const [quality, setQuality] = useState<EnhanceQuality | ''>('');

  // Decision confirmation + commit state
  const [pendingDecision, setPendingDecision] = useState<ApplyDecision | 'discard' | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  // When the drawer opens, try to resume any in-flight/ready enhancement.
  // `enhancementId` (when supplied) narrows the SAME resume path to one known
  // row instead of the item's latest — it does not add a second code path.
  useEffect(() => {
    if (open) {
      void resumeLatest(enhancementId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id, enhancementId]);

  // ---- Background completion notification ----------------------------------
  const prevStatusRef = useRef<EnhanceUiStatus>(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (open || prev === status) return;
    if ((status === 'ready' || status === 'failed') && (prev === 'pending' || prev === 'processing')) {
      onFinishedInBackground?.(status);
    }
  }, [status, open, onFinishedInBackground]);

  const handleClose = () => {
    setPendingDecision(null);
    setCommitError(null);
    onClose();
  };

  // ---- Preset selection ----------------------------------------------------
  const selectPreset = useCallback((key: PresetKey) => {
    const def = PRESET_BY_KEY.get(key);
    setPresetKey(key);
    if (!def) return;
    // Prefill, but leave everything editable — subsequent tweaks are sent.
    setAdjustments(def.prefill.adjustments);
    setStrength(def.prefill.strength);
    setPreserveFaces(def.prefill.preserveFaces);
    if (key === 'custom') setCustomize(true);
  }, []);

  /** Everything `buildEnhanceParams` / `isFormCustomized` read, in one object. */
  const formState = useMemo<EnhanceFormState>(
    () => ({ presetKey, adjustments, strength, preserveFaces, instructions, quality }),
    [presetKey, adjustments, strength, preserveFaces, instructions, quality],
  );

  const handleStart = () => {
    setCommitError(null);
    void start(buildEnhanceParams(formState));
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
        // The acknowledgement is only sent when the admin guard is actually in
        // force for THIS result — never as a blanket flag (issue #426).
        await apply('replace', { acknowledgeDownscale: replaceNeedsDownscaleAck });
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

  // ---- Replace policy ------------------------------------------------------
  // `allowReplace: false` is a HARD policy (button hidden entirely).
  // `blockReplaceOnDownscale` is a CONFIRM-THROUGH guard (issue #426): the
  // button stays usable, but the commit carries an explicit acknowledgement
  // and the confirmation dialog escalates to name the exact resolution loss.
  const allowReplace = replacePolicy?.allowReplace ?? true;
  const blockReplaceOnDownscale = replacePolicy?.blockReplaceOnDownscale ?? false;
  const replaceNeedsDownscaleAck =
    allowReplace && blockReplaceOnDownscale && Boolean(downscaled);
  const resolutionLoss = describeResolutionLoss(
    original?.width ?? item.width ?? null,
    original?.height ?? item.height ?? null,
    enhanced?.width ?? null,
    enhanced?.height ?? null,
  );

  // ---- Progress ticker -----------------------------------------------------
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [polling]);

  const [messageIndex, setMessageIndex] = useState(0);
  useEffect(() => {
    if (status !== 'processing') {
      setMessageIndex(0);
      return;
    }
    const id = setInterval(
      () => setMessageIndex((i) => Math.min(i + 1, PROGRESS_MESSAGES.length - 1)),
      MESSAGE_ROTATE_MS,
    );
    return () => clearInterval(id);
  }, [status]);

  const elapsedLabel = startedAt != null ? formatElapsed(now - startedAt) : null;
  const queued = status === 'pending';

  // ---- Step selection ------------------------------------------------------
  const showCompare = status === 'ready';
  const showProgress = polling;
  const showParams = !showCompare && !showProgress;

  const effectiveModel = data?.model ?? modelLabel ?? null;

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
            width: { xs: '100vw', sm: 460 },
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
              {/* Any non-null error belongs here — a rejected start leaves the
                  hook at `idle`, so gating on status === 'failed' used to
                  swallow every 400 from the enhance endpoint. */}
              {error && <Alert severity="error">{error}</Alert>}
              {commitError && <Alert severity="error">{commitError}</Alert>}

              <Typography variant="body2" color="text.secondary">
                Let AI improve exposure, color, clarity and noise. The result is a
                preview you review before anything is saved.
              </Typography>

              {/* Preset picker */}
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1 }} id="enhance-preset-label">
                  What are we fixing?
                </Typography>
                <PresetPicker
                  presetKey={presetKey}
                  onSelect={selectPreset}
                  labelId="enhance-preset-label"
                />
              </Box>

              {presetKey === 'colorize_bw' && (
                <Alert severity="warning" variant="outlined">
                  Colorizing is interpretive: the colors are the AI&apos;s best guess,
                  not the real colors of the scene. Keep the original if the true
                  colors matter.
                </Alert>
              )}

              {effectiveModel && (
                <Typography variant="caption" color="text.secondary">
                  Model: <strong>{effectiveModel}</strong>
                </Typography>
              )}

              <Button
                size="small"
                onClick={() => setCustomize((v) => !v)}
                endIcon={customize ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                sx={{ alignSelf: 'flex-start', minHeight: 44 }}
              >
                Customize
              </Button>

              <EnhanceCustomizePanel
                open={customize}
                adjustments={adjustments}
                onAdjustmentsChange={setAdjustments}
                strength={strength}
                onStrengthChange={setStrength}
                quality={quality}
                onQualityChange={setQuality}
                preserveFaces={preserveFaces}
                onPreserveFacesChange={setPreserveFaces}
                instructions={instructions}
                onInstructionsChange={setInstructions}
              />

              <Button
                variant="contained"
                startIcon={<AutoFixHighIcon />}
                onClick={handleStart}
                sx={{ minHeight: 44 }}
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
            <Stack spacing={2} sx={{ py: 4, alignItems: 'center', textAlign: 'center' }}>
              {/* Exactly one progressbar at a time: a "query" bar while the job
                  is still queued (nothing is computing yet), the familiar
                  spinner once a worker has actually claimed it. */}
              {queued ? (
                <Box sx={{ width: '100%', maxWidth: 320 }}>
                  <LinearProgress variant="query" aria-label="Queued" />
                </Box>
              ) : (
                <CircularProgress />
              )}

              <Stack spacing={0.5} sx={{ alignItems: 'center' }}>
                <Typography variant="subtitle1">
                  {queued ? 'Waiting for a free worker…' : 'Enhancing your photo…'}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {queued
                    ? 'Your photo is in the queue. It will start as soon as a worker picks it up.'
                    : PROGRESS_MESSAGES[messageIndex]}
                </Typography>
              </Stack>

              {elapsedLabel && (
                <Stack
                  direction="row"
                  spacing={0.5}
                  sx={{ color: 'text.secondary', alignItems: 'center' }}
                >
                  <ScheduleIcon fontSize="inherit" />
                  <Typography variant="caption">Elapsed {elapsedLabel}</Typography>
                </Stack>
              )}

              <Divider flexItem />

              <Typography variant="caption" color="text.secondary">
                This usually takes 10–60 seconds. You can close this panel and keep
                browsing — we&apos;ll let you know when the preview is ready, and it
                will be waiting here.
              </Typography>
              <Button variant="outlined" onClick={handleClose} sx={{ minHeight: 44 }}>
                Continue in background
              </Button>
            </Stack>
          )}

          {/* ---------- Compare step ---------- */}
          {showCompare && (
            <Stack spacing={2}>
              {commitError && <Alert severity="error">{commitError}</Alert>}

              <BeforeAfterSlider
                beforeUrl={original?.url ?? item.thumbnailUrl ?? null}
                afterUrl={enhanced?.url ?? null}
                beforeLabel="Original"
                afterLabel="Enhanced"
                beforeWidth={original?.width ?? item.width}
                beforeHeight={original?.height ?? item.height}
                afterWidth={enhanced?.width}
                afterHeight={enhanced?.height}
                height={{ xs: 300, sm: 400 }}
              />

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

              {effectiveModel && (
                <Typography variant="caption" color="text.secondary">
                  Enhanced with <strong>{effectiveModel}</strong>
                </Typography>
              )}

              {/* Always rendered — never a hover-only tooltip (issue #426). */}
              {downscaled && (
                <ReplaceDownscaleNotice
                  policyBlocked={replaceNeedsDownscaleAck}
                  resolutionLoss={resolutionLoss}
                />
              )}

              <Divider />

              {/* Decision bar */}
              <Stack spacing={1}>
                <Button
                  variant="contained"
                  onClick={() => setPendingDecision('keep_both')}
                  sx={{ minHeight: 44 }}
                >
                  Keep both
                </Button>

                {allowReplace ? (
                  <Button
                    fullWidth
                    variant="outlined"
                    color="warning"
                    onClick={() => setPendingDecision('replace')}
                    sx={{ minHeight: 44 }}
                  >
                    Replace original
                  </Button>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    An administrator has disabled replacing originals, so the enhanced
                    photo can only be saved as a new copy.
                  </Typography>
                )}

                <Button color="inherit" onClick={() => setPendingDecision('discard')} sx={{ minHeight: 44 }}>
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
          <DialogContentText component="div">
            {pendingDecision === 'keep_both' && (
              <>
                The enhanced photo is saved as a new item in this circle. Your
                original file is left completely untouched, so you can compare them
                later or delete either one.
              </>
            )}
            {pendingDecision === 'replace' && (
              <>
                The original file is overwritten in place with the enhanced
                version — there is no version history.{' '}
                <strong>The original cannot be recovered afterwards.</strong> The
                photo&apos;s date, location and camera details are preserved.
                {downscaled && (
                  <Box component="span" sx={{ display: 'block', mt: 1.5 }}>
                    <strong>You will lose resolution:</strong>{' '}
                    {resolutionLoss ?? 'the enhanced image is smaller than the original'}
                    .
                    {replaceNeedsDownscaleAck && (
                      <>
                        {' '}
                        An administrator has set replacing to be blocked when the
                        result is smaller; continuing records your acknowledgement.
                      </>
                    )}
                  </Box>
                )}
              </>
            )}
            {pendingDecision === 'discard' && (
              <>The enhanced preview will be discarded. Your original photo is unchanged.</>
            )}
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
