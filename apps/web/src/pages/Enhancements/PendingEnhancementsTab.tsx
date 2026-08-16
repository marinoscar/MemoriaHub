import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Pagination,
  Select,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlined';
import ScheduleIcon from '@mui/icons-material/Schedule';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useEnhancements } from '../../hooks/useEnhancements';
import { useFeatureFlags } from '../../hooks/useFeatureFlags';
import { getMedia } from '../../services/media';
import { applyEnhancement, discardEnhancement } from '../../services/enhance';
import type {
  EnhancementListItem,
  EnhancementSortOrder,
  EnhancementStatusFilter,
} from '../../services/enhance';
import type { MediaItem } from '../../types/media';
import { MediaEnhancementDrawer } from '../../components/media/MediaEnhancementDrawer';
import {
  ReplaceDownscaleNotice,
  describeResolutionLoss,
} from '../../components/media/ReplaceDownscaleNotice';

const PAGE_SIZE = 24;

// ---------------------------------------------------------------------------
// Expiry countdown
// ---------------------------------------------------------------------------

export type ExpirySeverity = 'info' | 'warning' | 'error';

export interface ExpiryInfo {
  label: string;
  severity: ExpirySeverity;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Under 24h left is a warning; under 6h is an error. */
const WARNING_THRESHOLD_MS = 24 * HOUR_MS;
const ERROR_THRESHOLD_MS = 6 * HOUR_MS;

/**
 * Render the countdown to a staged preview being reaped.
 *
 * Driven ENTIRELY by the server-supplied `expiresAt` — the client must never
 * derive this from its own copy of `pictureEnhancement.retentionHours`, since
 * the setting can change after a row was created and the server has already
 * resolved the real deadline.
 */
export function formatExpiresIn(
  expiresAt: string | null,
  now: number = Date.now(),
): ExpiryInfo | null {
  if (!expiresAt) return null;
  const target = new Date(expiresAt).getTime();
  if (!Number.isFinite(target)) return null;

  const remaining = target - now;
  if (remaining <= 0) return { label: 'Expired', severity: 'error' };

  const severity: ExpirySeverity =
    remaining < ERROR_THRESHOLD_MS
      ? 'error'
      : remaining < WARNING_THRESHOLD_MS
        ? 'warning'
        : 'info';

  if (remaining >= DAY_MS) {
    const days = Math.floor(remaining / DAY_MS);
    const hours = Math.floor((remaining % DAY_MS) / HOUR_MS);
    return { label: `Expires in ${days}d ${hours}h`, severity };
  }
  if (remaining >= HOUR_MS) {
    const hours = Math.floor(remaining / HOUR_MS);
    const minutes = Math.floor((remaining % HOUR_MS) / 60_000);
    return { label: `Expires in ${hours}h ${minutes}m`, severity };
  }
  const minutes = Math.max(1, Math.floor(remaining / 60_000));
  return { label: `Expires in ${minutes}m`, severity };
}

/** "3m 20s" elapsed since a job was queued. */
export function formatElapsedSince(from: string, now: number = Date.now()): string {
  const started = new Date(from).getTime();
  if (!Number.isFinite(started)) return '';
  const total = Math.max(0, Math.floor((now - started) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** Human summary of the params a run was launched with. */
export function describeParams(item: EnhancementListItem): string {
  const p = item.params ?? {};
  const bits: string[] = [];
  if (p.preset) bits.push(p.preset.replace(/_/g, ' '));
  else if (p.intent === 'custom') bits.push('custom');
  else bits.push('auto');
  if (p.strength) bits.push(p.strength);
  if (p.quality) bits.push(`${p.quality} quality`);
  return bits.join(' · ');
}

function dims(width: number | null, height: number | null): string {
  return width != null && height != null ? `${width}×${height}` : '—';
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const STATUS_FILTERS: { value: 'all' | EnhancementStatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'awaiting_decision', label: 'Awaiting decision' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'failed', label: 'Failed' },
];

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface CardProps {
  item: EnhancementListItem;
  now: number;
  allowReplace: boolean;
  blockReplaceOnDownscale: boolean;
  busy: boolean;
  onReview: (item: EnhancementListItem) => void;
  onKeepBoth: (item: EnhancementListItem) => void;
  onReplace: (item: EnhancementListItem) => void;
  onDiscard: (item: EnhancementListItem) => void;
}

function Thumb({ url, alt }: { url: string | null; alt: string }) {
  return (
    <Box
      sx={{
        width: { xs: 120, sm: 148 },
        height: { xs: 90, sm: 111 },
        flexShrink: 0,
        borderRadius: 1,
        overflow: 'hidden',
        bgcolor: 'action.hover',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {url ? (
        <Box
          component="img"
          src={url}
          alt={alt}
          loading="lazy"
          sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <Typography variant="caption" color="text.secondary">
          No preview
        </Typography>
      )}
    </Box>
  );
}

export function EnhancementCard({
  item,
  now,
  allowReplace,
  blockReplaceOnDownscale,
  busy,
  onReview,
  onKeepBoth,
  onReplace,
  onDiscard,
}: CardProps) {
  const title = item.sourceFilename ?? item.mediaItemId;
  const expiry = formatExpiresIn(item.expiresAt, now);

  // Mirrors MediaEnhancementDrawer's replace policy exactly: hidden entirely
  // when the administrator disabled replacing (a HARD policy), and gated behind
  // an explicit acknowledgement when the downscale guard applies to THIS result
  // (a CONFIRM-THROUGH guard — issue #426).
  const replaceNeedsDownscaleAck =
    allowReplace && blockReplaceOnDownscale && item.downscaled;
  const resolutionLoss = describeResolutionLoss(
    item.original.width,
    item.original.height,
    item.enhanced.width,
    item.enhanced.height,
  );

  const inProgress = item.status === 'pending' || item.status === 'processing';

  return (
    <Card variant="outlined" data-testid={`enhancement-card-${item.id}`}>
      <CardContent>
        {/*
          The row pivot is at md, not sm, on purpose: the detail column carries
          chips, model, dimensions, expiry, a multi-line downscale warning and a
          four-button action row, so between 600-900px it runs 700px+ tall
          beside the fixed 148x111 thumbnail pair, leaving a large dead area
          under the thumbnails. Staying stacked until md keeps the card tight.
        */}
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          sx={{ alignItems: { md: 'flex-start' } }}
        >
          {/* ---------- Thumbnails ---------- */}
          {item.status === 'ready' ? (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Stack spacing={0.5} sx={{ alignItems: 'center' }}>
                <Thumb url={item.original.thumbnailUrl} alt={`Original of ${title}`} />
                <Typography variant="caption" color="text.secondary">
                  Original
                </Typography>
              </Stack>
              <CompareArrowsIcon fontSize="small" color="disabled" />
              <Stack spacing={0.5} sx={{ alignItems: 'center' }}>
                {/* Prefer the real thumbnail derivative (issue #203); fall
                    back to the full-resolution staged bytes only for rows
                    staged before it existed, or whose best-effort thumbnail
                    render failed. */}
                <Thumb
                  url={item.enhanced.thumbnailUrl ?? item.enhanced.previewUrl ?? null}
                  alt={`Enhanced ${title}`}
                />
                <Typography variant="caption" color="text.secondary">
                  Enhanced
                </Typography>
              </Stack>
            </Stack>
          ) : (
            <Thumb url={item.original.thumbnailUrl} alt={`Original of ${title}`} />
          )}

          {/* ---------- Detail ---------- */}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 0.5 }}
            >
              <Typography variant="subtitle1" noWrap sx={{ maxWidth: '100%' }}>
                {title}
              </Typography>

              {item.status === 'pending' && (
                <Chip size="small" label="Queued" icon={<ScheduleIcon />} />
              )}
              {item.status === 'processing' && (
                <Chip size="small" color="info" label="Enhancing…" />
              )}
              {item.status === 'ready' && (
                <Chip size="small" color="success" label="Ready to review" />
              )}
              {item.status === 'failed' && (
                <Chip
                  size="small"
                  color="error"
                  label="Failed"
                  icon={<ErrorOutlineIcon />}
                />
              )}

              {item.status === 'ready' && item.downscaled && (
                <Tooltip title="The enhanced image is lower resolution than the original.">
                  <Chip
                    size="small"
                    color="warning"
                    variant="outlined"
                    icon={<WarningAmberIcon />}
                    label="Lower resolution"
                  />
                </Tooltip>
              )}
            </Stack>

            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {describeParams(item)}
              {item.model ? ` · ${item.model}` : ''}
            </Typography>

            {inProgress && (
              <Stack
                direction="row"
                spacing={1}
                sx={{ alignItems: 'center', mt: 1, color: 'text.secondary' }}
              >
                <CircularProgress size={16} />
                <Typography variant="caption">
                  {item.status === 'pending'
                    ? 'Waiting for a free worker'
                    : 'Enhancing your photo'}{' '}
                  · {formatElapsedSince(item.createdAt, now)}
                </Typography>
              </Stack>
            )}

            {item.status === 'ready' && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {dims(item.original.width, item.original.height)} →{' '}
                {dims(item.enhanced.width, item.enhanced.height)}
              </Typography>
            )}

            {item.status === 'failed' && (
              <Alert severity="error" variant="outlined" sx={{ mt: 1 }}>
                {item.lastError ?? 'The enhancement failed.'}
              </Alert>
            )}

            {expiry && (
              <Typography
                variant="caption"
                sx={{ display: 'block', mt: 1 }}
                color={
                  expiry.severity === 'info' ? 'text.secondary' : `${expiry.severity}.main`
                }
              >
                {expiry.label}
              </Typography>
            )}

            {/* Always rendered, never a hover-only tooltip: on a touch device
                a disabled button fires no pointer events and the reason was
                unreachable (issue #426). */}
            {item.status === 'ready' && item.downscaled && allowReplace && (
              <Box sx={{ mt: 1.5 }}>
                <ReplaceDownscaleNotice
                  dense
                  policyBlocked={replaceNeedsDownscaleAck}
                  resolutionLoss={resolutionLoss}
                />
              </Box>
            )}

            {/* ---------- Actions ---------- */}
            {item.status === 'ready' && (
              <>
                <Divider sx={{ my: 1.5 }} />
                {/*
                  useFlexGap is required whenever this row wraps: without it
                  MUI implements `spacing` as negative margins, which misbehave
                  on wrapped lines. flexShrink:0 + nowrap keep each label on one
                  line rather than letting "Replace original" break mid-phrase.
                */}
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<CompareArrowsIcon />}
                    disabled={busy}
                    onClick={() => onReview(item)}
                    sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                  >
                    Review
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={busy}
                    onClick={() => onKeepBoth(item)}
                    sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                  >
                    Keep both
                  </Button>

                  {allowReplace && (
                    <Button
                      size="small"
                      variant="outlined"
                      color="warning"
                      disabled={busy}
                      onClick={() => onReplace(item)}
                      sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                    >
                      Replace original
                    </Button>
                  )}

                  <Button
                    size="small"
                    color="inherit"
                    disabled={busy}
                    onClick={() => onDiscard(item)}
                    sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                  >
                    Discard
                  </Button>
                </Stack>
              </>
            )}

            {item.status === 'failed' && (
              <>
                <Divider sx={{ my: 1.5 }} />
                {/*
                  No "Retry" here on purpose: re-running an enhancement is a
                  fresh, BILLABLE model call, not a free requeue of existing
                  work. It belongs behind the drawer's params step (where the
                  user picks a preset and sees the credit warning) rather than
                  as a one-click button in an inbox. Out of scope for PR1.
                */}
                <Button
                  size="small"
                  color="inherit"
                  disabled={busy}
                  onClick={() => onDiscard(item)}
                >
                  Discard
                </Button>
              </>
            )}
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

interface PendingEnhancementsTabProps {
  circleId: string;
}

/**
 * The enhancements inbox: everything that has been sent through the enhancer
 * and is still queued, running, waiting on a decision, or failed.
 *
 * Multi-select and bulk actions are deliberately absent — they land in PR2.
 */
export function PendingEnhancementsTab({ circleId }: PendingEnhancementsTabProps) {
  const { pictureEnhancement } = useFeatureFlags();
  const [status, setStatus] = useState<'all' | EnhancementStatusFilter>('all');
  const [sortOrder, setSortOrder] = useState<EnhancementSortOrder>('desc');
  const [page, setPage] = useState(1);

  const [drawerItem, setDrawerItem] = useState<MediaItem | null>(null);
  const [drawerEnhancementId, setDrawerEnhancementId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Non-null while the downscale-acknowledgement dialog is open for a row. */
  const [replaceConfirm, setReplaceConfirm] = useState<EnhancementListItem | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    setPage(1);
  }, [circleId, status, sortOrder]);

  const params = useMemo(
    () => ({
      circleId,
      ...(status !== 'all' ? { status } : {}),
      page,
      pageSize: PAGE_SIZE,
      sortOrder,
    }),
    [circleId, status, page, sortOrder],
  );

  const { items, meta, isLoading, error, polling, refresh } = useEnhancements(params);

  // One shared clock so every card's countdown/elapsed label ticks together.
  // Only runs while something on the page is actually in flight or expiring.
  const [now, setNow] = useState(() => Date.now());
  const needsClock = polling || items.some((i) => i.expiresAt !== null);
  useEffect(() => {
    if (!needsClock) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [needsClock]);

  const allowReplace = pictureEnhancement?.allowReplace ?? true;
  const blockReplaceOnDownscale = pictureEnhancement?.blockReplaceOnDownscale ?? false;

  const handleReview = useCallback(async (item: EnhancementListItem) => {
    setActionError(null);
    setBusyId(item.id);
    try {
      // The drawer wants a full MediaItem (thumbnail/dimension fallbacks), and
      // a list row carries only the id, so fetch the real item rather than
      // hand-rolling a partial stub that would drift from the type.
      const media = await getMedia(item.mediaItemId);
      setDrawerItem(media);
      setDrawerEnhancementId(item.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to open the review');
    } finally {
      setBusyId(null);
    }
  }, []);

  const runAction = useCallback(
    async (item: EnhancementListItem, fn: () => Promise<unknown>, message: string) => {
      setActionError(null);
      setBusyId(item.id);
      try {
        await fn();
        setSuccessMsg(message);
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'The action failed');
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const handleKeepBoth = useCallback(
    (item: EnhancementListItem) =>
      void runAction(
        item,
        () => applyEnhancement(item.mediaItemId, item.id, 'keep_both'),
        'Enhanced copy saved as a new photo',
      ),
    [runAction],
  );

  /**
   * Replacing under the downscale guard is informed consent, so it must never
   * be a single unconfirmed tap: the click opens a dialog naming the exact
   * resolution loss, and only confirming sends `acknowledgeDownscale`
   * (issue #426). An ordinary, non-downscaled replace keeps its existing
   * one-click behavior.
   */
  const replaceNow = useCallback(
    (item: EnhancementListItem, acknowledgeDownscale: boolean) =>
      void runAction(
        item,
        () =>
          applyEnhancement(item.mediaItemId, item.id, 'replace', {
            acknowledgeDownscale,
          }),
        'Original replaced with the enhanced version',
      ),
    [runAction],
  );

  const handleReplace = useCallback(
    (item: EnhancementListItem) => {
      if (blockReplaceOnDownscale && item.downscaled) {
        setReplaceConfirm(item);
        return;
      }
      replaceNow(item, false);
    },
    [blockReplaceOnDownscale, replaceNow],
  );

  const handleDiscard = useCallback(
    (item: EnhancementListItem) =>
      void runAction(
        item,
        () => discardEnhancement(item.mediaItemId, item.id),
        'Enhancement discarded',
      ),
    [runAction],
  );

  const closeDrawer = useCallback(() => {
    setDrawerItem(null);
    setDrawerEnhancementId(null);
    void refresh();
  }, [refresh]);

  return (
    <Box>
      {/* ---------- Filters ---------- */}
      <Stack direction="row" spacing={1.5} sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <FormControl size="small" sx={{ minWidth: 180 }}>
          <InputLabel id="enhancements-status-label">Status</InputLabel>
          <Select
            labelId="enhancements-status-label"
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as 'all' | EnhancementStatusFilter)}
          >
            {STATUS_FILTERS.map((f) => (
              <MenuItem key={f.value} value={f.value}>
                {f.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="enhancements-sort-label">Sort</InputLabel>
          <Select
            labelId="enhancements-sort-label"
            label="Sort"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as EnhancementSortOrder)}
          >
            <MenuItem value="desc">Newest first</MenuItem>
            <MenuItem value="asc">Oldest first</MenuItem>
          </Select>
        </FormControl>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}

      {isLoading && items.length === 0 ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : items.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <AutoFixHighIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
          <Typography variant="h6" gutterBottom>
            Nothing waiting for you
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 480, mx: 'auto' }}>
            AI Enhance improves a photo&apos;s exposure, color, clarity and noise.
            Start one from a photo&apos;s viewer or the gallery selection bar — the
            result waits here for you to compare and decide, and nothing is
            changed until you do.
          </Typography>
        </Box>
      ) : (
        <Stack spacing={2}>
          {items.map((item) => (
            <EnhancementCard
              key={item.id}
              item={item}
              now={now}
              allowReplace={allowReplace}
              blockReplaceOnDownscale={blockReplaceOnDownscale}
              busy={busyId === item.id}
              onReview={(i) => void handleReview(i)}
              onKeepBoth={handleKeepBoth}
              onReplace={handleReplace}
              onDiscard={handleDiscard}
            />
          ))}
        </Stack>
      )}

      {meta && meta.totalPages > 1 && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
          <Pagination
            count={meta.totalPages}
            page={meta.page}
            onChange={(_, value) => setPage(value)}
            color="primary"
          />
        </Box>
      )}

      {/* Compare drawer, opened straight onto a known enhancement. */}
      {drawerItem && drawerEnhancementId && (
        <MediaEnhancementDrawer
          item={drawerItem}
          enhancementId={drawerEnhancementId}
          open
          onClose={closeDrawer}
          modelLabel={pictureEnhancement?.model ?? null}
          replacePolicy={{ allowReplace, blockReplaceOnDownscale }}
          onReplaced={() => setSuccessMsg('Original replaced with the enhanced version')}
          onKeptBoth={(message) => setSuccessMsg(message)}
        />
      )}

      {/* Informed-consent gate for replacing under the downscale guard. */}
      <Dialog
        open={replaceConfirm !== null}
        onClose={() => setReplaceConfirm(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Replace the original at lower resolution?</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            The original file is overwritten in place with the enhanced version —
            there is no version history and{' '}
            <strong>the original cannot be recovered afterwards.</strong>
            <Box component="span" sx={{ display: 'block', mt: 1.5 }}>
              <strong>You will lose resolution:</strong>{' '}
              {replaceConfirm
                ? (describeResolutionLoss(
                    replaceConfirm.original.width,
                    replaceConfirm.original.height,
                    replaceConfirm.enhanced.width,
                    replaceConfirm.enhanced.height,
                  ) ?? 'the enhanced image is smaller than the original')
                : ''}
              . An administrator has set replacing to be blocked when the result
              is smaller; continuing records your acknowledgement.
            </Box>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReplaceConfirm(null)}>Cancel</Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() => {
              const target = replaceConfirm;
              setReplaceConfirm(null);
              if (target) replaceNow(target, true);
            }}
          >
            Replace anyway
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={successMsg !== null}
        autoHideDuration={4000}
        onClose={() => setSuccessMsg(null)}
        message={successMsg ?? ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}
