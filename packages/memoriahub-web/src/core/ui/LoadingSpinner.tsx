import { Box, CircularProgress } from '@mui/material';

/**
 * The props of {@link LoadingSpinner}.
 *
 * @stability experimental
 */
export interface LoadingSpinnerProps {
  fullScreen?: boolean;
  size?: number;
}

/**
 * A centred progress ring, full-screen or inline.
 *
 * @param props - `fullScreen` fills the viewport, `size` is the ring diameter in pixels
 * @returns the spinner
 * @stability experimental
 */
export function LoadingSpinner({ fullScreen = false, size = 40 }: LoadingSpinnerProps) {
  if (fullScreen) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100vh',
          width: '100vw',
        }}
      >
        <CircularProgress size={size} />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
      <CircularProgress size={size} />
    </Box>
  );
}
