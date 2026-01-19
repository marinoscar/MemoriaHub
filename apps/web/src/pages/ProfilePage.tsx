import { Box, Typography, Paper, Avatar, Divider, Chip } from '@mui/material';
import { useAuth } from '../hooks';

/**
 * User profile page
 */
export function ProfilePage() {
  const { user } = useAuth();

  if (!user) {
    return null;
  }

  // Get initials for avatar fallback
  const getInitials = () => {
    if (user.displayName) {
      const parts = user.displayName.split(' ');
      if (parts.length >= 2) {
        return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
      }
      return parts[0][0].toUpperCase();
    }
    return user.email[0].toUpperCase();
  };

  // Get provider display name
  const getProviderName = () => {
    switch (user.oauthProvider) {
      case 'google':
        return 'Google';
      case 'microsoft':
        return 'Microsoft';
      case 'github':
        return 'GitHub';
      default:
        return user.oauthProvider;
    }
  };

  return (
    <Box>
      <Typography variant="h4" component="h1" gutterBottom>
        Profile
      </Typography>

      <Paper sx={{ p: 4, maxWidth: 600 }}>
        {/* Avatar and basic info */}
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
          <Avatar
            src={user.avatarUrl || undefined}
            alt={user.displayName || user.email}
            sx={{
              width: 80,
              height: 80,
              bgcolor: 'primary.main',
              fontSize: '1.5rem',
              mr: 3,
            }}
          >
            {getInitials()}
          </Avatar>
          <Box>
            <Typography variant="h5">
              {user.displayName || 'User'}
            </Typography>
            <Typography variant="body1" color="text.secondary">
              {user.email}
            </Typography>
            <Chip
              label={`Signed in with ${getProviderName()}`}
              size="small"
              sx={{ mt: 1 }}
            />
          </Box>
        </Box>

        <Divider sx={{ my: 3 }} />

        {/* Account details */}
        <Box>
          <Typography variant="h6" gutterBottom>
            Account Details
          </Typography>

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box>
              <Typography variant="caption" color="text.secondary">
                User ID
              </Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                {user.id}
              </Typography>
            </Box>

            <Box>
              <Typography variant="caption" color="text.secondary">
                Email
              </Typography>
              <Typography variant="body2">
                {user.email}
              </Typography>
            </Box>

            <Box>
              <Typography variant="caption" color="text.secondary">
                Display Name
              </Typography>
              <Typography variant="body2">
                {user.displayName || 'Not set'}
              </Typography>
            </Box>

            <Box>
              <Typography variant="caption" color="text.secondary">
                Account Created
              </Typography>
              <Typography variant="body2">
                {new Date(user.createdAt).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </Typography>
            </Box>
          </Box>
        </Box>
      </Paper>
    </Box>
  );
}
