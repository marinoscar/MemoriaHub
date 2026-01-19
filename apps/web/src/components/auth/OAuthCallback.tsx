import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Box, Typography, Alert } from '@mui/material';
import { useAuth } from '../../hooks';
import { LoadingSpinner } from '../common';

/**
 * OAuth callback handler component
 * Processes tokens from URL and logs user in
 */
export function OAuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleCallback = async () => {
      // Check for error from OAuth provider
      const errorParam = searchParams.get('error');
      if (errorParam) {
        setError(errorParam);
        return;
      }

      // Get tokens from URL
      const accessToken = searchParams.get('access_token');
      const refreshToken = searchParams.get('refresh_token');

      if (!accessToken || !refreshToken) {
        setError('Missing authentication tokens');
        return;
      }

      try {
        await login(accessToken, refreshToken);
        // Clear URL params and navigate to home
        navigate('/', { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Login failed');
      }
    };

    handleCallback();
  }, [searchParams, login, navigate]);

  if (error) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          p: 4,
        }}
      >
        <Alert severity="error" sx={{ mb: 3, maxWidth: 400 }}>
          {error}
        </Alert>
        <Typography variant="body2" color="text.secondary">
          <a href="/login" style={{ color: 'inherit' }}>
            Try again
          </a>
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
      }}
    >
      <LoadingSpinner />
      <Typography variant="body1" sx={{ mt: 2 }}>
        Signing you in...
      </Typography>
    </Box>
  );
}
