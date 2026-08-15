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
import { bulkEnhance, bulkEnhanceByFilter } from '../../services/media';
import type { BulkEnhanceByFilterFilters, BulkEnhanceResult } from '../../services/media';
import type { EnhanceQuality, EnhanceStrength } from '../../services/enhance';
import { ApiError } from '../../services/api';

// ---------------------------------------------------------------------------
// Target
//
// What a batch acts on. Two kinds, and the difference that matters is not how
// they submit but what the user KNOWS: a selection is a set they enumerated
// themselves, a filter is a set the SERVER resolves and may include photos they
// have never seen. Every count string below runs through `targetPhotoCount`,
// which is deliberately `number | null` — a keyset-paginated gallery has no
// COUNT(*) to offer, and the honest answer there is "unknown until the server
// says", not a plausible-looking number taken from the loaded pages.
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

/**
 * Which surface asked, purely so the copy reads naturally ("matching your
 * current filter" vs "in this album") and the over-cap advice is actionable —
 * "narrow the filter" is useless to someone standing in an album.
 */
export type BatchEnhanceFilterScope = 'filter' | 'album';

export interface BatchEnhanceFilterTarget {
  kind: 'filter';
  circleId: string;
  scope: BatchEnhanceFilterScope;
  /**
   * The filter itself — the same object `GET /api/media` takes. `circleId` is
   * applied from the target on submit, so the two can never disagree.
   */
  filters: Omit<BulkEnhanceByFilterFilters, 'circleId'>;
  /**
   * Photos the client can already prove match, when the surface genuinely knows
   * (an album's loaded item list, an offset-mode `meta.totalItems`). `null` in
   * keyset mode — the server's over-cap 400 carries the real `matchedCount`.
   */
  photoCount: number | null;
}

export type BatchEnhanceTarget = BatchEnhanceSelectionTarget | BatchEnhanceFilterTarget;

/**
 * How many photos this target will enhance, as far as the client can tell.
 * `null` means "only the server knows" — never conflate it with 0.
 */
function targetPhotoCount(target: BatchEnhanceTarget): number | null {
  return target.kind === 'selection' ? target.photoIds.length : target.photoCount;
}

/** Scope-dependent copy. Kept together so the two scopes cannot drift apart. */
const FILTER_SCOPE_COPY: Record<
  BatchEnhanceFilterScope,
  { titleScope: string; capScope: string; narrowHint: string }
> = {
  filter: {
    titleScope: 'matching your current filter',
    capScope: 'match your filter',
    narrowHint: 'Narrow the filter, or ask an admin to raise the limit.',
  },
  album: {
    titleScope: 'in this album',
    capScope: 'are in this album',
    narrowHint: 'Select photos individually instead, or ask an admin to raise the limit.',
  },
};

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
  /**
   * Called with the one-line, SERVER-derived summary once the batch is queued,
   * plus the batch id so the host can make its toast ACTIONABLE — a link to the
   * batch's progress page is the main way a user ever reaches it (issue #423).
   */
  onSuccess: (message: string, batchId: string) => void;
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
// The two NORMAL 400s of POST /media/bulk/enhance/by-filter
//
// Neither is a failure. An over-cap match is a REFUSAL — the server never
// truncates, so nothing was queued and the user is being told the real total so
// they can act on it. An empty match is an empty match, not an empty batch.
// Rendering either as "Request failed" would be a lie about what happened.
// ---------------------------------------------------------------------------

interface OverCapRefusal {
  matchedCount: number;
  maxBatchSize: number;
}

/**
 * Read the refusal out of an `ApiError`. `details` is the ONLY place these
 * numbers can travel: the API's `HttpExceptionFilter` rebuilds every error body
 * from a fixed key allowlist, so a top-level field would never reach us.
 */
function readOverCapRefusal(err: unknown): OverCapRefusal | null {
  if (!(err instanceof ApiError)) return null;
  const details = err.details;
  if (!details || typeof details !== 'object') return null;
  const { matchedCount, maxBatchSize } = details as Record<string, unknown>;
  if (typeof matchedCount !== 'number' || typeof maxBatchSize !== 'number') return null;
  return { matchedCount, maxBatchSize };
}

