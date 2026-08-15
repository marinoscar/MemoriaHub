import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import {
  ADJUSTMENT_FIELDS,
  DEFAULT_ADJUSTMENTS,
  PRESETS,
  PresetCard,
  buildEnhanceParams,
  resolvePreset,
} from './enhancePresets';
import type { AdjustmentsState, PresetKey } from './enhancePresets';
import { bulkEnhance } from '../../services/media';
import type { BulkEnhanceResult } from '../../services/media';
import type { EnhanceQuality, EnhanceStrength } from '../../services/enhance';

// ---------------------------------------------------------------------------
// Target
//
// What a batch acts on. Today there is exactly one kind — an explicit client
// selection — but the dialog reads `photoCount` and delegates submission to
// `submitTarget`, so issue #424's "enhance everything matching this filter"
// mode can be added as a second member whose count comes from the server
// (a resolved `matchedCount`) without reworking any of the UI below.
// ---------------------------------------------------------------------------

export interface BatchEnhanceSelectionTarget {
  kind: 'selection';
  circleId: string;
  /** Ids of the selected PHOTOS. Non-photos are excluded before we get here. */
  photoIds: string[];
  /**
   * Non-photo items sharing the selection. Reported to the user so a batch of
   * "12 of your 15 selected items" is never a silent surprise; never sent.
   */
  nonPhotoCount: number;
}

export type BatchEnhanceTarget = BatchEnhanceSelectionTarget;

