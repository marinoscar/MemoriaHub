import {
  Box,
  Typography,
  Paper,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Switch,
  Divider,
} from '@mui/material';
import {
  DarkMode as DarkModeIcon,
  Notifications as NotificationsIcon,
  Language as LanguageIcon,
  Security as SecurityIcon,
} from '@mui/icons-material';
import { useTheme } from '../hooks';

/**
 * Settings page
 */
export function SettingsPage() {
  const { isDarkMode, toggleTheme } = useTheme();

  return (
    <Box>
      <Typography variant="h4" component="h1" gutterBottom>
        Settings
      </Typography>

      {/* Appearance */}
      <Paper sx={{ mb: 3 }}>
        <Box sx={{ px: 3, py: 2 }}>
          <Typography variant="h6">Appearance</Typography>
        </Box>
        <Divider />
        <List>
          <ListItem>
            <ListItemIcon>
              <DarkModeIcon />
            </ListItemIcon>
            <ListItemText
              primary="Dark Mode"
              secondary="Use dark theme throughout the application"
            />
            <Switch
              checked={isDarkMode}
              onChange={toggleTheme}
              edge="end"
            />
          </ListItem>
        </List>
      </Paper>

      {/* Notifications (placeholder) */}
      <Paper sx={{ mb: 3 }}>
        <Box sx={{ px: 3, py: 2 }}>
          <Typography variant="h6">Notifications</Typography>
        </Box>
        <Divider />
        <List>
          <ListItem>
            <ListItemIcon>
              <NotificationsIcon />
            </ListItemIcon>
            <ListItemText
              primary="Email Notifications"
              secondary="Receive email updates about your libraries"
            />
            <Switch disabled edge="end" />
          </ListItem>
          <ListItem>
            <ListItemIcon>
              <NotificationsIcon />
            </ListItemIcon>
            <ListItemText
              primary="Push Notifications"
              secondary="Receive push notifications on your devices"
            />
            <Switch disabled edge="end" />
          </ListItem>
        </List>
      </Paper>

      {/* Language (placeholder) */}
      <Paper sx={{ mb: 3 }}>
        <Box sx={{ px: 3, py: 2 }}>
          <Typography variant="h6">Language & Region</Typography>
        </Box>
        <Divider />
        <List>
          <ListItem>
            <ListItemIcon>
              <LanguageIcon />
            </ListItemIcon>
            <ListItemText
              primary="Language"
              secondary="English (US) - More languages coming soon"
            />
          </ListItem>
        </List>
      </Paper>

      {/* Security (placeholder) */}
      <Paper>
        <Box sx={{ px: 3, py: 2 }}>
          <Typography variant="h6">Security</Typography>
        </Box>
        <Divider />
        <List>
          <ListItem>
            <ListItemIcon>
              <SecurityIcon />
            </ListItemIcon>
            <ListItemText
              primary="Two-Factor Authentication"
              secondary="Coming soon - Add an extra layer of security"
            />
            <Switch disabled edge="end" />
          </ListItem>
        </List>
      </Paper>
    </Box>
  );
}