/** The server's empty-match 400, told apart from a genuine failure. */
function isNoMatchError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 400 &&
    /no photos match this filter/i.test(err.message)
  );
}

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
  const isFilter = target.kind === 'filter';
  const scopeCopy = target.kind === 'filter' ? FILTER_SCOPE_COPY[target.scope] : null;

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
  /** Server-reported over-cap refusal (filter mode only). */
  const [refusal, setRefusal] = useState<OverCapRefusal | null>(null);
  /** Server-reported empty match (filter mode only). */
  const [noMatches, setNoMatches] = useState(false);

  // A reopened dialog is a fresh decision — never a stale result or error.
  useEffect(() => {
    if (open) {
      setError(null);
      setResult(null);
      setRefusal(null);
      setNoMatches(false);
      setSubmitting(false);
    }
  }, [open]);

  // The over-cap gate has two independent sources: a count the client already
  // knows (courtesy — the server would refuse anyway) and the count the server
  // reported when it refused. The server's always wins, since it is the only
  // one derived from the real match set.
  const effectiveCap = refusal?.maxBatchSize ?? maxBatchSize;
  const knownMatchCount = refusal?.matchedCount ?? photoCount;
  const overCap = knownMatchCount !== null && knownMatchCount > effectiveCap;
  /** Nothing to submit: a known-empty target, or the server said so. */
  const emptyTarget = noMatches || knownMatchCount === 0;

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

  const submitTarget = async (): Promise<BulkEnhanceResult> => {
    const params = buildEnhanceParams(formState);
    if (target.kind === 'filter') {
      // circleId comes from the target, never from `filters`, so the circle the
      // dialog was opened for and the circle the batch runs in cannot diverge.
      return bulkEnhanceByFilter({
        filters: { ...target.filters, circleId: target.circleId } as BulkEnhanceByFilterFilters,
        params,
      });
    }
    return bulkEnhance({
      circleId: target.circleId,
      ids: target.photoIds,
      params,
    });
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    setRefusal(null);
    setNoMatches(false);
    try {
      const res = await submitTarget();
      const message = buildResultMessage(res);
      if (totalSkipped(res) > 0) {
        // Keep the dialog open so the per-reason breakdown is actually read;
        // the toast only ever carries the one-line summary.
        setResult(res);
      } else {
        onSuccess(message, res.batchId);
        onClose();
      }
    } catch (err) {
      // Two of the server's 400s are normal outcomes, not failures, and each
      // gets its own presentation. Everything else renders the SERVER's message
      // (feature disabled, no model configured) inline; the dialog stays open
      // either way, so the user can act on what they were told.
      const capRefusal = readOverCapRefusal(err);
      if (capRefusal) {
        setRefusal(capRefusal);
      } else if (isNoMatchError(err)) {
        setNoMatches(true);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to queue AI enhancements');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const finishAfterResult = () => {
    if (result) onSuccess(buildResultMessage(result), result.batchId);
    onClose();
  };

  const showResult = result !== null;

  // -------------------------------------------------------------------------
  // Copy
  //
  // Filter mode says "all", names the scope, and — the line this whole dialog
  // exists for — states outright that photos off screen are included. The user
  // never enumerated this set, so nothing about its size may be left implied.
  // -------------------------------------------------------------------------

  const titleText = showResult
    ? 'AI enhancements queued'
    : scopeCopy
      ? photoCount !== null
        ? `Enhance all ${plural(photoCount, 'photo', 'photos')} ${scopeCopy.titleScope}?`
        : `Enhance all photos ${scopeCopy.titleScope}?`
      : `Enhance ${plural(photoCount ?? 0, 'photo', 'photos')} with AI`;

  const submitLabel = scopeCopy
    ? photoCount !== null
      ? `Enhance ${plural(photoCount, 'photo', 'photos')}`
      : target.kind === 'filter' && target.scope === 'album'
        ? 'Enhance all photos in this album'
        : 'Enhance all matching photos'
    : `Enhance ${plural(photoCount ?? 0, 'photo', 'photos')}`;

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
          {titleText}
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

            {target.kind === 'selection' && target.nonPhotoCount > 0 && (
              <Alert severity="info">
                {plural(target.nonPhotoCount, 'video', 'videos')} in your selection
                will be skipped. AI Enhance works on photos only.
              </Alert>
            )}

            {noMatches && (
              <Alert severity="info">
                <AlertTitle>Nothing to enhance</AlertTitle>
                {scopeCopy?.capScope === 'are in this album'
                  ? 'This album has no photos to enhance.'
                  : 'No photos match your current filter. Adjust the filter and try again.'}
              </Alert>
            )}

            {overCap && scopeCopy && knownMatchCount !== null && (
              // A REFUSAL, not a failure: the server never truncates to the cap,
              // so nothing was queued and the real total is the actionable fact.
              <Alert severity="warning">
                <AlertTitle>Too many photos for one batch</AlertTitle>
                {plural(knownMatchCount, 'photo', 'photos')} {scopeCopy.capScope}; the
                limit is {effectiveCap} per batch. {scopeCopy.narrowHint}
              </Alert>
            )}

            {overCap && !scopeCopy && knownMatchCount !== null && (
              <Alert severity="warning">
                <AlertTitle>Too many photos for one batch</AlertTitle>
                You selected {plural(knownMatchCount, 'photo', 'photos')}; the limit is{' '}
                {effectiveCap} per batch. Deselect {knownMatchCount - effectiveCap}, or ask
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
              {isFilter ? (
                <>
                  {photoCount !== null
                    ? `This starts ${plural(photoCount, 'AI enhancement', 'AI enhancements')}.`
                    : 'This starts one AI enhancement per matching photo.'}{' '}
                  Each uses AI credits and cannot be undone once started.{' '}
                  {/* The sentence this dialog exists for. A filtered batch reaches
                      photos the user has never laid eyes on; saying so is the only
                      thing that makes the confirmation informed. */}
                  <strong>Photos you cannot currently see on screen are included.</strong>
                </>
              ) : (
                <>
                  This will start {plural(photoCount ?? 0, 'AI enhancement', 'AI enhancements')}.
                  Each one uses AI credits and cannot be undone once started. You&apos;ll
                  review and approve each result before anything changes.
                </>
              )}
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
              disabled={submitting || overCap || emptyTarget}
              startIcon={
                submitting ? <CircularProgress size={16} /> : <AutoFixHighIcon />
              }
              sx={{ minHeight: 44 }}
            >
              {submitLabel}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
