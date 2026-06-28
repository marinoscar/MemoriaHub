import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Box,
  Typography,
  IconButton,
  Snackbar,
  Stack,
  InputAdornment,
} from '@mui/material';
import {
  ContentCopy as ContentCopyIcon,
  LinkOff as LinkOffIcon,
} from '@mui/icons-material';
import type { SelectChangeEvent } from '@mui/material';
import type { MediaShare, ShareTargetType } from '../../types/sharing';
import { createShare, updateShare, revokeShare } from '../../services/shareService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExpirationOption = 'never' | '1d' | '7d' | '30d' | 'custom';

interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  target: {
    type: ShareTargetType;
    id: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeExpiresAt(option: ExpirationOption, customDate: string): string | null {
  if (option === 'never') return null;
  if (option === 'custom') {
    if (!customDate) return null;
    return new Date(customDate).toISOString();
  }
  const now = new Date();
  if (option === '1d') now.setDate(now.getDate() + 1);
  else if (option === '7d') now.setDate(now.getDate() + 7);
  else if (option === '30d') now.setDate(now.getDate() + 30);
  return now.toISOString();
}

function formatExpiration(expiresAt: string | null): string {
  if (!expiresAt) return 'Never';
  try {
    return new Date(expiresAt).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return expiresAt;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ShareDialog({ open, onClose, target }: ShareDialogProps) {
  // Share state — null means no active share yet (initial state)
  const [share, setShare] = useState<MediaShare | null>(null);

  // Expiration selection (used in both initial create and shared edit)
  const [expirationOption, setExpirationOption] = useState<ExpirationOption>('never');
  const [customDate, setCustomDate] = useState('');

  // Loading and error
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Copy snackbar
  const [copySnackbarOpen, setCopySnackbarOpen] = useState(false);

  // Reset state when dialog closes
  const handleClose = () => {
    setShare(null);
    setExpirationOption('never');
    setCustomDate('');
    setError(null);
    setLoading(false);
    onClose();
  };

  const handleExpirationChange = (e: SelectChangeEvent<ExpirationOption>) => {
    setExpirationOption(e.target.value as ExpirationOption);
    if (e.target.value !== 'custom') setCustomDate('');
  };

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleMakePublic = async () => {
    setLoading(true);
    setError(null);
    try {
      const expiresAt = computeExpiresAt(expirationOption, customDate);
      const req =
        target.type === 'media_item'
          ? { targetType: target.type, mediaItemId: target.id, expiresAt }
          : { targetType: target.type, albumId: target.id, expiresAt };
      const created = await createShare(req);
      setShare(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create share link');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyUrl = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.publicUrl);
      setCopySnackbarOpen(true);
    } catch {
      // Silently ignore clipboard errors
    }
  };

  const handleUpdateExpiration = async () => {
    if (!share) return;
    setLoading(true);
    setError(null);
    try {
      const expiresAt = computeExpiresAt(expirationOption, customDate);
      const updated = await updateShare(share.id, { expiresAt });
      setShare(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update expiration');
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async () => {
    if (!share) return;
    setLoading(true);
    setError(null);
    try {
      await revokeShare(share.id);
      // Reset to initial state — do NOT close the dialog
      setShare(null);
      setExpirationOption('never');
      setCustomDate('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke share link');
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>Share publicly</DialogTitle>

        <DialogContent>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {/* ----------------------------------------------------------------
              Initial state — no active share yet
          ---------------------------------------------------------------- */}
          {!share && (
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">
                Anyone with the link can view. No metadata is shown and downloading is disabled.
              </Typography>

              {/* Expiration selector */}
              <FormControl size="small" fullWidth>
                <InputLabel id="share-expiration-label">Expires</InputLabel>
                <Select<ExpirationOption>
                  labelId="share-expiration-label"
                  label="Expires"
                  value={expirationOption}
                  onChange={handleExpirationChange}
                  disabled={loading}
                >
                  <MenuItem value="never">Never</MenuItem>
                  <MenuItem value="1d">1 day</MenuItem>
                  <MenuItem value="7d">7 days</MenuItem>
                  <MenuItem value="30d">30 days</MenuItem>
                  <MenuItem value="custom">Custom date</MenuItem>
                </Select>
              </FormControl>

              {/* Custom date input — native datetime-local (no @mui/x-date-pickers in package.json) */}
              {expirationOption === 'custom' && (
                <TextField
                  label="Custom expiration date"
                  type="datetime-local"
                  size="small"
                  fullWidth
                  value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                  disabled={loading}
                  slotProps={{ inputLabel: { shrink: true } }}
                />
              )}
            </Stack>
          )}

          {/* ----------------------------------------------------------------
              Shared state — active share exists
          ---------------------------------------------------------------- */}
          {share && (
            <Stack spacing={2}>
              {/* Public URL with copy button */}
              <TextField
                label="Public link"
                value={share.publicUrl}
                size="small"
                fullWidth
                slotProps={{
                  input: {
                    readOnly: true,
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          onClick={() => void handleCopyUrl()}
                          edge="end"
                          aria-label="Copy link"
                          size="small"
                        >
                          <ContentCopyIcon fontSize="small" />
                        </IconButton>
                      </InputAdornment>
                    ),
                  },
                }}
              />

              {/* Current expiration */}
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Current expiration:&nbsp;
                </Typography>
                <Typography variant="caption">
                  {formatExpiration(share.expiresAt)}
                </Typography>
              </Box>

              {/* Edit expiration */}
              <FormControl size="small" fullWidth>
                <InputLabel id="share-update-expiration-label">Change expiration</InputLabel>
                <Select<ExpirationOption>
                  labelId="share-update-expiration-label"
                  label="Change expiration"
                  value={expirationOption}
                  onChange={handleExpirationChange}
                  disabled={loading}
                >
                  <MenuItem value="never">Never</MenuItem>
                  <MenuItem value="1d">1 day</MenuItem>
                  <MenuItem value="7d">7 days</MenuItem>
                  <MenuItem value="30d">30 days</MenuItem>
                  <MenuItem value="custom">Custom date</MenuItem>
                </Select>
              </FormControl>

              {expirationOption === 'custom' && (
                <TextField
                  label="Custom expiration date"
                  type="datetime-local"
                  size="small"
                  fullWidth
                  value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                  disabled={loading}
                  slotProps={{ inputLabel: { shrink: true } }}
                />
              )}

              <Button
                size="small"
                variant="outlined"
                onClick={() => void handleUpdateExpiration()}
                disabled={loading || (expirationOption === 'custom' && !customDate)}
                startIcon={loading ? <CircularProgress size={14} /> : undefined}
                sx={{ alignSelf: 'flex-start', minHeight: 36 }}
              >
                Update expiration
              </Button>
            </Stack>
          )}
        </DialogContent>

        <DialogActions>
          {!share ? (
            <>
              <Button onClick={handleClose} disabled={loading}>
                Cancel
              </Button>
              <Button
                variant="contained"
                onClick={() => void handleMakePublic()}
                disabled={loading || (expirationOption === 'custom' && !customDate)}
                startIcon={loading ? <CircularProgress size={16} /> : undefined}
              >
                {loading ? 'Creating…' : 'Make public'}
              </Button>
            </>
          ) : (
            <>
              <Button
                color="error"
                startIcon={loading ? <CircularProgress size={16} /> : <LinkOffIcon />}
                onClick={() => void handleRevoke()}
                disabled={loading}
              >
                Revoke (make private)
              </Button>
              <Button onClick={handleClose} disabled={loading}>
                Done
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>

      {/* Copied snackbar */}
      <Snackbar
        open={copySnackbarOpen}
        autoHideDuration={2000}
        onClose={() => setCopySnackbarOpen(false)}
        message="Copied!"
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </>
  );
}
