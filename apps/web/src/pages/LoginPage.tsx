import { Box, Typography, Paper, Divider } from '@mui/material';
import { PhotoLibrary as LogoIcon } from '@mui/icons-material';
import { LoginButton } from '../components/auth';

/**
 * Login page with OAuth options
 */
export function LoginPage() {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        p: 3,
        bgcolor: 'background.default',
      }}
    >
      <Paper
        elevation={3}
        sx={{
          p: 4,
          maxWidth: 400,
          width: '100%',
          textAlign: 'center',
        }}
      >
        {/* Logo and title */}
        <Box sx={{ mb: 3 }}>
          <LogoIcon sx={{ fontSize: 56, color: 'primary.main', mb: 1 }} />
          <Typography variant="h4" component="h1" fontWeight="bold">
            MemoriaHub
          </Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
            Privacy-first family photo platform
          </Typography>
        </Box>

        <Divider sx={{ my: 3 }} />

        {/* Sign in options */}
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Sign in to continue
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <LoginButton provider="google" fullWidth />
          {/* Future providers can be added here */}
          {/* <LoginButton provider="microsoft" fullWidth disabled /> */}
          {/* <LoginButton provider="github" fullWidth disabled /> */}
        </Box>

        <Divider sx={{ my: 3 }} />

        {/* Footer */}
        <Typography variant="caption" color="text.secondary">
          By signing in, you agree to our Terms of Service and Privacy Policy.
        </Typography>
      </Paper>
    </Box>
  );
}
