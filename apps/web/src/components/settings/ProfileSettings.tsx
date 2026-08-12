import {
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  Stack,
  Typography,
} from '@mui/material';
import ProfileIcon from '@mui/icons-material/AccountCircle';
import { Link as RouterLink } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useAuthedImage } from '../../hooks/useAuthedImage';

/**
 * Read-only profile summary on `/settings`.
 *
 * Editing moved wholesale to `/profile` (issue #354), which owns the display
 * name and an explicit three-way avatar source. The `useProviderImage` and
 * `customImageUrl` keys under `user_settings.profile` are deprecated no-ops and
 * are deliberately no longer rendered or written here — the avatar's source is
 * first-class user state now, not a settings blob.
 */
export function ProfileSettings() {
  const { user } = useAuth();
  const { src: avatarSrc } = useAuthedImage(user?.profileImageUrl);

  if (!user) return null;

  const initials =
    user.displayName
      ?.split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || user.email[0].toUpperCase();

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Profile
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Customize how you appear to others
        </Typography>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ alignItems: { xs: 'flex-start', sm: 'center' } }}
        >
          <Avatar
            src={avatarSrc || undefined}
            alt={user.displayName || user.email}
            sx={{ width: 64, height: 64, bgcolor: 'primary.main' }}
          >
            {initials}
          </Avatar>

          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" noWrap>
              {user.displayName || 'No name set'}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {user.email}
            </Typography>
          </Box>

          <Button
            component={RouterLink}
            to="/profile"
            variant="outlined"
            startIcon={<ProfileIcon />}
          >
            Manage profile picture
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}
