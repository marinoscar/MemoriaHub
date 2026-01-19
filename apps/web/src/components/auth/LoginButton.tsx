import { Button, type ButtonProps } from '@mui/material';
import { Google as GoogleIcon } from '@mui/icons-material';
import { authApi } from '../../services/api';

interface LoginButtonProps extends Omit<ButtonProps, 'onClick'> {
  /** OAuth provider */
  provider?: 'google' | 'microsoft' | 'github';
}

/**
 * Login button that redirects to OAuth provider
 */
export function LoginButton({ provider = 'google', ...props }: LoginButtonProps) {
  const handleClick = () => {
    const authUrl = authApi.getOAuthUrl(provider);
    window.location.href = authUrl;
  };

  const getProviderIcon = () => {
    switch (provider) {
      case 'google':
        return <GoogleIcon />;
      default:
        return <GoogleIcon />;
    }
  };

  const getProviderLabel = () => {
    switch (provider) {
      case 'google':
        return 'Sign in with Google';
      case 'microsoft':
        return 'Sign in with Microsoft';
      case 'github':
        return 'Sign in with GitHub';
      default:
        return 'Sign in';
    }
  };

  return (
    <Button
      variant="contained"
      size="large"
      startIcon={getProviderIcon()}
      onClick={handleClick}
      {...props}
    >
      {getProviderLabel()}
    </Button>
  );
}
