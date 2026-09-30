/**
 * One broadcast: its content, its progress, and the three actions its status
 * allows. Epic #481, issue #488 (ported from the reference implementation).
 *
 * NO EDIT PATH, by design. Content is frozen at compose time to match the
 * `notifications` table's render-at-write-time contract: rows already
 * delivered carry the old text forever, so editing a half-sent broadcast would
 * produce one announcement that said two different things. Cancel and
 * recreate expresses the same intent without racing the fan-out.
 *
 * Every action is confirmed in a nested dialog using the SAME copy the table's
 * row actions use (`broadcastsTable.tsx`), and every action is disabled —
 * never hidden — when the status or the caller's permission forbids it.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  LinearProgress,
  Stack,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import type { Broadcast } from '../../services/broadcasts';
import {
  channelLabel,
  isBroadcastCancelable,
  isBroadcastDeletable,
  isBroadcastResumable,
} from '../../services/broadcasts';
import {
  STATUS_CHIP_COLOR,
  cancelDescription,
  deleteDescription,
  formatDateTime,
  formatProgress,
  progressPercent,
  resumeDescription,
  statusLabel,
  userLabel,
} from '../../pages/Admin/broadcastsTable';

type BroadcastAction = 'cancel' | 'resume' | 'delete';

export interface BroadcastDetailDialogProps {
  open: boolean;
  /** `null` while the detail read is in flight, or when it failed. */
  broadcast: Broadcast | null;
  isLoading: boolean;
  error: string | null;
  canWrite: boolean;
  isWorking: boolean;
  onClose: () => void;
  onCancel: (broadcast: Broadcast) => Promise<boolean>;
  onResume: (broadcast: Broadcast) => Promise<boolean>;
  /** Resolves `true` when deleted; the dialog then closes. */
  onDelete: (broadcast: Broadcast) => Promise<boolean>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ minWidth: 160, flexGrow: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Box sx={{ mt: 0.25 }}>{children}</Box>
    </Box>
  );
}

const ACTION_COPY: Record<
  BroadcastAction,
  { title: string; confirmLabel: string; describe: (b: Broadcast) => string }
> = {
  cancel: { title: 'Cancel this broadcast?', confirmLabel: 'Cancel broadcast', describe: cancelDescription },
  resume: { title: 'Resume this broadcast?', confirmLabel: 'Resume broadcast', describe: resumeDescription },
  delete: { title: 'Delete this broadcast?', confirmLabel: 'Delete', describe: deleteDescription },
};

