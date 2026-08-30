import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import type { MediaItem } from '../../types/media';
import { bulkEnhance } from '../../services/media';
import type { BulkEnhanceResult } from '../../services/media';
import type { EnhanceQuality, EnhanceStrength } from '../../services/enhance';
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

interface BatchEnhanceDialogProps {
  open: boolean;
  onClose: () => void;
  circleId: string;
  /**
   * The WHOLE selection, videos included. The dialog derives the photo subset
   * itself so it can tell the user exactly what will be skipped rather than
   * silently shrinking their selection.
   */
  items: MediaItem[];
  /** `pictureEnhancement.maxBatchSize` from GET /api/features. */
  maxBatchSize?: number;
  /** Optional model label (from ai.features.enhance), shown for transparency. */
  modelLabel?: string | null;
  /**
   * One-line summary built from the SERVER's counts, for the parent snackbar.
   *
   * The batch id rides along (issue #423) so the toast can offer a way to the
   * batch's progress page — otherwise the only record of a just-submitted batch
   * is a sentence that disappears in four seconds.
   */
  onSuccess: (message: string, batchId: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "12 photos" / "1 photo". */
const photoCountLabel = (n: number) => `${n} ${plural(n, 'photo', 'photos')}`;

function skippedTotal(result: BulkEnhanceResult): number {
  const { notPhoto, tooLarge, alreadyLive } = result.skipped;
  return notPhoto + tooLarge + alreadyLive;
}

/**
 * Toast copy, built strictly from what the server reported — never from the
 * client's optimistic count. A batch where half the selection already had a
 * live enhancement must not claim it queued the whole selection.
 */
function summarize(result: BulkEnhanceResult): string {
  const base = `Queued AI enhancement for ${photoCountLabel(result.queued)}`;
  const skipped = skippedTotal(result);
  return skipped > 0 ? `${base} · ${skipped} skipped` : base;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Multi-photo AI Enhance submit dialog (issue #422).
 *
 * Deliberately a Dialog, not the single-item drawer: a batch produces no result
 * to compare here, so the drawer's params → progress → compare state machine
 * does not apply. Each queued enhancement is still reviewed one at a time later
 * (gallery selection, lightbox, or the Enhancements hub) — nothing this dialog
 * starts can change a photo on its own.
 */
export function BatchEnhanceDialog({
  open,
  onClose,
  circleId,
  items,
  maxBatchSize,
  modelLabel,
  onSuccess,
}: BatchEnhanceDialogProps) {
  // ---- Params state (mirrors the drawer's, minus the review machinery) -----
  const [presetKey, setPresetKey] = useState<PresetKey>('auto');
  const [customize, setCustomize] = useState(false);
  const [adjustments, setAdjustments] = useState<AdjustmentsState>(DEFAULT_ADJUSTMENTS);
  const [strength, setStrength] = useState<EnhanceStrength>('balanced');
  const [preserveFaces, setPreserveFaces] = useState(true);
  const [instructions, setInstructions] = useState('');
  /** Empty string = "let the server's pictureEnhancement.defaultQuality apply". */
  const [quality, setQuality] = useState<EnhanceQuality | ''>('');

  // ---- Submit state --------------------------------------------------------
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set only when the server skipped something: the dialog stays open to show
   * the per-reason breakdown, since a one-line toast cannot explain why 4 of 12
   * photos were left out.
   */
  const [result, setResult] = useState<BulkEnhanceResult | null>(null);

  // A fresh open is a fresh submission — never inherit the previous run's
  // outcome or error banner.
  useEffect(() => {
    if (open) {
      setSubmitting(false);
      setError(null);
      setResult(null);
    }
  }, [open]);

  // ---- Selection breakdown -------------------------------------------------
  const photoIds = useMemo(
    () => items.filter((it) => it.type === 'photo').map((it) => it.id),
    [items],
  );
  const photoCount = photoIds.length;
  const videoCount = items.length - photoCount;

  const overCap = maxBatchSize != null && photoCount > maxBatchSize;
  const excess = overCap ? photoCount - (maxBatchSize as number) : 0;

  const formState = useMemo<EnhanceFormState>(
    () => ({ presetKey, adjustments, strength, preserveFaces, instructions, quality }),
    [presetKey, adjustments, strength, preserveFaces, instructions, quality],
  );

  const selectPreset = (key: PresetKey) => {
    const def = PRESET_BY_KEY.get(key);
    setPresetKey(key);
    if (!def) return;
    // Prefill, but leave everything editable — subsequent tweaks are sent.
    setAdjustments(def.prefill.adjustments);
    setStrength(def.prefill.strength);
    setPreserveFaces(def.prefill.preserveFaces);
    if (key === 'custom') setCustomize(true);
  };

  // ---- Submit --------------------------------------------------------------

  /** Emit the toast and hand control back to the parent (which clears the selection). */
  const finish = (res: BulkEnhanceResult) => {
    onSuccess(summarize(res), res.batchId);
    onClose();
  };

  const handleSubmit = async () => {
    if (submitting || overCap || photoCount === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await bulkEnhance({
        circleId,
        ids: photoIds,
        params: buildEnhanceParams(formState),
      });
      if (skippedTotal(res) > 0) {
        // Hold the dialog open so the breakdown is read before it disappears.
        setResult(res);
      } else {
        finish(res);
      }
    } catch (err) {
      // A 400 here is the server explaining itself (cap exceeded, feature
      // disabled, no model configured) — show its message verbatim.
      setError(err instanceof Error ? err.message : 'Failed to queue AI enhancements');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (submitting) return;
    if (result) {
      finish(result);
      return;
    }
    onClose();
  };

  // ---- Render --------------------------------------------------------------

  const showResult = result !== null;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby="batch-enhance-title"
    >
      <DialogTitle id="batch-enhance-title" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <AutoFixHighIcon color="primary" fontSize="small" />
        <Box component="span" sx={{ minWidth: 0 }}>
          {showResult
            ? 'AI enhancements queued'
            : `Enhance ${photoCountLabel(photoCount)} with AI`}
        </Box>
      </DialogTitle>

      <DialogContent dividers>
        {showResult ? (
          // ---------- Outcome step (only when something was skipped) --------
          <Stack spacing={2}>
            <Typography variant="body2">
              Queued AI enhancement for{' '}
              <strong>{photoCountLabel(result.queued)}</strong> out of the{' '}
              {photoCountLabel(result.requested)} sent.
            </Typography>

            <Alert severity="info" variant="outlined">
              <AlertTitle>
                {skippedTotal(result)}{' '}
                {plural(skippedTotal(result), 'photo was', 'photos were')} skipped
              </AlertTitle>
              <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.5 }}>
                {result.skipped.alreadyLive > 0 && (
                  <Typography component="li" variant="body2">
                    <strong>{result.skipped.alreadyLive}</strong> already{' '}
                    {plural(result.skipped.alreadyLive, 'has', 'have')} an enhancement
                    in progress or waiting for your decision. Existing results are
                    never discarded — review them first, then re-run.
                  </Typography>
                )}
                {result.skipped.tooLarge > 0 && (
                  <Typography component="li" variant="body2">
                    <strong>{result.skipped.tooLarge}</strong>{' '}
                    {plural(result.skipped.tooLarge, 'is', 'are')} too large for the
                    enhancer.
                  </Typography>
                )}
                {result.skipped.notPhoto > 0 && (
                  <Typography component="li" variant="body2">
                    <strong>{result.skipped.notPhoto}</strong>{' '}
                    {plural(result.skipped.notPhoto, 'is', 'are')} not an enhanceable
                    photo.
                  </Typography>
                )}
              </Stack>
            </Alert>

            <Typography variant="body2" color="text.secondary">
              The queued photos process in the background. You&apos;ll review and
              approve each result before anything changes.
            </Typography>
          </Stack>
        ) : (
          // ---------- Params step -------------------------------------------
          <Stack spacing={2}>
            {error && <Alert severity="error">{error}</Alert>}

            {videoCount > 0 && (
              <Typography variant="body2" color="text.secondary">
                {videoCount} {plural(videoCount, 'video', 'videos')} in your selection
                will be skipped — AI Enhance works on photos only.
              </Typography>
            )}

            {overCap && (
              <Alert severity="warning">
                You selected {photoCountLabel(photoCount)}; the limit is{' '}
                {maxBatchSize} per batch. Deselect {excess}, or ask an admin to raise
                the limit.
              </Alert>
            )}

            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }} id="batch-enhance-preset-label">
                What are we fixing?
              </Typography>
              <PresetPicker
                presetKey={presetKey}
                onSelect={selectPreset}
                labelId="batch-enhance-preset-label"
              />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                One setting applies to every photo in this batch.
              </Typography>
            </Box>

            {presetKey === 'colorize_bw' && (
              <Alert severity="warning" variant="outlined">
                Colorizing is interpretive: the colors are the AI&apos;s best guess,
                not the real colors of the scene. Keep the originals if the true
                colors matter.
              </Alert>
            )}

            {modelLabel && (
              <Typography variant="caption" color="text.secondary">
                Model: <strong>{modelLabel}</strong>
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

            <Divider />

            {/* Cost confirmation — names the exact count, never "these photos". */}
            <Alert severity="warning" icon={<AutoFixHighIcon fontSize="inherit" />}>
              This will start {photoCount} AI{' '}
              {plural(photoCount, 'enhancement', 'enhancements')}. Each one uses AI
              credits and cannot be undone once started. You&apos;ll review and
              approve each result before anything changes.
            </Alert>
          </Stack>
        )}
      </DialogContent>

      <DialogActions>
        {showResult ? (
          <Button variant="contained" onClick={handleClose} sx={{ minHeight: 44 }}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={handleClose} disabled={submitting} sx={{ minHeight: 44 }}>
              Cancel
            </Button>
            <Button
              variant="contained"
              onClick={() => void handleSubmit()}
              // Disabled while in flight so a double-tap cannot queue (and bill)
              // the same selection twice.
              disabled={submitting || overCap || photoCount === 0}
              startIcon={
                submitting ? <CircularProgress size={16} color="inherit" /> : <AutoFixHighIcon />
              }
              sx={{ minHeight: 44 }}
            >
              {submitting ? 'Queueing…' : `Enhance ${photoCountLabel(photoCount)}`}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
