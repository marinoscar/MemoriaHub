import { useEffect } from 'react';
import { Box, Typography, Alert, Button, Stack } from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  Cancel as CancelIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';

/**
 * Guard that only permits deep links with known safe schemes.
 * Accepts `memoriahub:` (custom scheme for the Android app) and `https:`.
 * Rejects anything else (e.g. `javascript:`, `data:`, plain HTTP).
 */
function isSafeDeepLink(uri: string): boolean {
  if (typeof uri !== 'string') return false;
  return uri.startsWith('memoriahub:') || uri.startsWith('https:');
}

interface ActivationSuccessProps {
  success: boolean;
  message: string;
  /** Deep-link URI to return to the originating app after approval. Absent for CLI devices. */
  returnUri?: string;
}

export function ActivationSuccess({ success, message, returnUri }: ActivationSuccessProps) {
  const navigate = useNavigate();

  // Only act on the returnUri when it is a safe deep link and approval was granted
  const safeReturnUri =
    success && returnUri && isSafeDeepLink(returnUri) ? returnUri : undefined;

  // Auto-trigger the deep link ~800 ms after mount so the user sees the success
  // state for a moment before being sent back. The explicit button remains as a
  // fallback for cases where the OS intercepts or blocks the auto-redirect.
  useEffect(() => {
    if (!safeReturnUri) return;
    const timer = setTimeout(() => {
      window.location.href = safeReturnUri;
    }, 800);
    return () => clearTimeout(timer);
  }, [safeReturnUri]);

  return (
    <Box sx={{ textAlign: 'center' }}>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          mb: 3,
        }}
      >
        {success ? (
          <CheckCircleIcon
            sx={{
              fontSize: 80,
              color: 'success.main',
            }}
          />
        ) : (
          <CancelIcon
            sx={{
              fontSize: 80,
              color: 'error.main',
            }}
          />
        )}
      </Box>

      <Typography variant="h5" sx={{ fontWeight: 'bold' }} gutterBottom>
        {success ? 'Device Authorized!' : 'Device Access Denied'}
      </Typography>

      <Alert severity={success ? 'success' : 'info'} sx={{ mb: 3, textAlign: 'left' }}>
        {message}
      </Alert>

      {success && safeReturnUri && (
        <>
          <Button
            variant="contained"
            size="large"
            onClick={() => { window.location.href = safeReturnUri; }}
            sx={{ mb: 2, width: '100%' }}
          >
            Return to app
          </Button>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Returning to your app automatically. If nothing happens, tap the button above.
          </Typography>
        </>
      )}

      {success && !safeReturnUri && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          You can now close this page and return to your device.
        </Typography>
      )}

      <Stack direction="row" spacing={2} sx={{ justifyContent: 'center' }}>
        <Button variant="outlined" onClick={() => navigate('/')}>
          Go to Home
        </Button>
        {!success && (
          <Button variant="contained" onClick={() => window.location.reload()}>
            Try Another Code
          </Button>
        )}
      </Stack>
    </Box>
  );
}