export function BroadcastDetailDialog({
  open,
  broadcast,
  isLoading,
  error,
  canWrite,
  isWorking,
  onClose,
  onCancel,
  onResume,
  onDelete,
}: BroadcastDetailDialogProps) {
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));
  const [pending, setPending] = useState<BroadcastAction | null>(null);

  const isFailed = broadcast?.status === 'failed';
  const percent = broadcast ? progressPercent(broadcast) : null;

  const confirm = async () => {
    if (!broadcast || !pending) return;
    const action = pending;
    setPending(null);
    if (action === 'cancel') await onCancel(broadcast);
    if (action === 'resume') await onResume(broadcast);
    if (action === 'delete' && (await onDelete(broadcast))) onClose();
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        fullWidth
        maxWidth="md"
        fullScreen={isCompactWindow}
        aria-labelledby="broadcast-detail-title"
      >
        <DialogTitle id="broadcast-detail-title">Broadcast</DialogTitle>
        <DialogContent dividers>
          {isLoading && (
            <Stack sx={{ py: 4, alignItems: 'center' }}>
              <CircularProgress size={28} aria-label="Loading broadcast" />
            </Stack>
          )}

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {broadcast && (
            <Stack spacing={3}>
              <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
                <Field label="Status">
                  <Chip
                    label={statusLabel(broadcast.status)}
                    size="small"
                    color={STATUS_CHIP_COLOR[broadcast.status]}
                  />
                </Field>
                <Field label="Importance">
                  <Typography variant="body2">
                    {broadcast.critical ? 'Cannot be muted' : 'Normal'}
                  </Typography>
                </Field>
                <Field label="Channels">
                  <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                    {broadcast.channels.map((channel) => (
                      <Chip key={channel} label={channelLabel(channel)} size="small" variant="outlined" />
                    ))}
                  </Stack>
                </Field>
              </Stack>

              <Box>
                <Stack direction="row" sx={{ justifyContent: 'space-between', mb: 0.5 }}>
                  <Typography variant="caption" color="text.secondary">
                    Progress
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatProgress(broadcast)} recipients
                  </Typography>
                </Stack>
                <LinearProgress
                  variant={percent === null && broadcast.status === 'sending' ? 'indeterminate' : 'determinate'}
                  value={percent ?? 0}
                  color={isFailed ? 'error' : 'primary'}
                  aria-label="Broadcast progress"
                />
              </Box>

              <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
                <Field label="Scheduled for">
                  <Typography variant="body2">
                    {broadcast.scheduledFor ? formatDateTime(broadcast.scheduledFor) : 'Immediately'}
                  </Typography>
                </Field>
                <Field label="Started">
                  <Typography variant="body2">{formatDateTime(broadcast.startedAt)}</Typography>
                </Field>
                <Field label={isFailed ? 'Stopped' : 'Finished'}>
                  <Typography variant="body2">{formatDateTime(broadcast.finishedAt)}</Typography>
                </Field>
                <Field label="Canceled">
                  <Typography variant="body2">{formatDateTime(broadcast.canceledAt)}</Typography>
                </Field>
                <Field label="Audience frozen at">
                  <Typography variant="body2">{formatDateTime(broadcast.audienceCutoff)}</Typography>
                </Field>
                <Field label="Created by">
                  <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                    {userLabel(broadcast.createdBy)}
                  </Typography>
                </Field>
                {broadcast.canceledBy && (
                  <Field label="Canceled by">
                    <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                      {userLabel(broadcast.canceledBy)}
                    </Typography>
                  </Field>
                )}
              </Stack>

              <Divider />

              {/* Plain text, never markup: every channel escapes the body. */}
              <Box>
                <Typography variant="overline" color="text.secondary">
                  Content
                </Typography>
                <Typography variant="h6" component="p" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
                  {broadcast.title}
                </Typography>
                {broadcast.body.split(/\n{2,}/).map((paragraph, index) => (
                  <Typography
                    key={index}
                    variant="body2"
                    sx={{ mt: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                  >
                    {paragraph}
                  </Typography>
                ))}
                {broadcast.link && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 2, overflowWrap: 'anywhere' }}>
                    Call to action: {broadcast.ctaLabel ?? 'View'} → {broadcast.link}
                  </Typography>
                )}
              </Box>

              {isFailed && (
                <Alert severity="error" data-testid="broadcast-failed-summary">
                  Stopped after {broadcast.processedCount} of {broadcast.recipientCount ?? '—'}{' '}
                  recipients. Resume continues from where it stopped; Cancel leaves it stopped.
                </Alert>
              )}

              {broadcast.lastError && (
                <Alert severity="error">
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {broadcast.lastError}
                  </Typography>
                </Alert>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
          {broadcast && (
            <>
              <Button
                onClick={() => setPending('resume')}
                disabled={!canWrite || isWorking || !isBroadcastResumable(broadcast)}
              >
                Resume
              </Button>
              <Button
                onClick={() => setPending('cancel')}
                disabled={!canWrite || isWorking || !isBroadcastCancelable(broadcast)}
              >
                Cancel broadcast
              </Button>
              <Button
                color="error"
                onClick={() => setPending('delete')}
                disabled={!canWrite || isWorking || !isBroadcastDeletable(broadcast)}
              >
                Delete
              </Button>
            </>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={pending !== null && broadcast !== null} onClose={() => setPending(null)}>
        {pending && broadcast && (
          <>
            <DialogTitle>{ACTION_COPY[pending].title}</DialogTitle>
            <DialogContent>
              <DialogContentText>{ACTION_COPY[pending].describe(broadcast)}</DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setPending(null)}>Back</Button>
              <Button
                variant="contained"
                color={pending === 'delete' ? 'error' : 'primary'}
                onClick={() => void confirm()}
              >
                {ACTION_COPY[pending].confirmLabel}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </>
  );
}

export default BroadcastDetailDialog;