/** How many photos this target will enhance, as far as the client can tell. */
function targetPhotoCount(target: BatchEnhanceTarget): number {
  return target.photoIds.length;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface BatchEnhanceDialogProps {
  open: boolean;
  onClose: () => void;
  target: BatchEnhanceTarget;
  /**
   * Server-enforced ceiling (`pictureEnhancement.maxBatchSize`, from
   * GET /api/features). Submission is disabled above it — the server rejects an
   * over-cap request with a 400 either way; this is the courteous half.
   */
  maxBatchSize: number;
  /** Optional model label, shown alongside the presets (ai.features.enhance). */
  modelLabel?: string | null;
  /** Called with the one-line, SERVER-derived summary once the batch is queued. */
  onSuccess: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function totalSkipped(result: BulkEnhanceResult): number {
  const { notPhoto, tooLarge, alreadyLive } = result.skipped;
  return notPhoto + tooLarge + alreadyLive;
}

/**
 * The toast line. Built from the SERVER's counts — never the client's
 * optimistic selection size, since eligibility is decided server-side and a
 * selection of 30 can legitimately queue 26.
 */
function buildResultMessage(result: BulkEnhanceResult): string {
  const skipped = totalSkipped(result);
  if (result.queued === 0) {
    return skipped > 0
      ? `No photos queued — ${plural(skipped, 'photo was', 'photos were')} skipped`
      : 'No photos were queued';
  }
  const base = `Queued AI enhancement for ${plural(result.queued, 'photo', 'photos')}`;
  return skipped > 0 ? `${base} · ${skipped} skipped` : base;
}

const SKIP_REASON_LABELS: { key: keyof BulkEnhanceResult['skipped']; label: string }[] = [
  { key: 'notPhoto', label: 'not a photo' },
  { key: 'tooLarge', label: 'too large to enhance' },
  { key: 'alreadyLive', label: 'already has an enhancement waiting for review' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Multi-photo AI enhance.
 *
 * Deliberately a Dialog rather than the single-item drawer: a batch produces no
 * result to compare, so the drawer's params → progress → compare → decide
 * machine does not apply. One preset applies to every photo in the batch —
 * per-photo tuning would be guesswork before seeing any result — and each
 * result is still reviewed individually in the Enhancements hub afterwards.
 */
export function BatchEnhanceDialog({
  open,
  onClose,
  target,
  maxBatchSize,
  modelLabel,
  onSuccess,
}: BatchEnhanceDialogProps) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));

  const photoCount = targetPhotoCount(target);
  const overCap = photoCount > maxBatchSize;

  // Params state — same vocabulary as the single-item drawer (./enhancePresets)
  const [presetKey, setPresetKey] = useState<PresetKey>('auto');
  const [customize, setCustomize] = useState(false);
  const [adjustments, setAdjustments] = useState<AdjustmentsState>(DEFAULT_ADJUSTMENTS);
  const [strength, setStrength] = useState<EnhanceStrength>('balanced');
  const [preserveFaces, setPreserveFaces] = useState(true);
  const [instructions, setInstructions] = useState('');
  /** Empty string = "let the server's pictureEnhancement.defaultQuality apply". */
  const [quality, setQuality] = useState<EnhanceQuality | ''>('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set once the batch is queued; the dialog then shows the skip breakdown. */
  const [result, setResult] = useState<BulkEnhanceResult | null>(null);

  // A reopened dialog is a fresh decision — never a stale result or error.
  useEffect(() => {
    if (open) {
      setError(null);
      setResult(null);
      setSubmitting(false);
    }
  }, [open]);

  const formState = useMemo(
    () => ({ presetKey, adjustments, strength, preserveFaces, instructions, quality }),
    [presetKey, adjustments, strength, preserveFaces, instructions, quality],
  );

  const selectPreset = (key: PresetKey) => {
    const def = resolvePreset(key);
    setPresetKey(key);
    // Prefill, but leave everything editable — subsequent tweaks are sent.
    setAdjustments(def.prefill.adjustments);
    setStrength(def.prefill.strength);
    setPreserveFaces(def.prefill.preserveFaces);
    if (key === 'custom') setCustomize(true);
  };

  const submitTarget = async (): Promise<BulkEnhanceResult> =>
    bulkEnhance({
      circleId: target.circleId,
      ids: target.photoIds,
      params: buildEnhanceParams(formState),
    });

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await submitTarget();
      const message = buildResultMessage(res);
      if (totalSkipped(res) > 0) {
        // Keep the dialog open so the per-reason breakdown is actually read;
        // the toast only ever carries the one-line summary.
        setResult(res);
      } else {
        onSuccess(message);
        onClose();
      }
    } catch (err) {
      // Render the SERVER's message (cap exceeded, feature disabled, no model
      // configured) inline and leave the dialog open — the selection is still
      // intact, so the user can act on what they were told.
      setError(err instanceof Error ? err.message : 'Failed to queue AI enhancements');
    } finally {
      setSubmitting(false);
    }
  };

  const finishAfterResult = () => {
    if (result) onSuccess(buildResultMessage(result));
    onClose();
  };

  const showResult = result !== null;

  return (
    <Dialog
      open={open}
      onClose={() => !submitting && onClose()}
      fullWidth
      maxWidth="sm"
      fullScreen={fullScreen}
      aria-labelledby="batch-enhance-title"
    >
      <DialogTitle id="batch-enhance-title" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <AutoFixHighIcon color="primary" fontSize="small" />
        <Box component="span" sx={{ minWidth: 0 }}>
          {showResult
            ? 'AI enhancements queued'
            : `Enhance ${plural(photoCount, 'photo', 'photos')} with AI`}
        </Box>
      </DialogTitle>

      <DialogContent dividers>
        {showResult ? (
          // ---------- Result step: the per-reason skip breakdown ----------
          <Stack spacing={2}>
            <Alert severity={result.queued > 0 ? 'success' : 'warning'}>
              {result.queued > 0
                ? `${plural(result.queued, 'photo is', 'photos are')} now in the enhancement queue.`
                : 'Nothing was queued.'}
            </Alert>

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                {plural(totalSkipped(result), 'photo was', 'photos were')} skipped
              </Typography>
              <Stack component="ul" spacing={0.5} sx={{ pl: 3, m: 0 }}>
                {SKIP_REASON_LABELS.filter(({ key }) => result.skipped[key] > 0).map(
                  ({ key, label }) => (
                    <Typography key={key} component="li" variant="body2" color="text.secondary">
                      {result.skipped[key]} {label}
                    </Typography>
                  ),
                )}
              </Stack>
            </Box>

            <Typography variant="body2" color="text.secondary">
              Results appear in AI Enhancements as they finish. Nothing changes
              until you review and approve each one.
            </Typography>
          </Stack>
        ) : (
          // ---------- Params step ----------
          <Stack spacing={2}>
            {error && <Alert severity="error">{error}</Alert>}

            {target.nonPhotoCount > 0 && (
              <Alert severity="info">
                {plural(target.nonPhotoCount, 'video', 'videos')} in your selection
                will be skipped. AI Enhance works on photos only.
              </Alert>
            )}

            {overCap && (
              <Alert severity="warning">
                <AlertTitle>Too many photos for one batch</AlertTitle>
                You selected {plural(photoCount, 'photo', 'photos')}; the limit is{' '}
                {maxBatchSize} per batch. Deselect {photoCount - maxBatchSize}, or ask
                an admin to raise the limit.
              </Alert>
            )}

            <Typography variant="body2" color="text.secondary">
              One setting applies to every photo in this batch. Each result is a
              preview you review before anything is saved.
            </Typography>

            {/* Preset picker */}
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }} id="batch-enhance-preset-label">
                What are we fixing?
              </Typography>
              <Box
                role="group"
                aria-labelledby="batch-enhance-preset-label"
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                  gap: 1,
                }}
              >
                {PRESETS.map((def) => (
                  <PresetCard
                    key={def.key}
                    def={def}
                    selected={presetKey === def.key}
                    onSelect={() => selectPreset(def.key)}
                  />
                ))}
              </Box>
            </Box>

            {presetKey === 'colorize_bw' && (
              <Alert severity="warning" variant="outlined">
                Colorizing is interpretive: the colors are the AI&apos;s best guess,
                not the real colors of the scene. Applied across a batch, every
                photo gets an invented palette.
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

                <FormControl size="small" fullWidth>
                  <InputLabel>Output quality</InputLabel>
                  <Select
                    label="Output quality"
                    value={quality}
                    onChange={(e) => setQuality(e.target.value as EnhanceQuality | '')}
                  >
                    <MenuItem value="">Default (set by administrator)</MenuItem>
                    <MenuItem value="low">Low — fastest, cheapest</MenuItem>
                    <MenuItem value="medium">Medium</MenuItem>
                    <MenuItem value="high">High — slowest, best detail</MenuItem>
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

            <Divider />

            {/* Cost confirmation — the count is named, not implied. */}
            <Alert severity="info" icon={<AutoFixHighIcon fontSize="inherit" />}>
              This will start {plural(photoCount, 'AI enhancement', 'AI enhancements')}.
              Each one uses AI credits and cannot be undone once started. You&apos;ll
              review and approve each result before anything changes.
            </Alert>
          </Stack>
        )}
      </DialogContent>

      <DialogActions>
        {showResult ? (
          <Button variant="contained" onClick={finishAfterResult} sx={{ minHeight: 44 }}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={submitting} sx={{ minHeight: 44 }}>
              Cancel
            </Button>
            <Button
              variant="contained"
              onClick={() => void handleSubmit()}
              disabled={submitting || overCap || photoCount === 0}
              startIcon={
                submitting ? <CircularProgress size={16} /> : <AutoFixHighIcon />
              }
              sx={{ minHeight: 44 }}
            >
              Enhance {plural(photoCount, 'photo', 'photos')}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
