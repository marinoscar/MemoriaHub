import { Box, CircularProgress, type CircularProgressProps } from '@mui/material';

interface LoadingSpinnerProps extends CircularProgressProps {
  /** Whether to center in full viewport */
  fullScreen?: boolean;
}

/**
 * Loading spinner component
 */
export function LoadingSpinner({ fullScreen = false, ...props }: LoadingSpinnerProps) {
  if (fullScreen) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          width: '100%',
        }}
      >
        <CircularProgress {...props} />
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        p: 4,
      }}
    >
      <CircularProgress {...props} />
    </Box>
  );
}
