# Spec 16: Web Home Page

**Domain:** Frontend
**Agent:** `frontend-dev`
**Depends On:** 14-web-auth-context
**Estimated Complexity:** Low

---

## Objective

Create the home page with a user card displaying profile information and navigation to key application areas.

---

## Deliverables

### 1. File Structure

```
apps/web/src/
├── pages/
│   └── HomePage.tsx
├── components/
│   ├── navigation/
│   │   ├── AppBar.tsx
│   │   └── UserMenu.tsx
│   └── user/
│       └── UserProfileCard.tsx
```

### 2. Home Page

Create `apps/web/src/pages/HomePage.tsx`:

```tsx
import { Box, Container, Typography, Grid } from '@mui/material';
import { UserProfileCard } from '../components/user/UserProfileCard';
import { QuickActions } from '../components/home/QuickActions';
import { useAuth } from '../contexts/AuthContext';

export default function HomePage() {
  const { user } = useAuth();

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        {/* Welcome Header */}
        <Typography variant="h4" component="h1" gutterBottom>
          Welcome back{user?.displayName ? `, ${user.displayName}` : ''}
        </Typography>
        <Typography color="text.secondary" paragraph>
          Your dashboard overview
        </Typography>

        <Grid container spacing={3}>
          {/* User Profile Card */}
          <Grid item xs={12} md={4}>
            <UserProfileCard />
          </Grid>

          {/* Quick Actions */}
          <Grid item xs={12} md={8}>
            <QuickActions />
          </Grid>
        </Grid>
      </Box>
    </Container>
  );
}
```

### 3. User Profile Card

Create `apps/web/src/components/user/UserProfileCard.tsx`:

```tsx
import {
  Card,
  CardContent,
  Avatar,
  Typography,
  Box,
  Chip,
  Stack,
  Button,
  Divider,
} from '@mui/material';
import { Settings as SettingsIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

export function UserProfileCard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;

  // Get initials for avatar fallback
  const initials = user.displayName
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || user.email[0].toUpperCase();

  return (
    <Card>
      <CardContent>
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
          }}
        >
          {/* Profile Image */}
          <Avatar
            src={user.profileImageUrl || undefined}
            alt={user.displayName || user.email}
            sx={{
              width: 80,
              height: 80,
              mb: 2,
              fontSize: '1.5rem',
              bgcolor: 'primary.main',
            }}
          >
            {initials}
          </Avatar>

          {/* Name & Email */}
          <Typography variant="h6" gutterBottom>
            {user.displayName || 'No name set'}
          </Typography>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            {user.email}
          </Typography>

          {/* Roles */}
          <Stack
            direction="row"
            spacing={1}
            flexWrap="wrap"
            justifyContent="center"
            sx={{ mt: 1, mb: 2 }}
          >
            {user.roles.map((role) => (
              <Chip
                key={role}
                label={role}
                size="small"
                color={role === 'admin' ? 'primary' : 'default'}
                variant={role === 'admin' ? 'filled' : 'outlined'}
              />
            ))}
          </Stack>

          <Divider sx={{ width: '100%', my: 2 }} />

          {/* Account Info */}
          <Box sx={{ width: '100%', textAlign: 'left' }}>
            <Typography variant="body2" color="text.secondary">
              Member since
            </Typography>
            <Typography variant="body1" gutterBottom>
              {new Date(user.createdAt).toLocaleDateString()}
            </Typography>
          </Box>

          {/* Settings Button */}
          <Button
            fullWidth
            variant="outlined"
            startIcon={<SettingsIcon />}
            onClick={() => navigate('/settings')}
            sx={{ mt: 2 }}
          >
            Account Settings
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}
```

### 4. Quick Actions Component

Create `apps/web/src/components/home/QuickActions.tsx`:

```tsx
import {
  Card,
  CardContent,
  Typography,
  Grid,
  Button,
  Box,
} from '@mui/material';
import {
  Settings as SettingsIcon,
  AdminPanelSettings as AdminIcon,
  Person as PersonIcon,
  Palette as ThemeIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';

interface QuickAction {
  title: string;
  description: string;
  icon: React.ReactNode;
  path: string;
  permission?: string;
  adminOnly?: boolean;
}

const quickActions: QuickAction[] = [
  {
    title: 'User Settings',
    description: 'Manage your profile and preferences',
    icon: <PersonIcon />,
    path: '/settings',
  },
  {
    title: 'Theme',
    description: 'Customize your display preferences',
    icon: <ThemeIcon />,
    path: '/settings#theme',
  },
  {
    title: 'System Settings',
    description: 'Configure application settings',
    icon: <AdminIcon />,
    path: '/admin/settings',
    permission: 'system_settings:read',
  },
];

export function QuickActions() {
  const navigate = useNavigate();
  const { hasPermission, isAdmin } = usePermissions();

  const visibleActions = quickActions.filter((action) => {
    if (action.adminOnly && !isAdmin) return false;
    if (action.permission && !hasPermission(action.permission)) return false;
    return true;
  });

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Quick Actions
        </Typography>

        <Grid container spacing={2}>
          {visibleActions.map((action) => (
            <Grid item xs={12} sm={6} key={action.path}>
              <Button
                fullWidth
                variant="outlined"
                onClick={() => navigate(action.path)}
                sx={{
                  justifyContent: 'flex-start',
                  textAlign: 'left',
                  py: 2,
                  px: 2,
                }}
              >
                <Box sx={{ mr: 2, display: 'flex', color: 'primary.main' }}>
                  {action.icon}
                </Box>
                <Box>
                  <Typography variant="subtitle2">
                    {action.title}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {action.description}
                  </Typography>
                </Box>
              </Button>
            </Grid>
          ))}
        </Grid>
      </CardContent>
    </Card>
  );
}
```

### 5. App Bar

Create `apps/web/src/components/navigation/AppBar.tsx`:

```tsx
import {
  AppBar as MuiAppBar,
  Toolbar,
  Typography,
  Box,
  IconButton,
  useTheme,
} from '@mui/material';
import {
  Brightness4 as DarkModeIcon,
  Brightness7 as LightModeIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useThemeContext } from '../../contexts/ThemeContext';
import { UserMenu } from './UserMenu';

export function AppBar() {
  const theme = useTheme();
  const navigate = useNavigate();
  const { isDarkMode, toggleMode } = useThemeContext();

  return (
    <MuiAppBar
      position="sticky"
      color="default"
      elevation={0}
      sx={{
        backgroundColor: theme.palette.background.paper,
      }}
    >
      <Toolbar>
        {/* Logo/Title */}
        <Typography
          variant="h6"
          component="div"
          sx={{
            cursor: 'pointer',
            fontWeight: 600,
          }}
          onClick={() => navigate('/')}
        >
          Enterprise App
        </Typography>

        {/* Spacer */}
        <Box sx={{ flexGrow: 1 }} />

        {/* Theme Toggle */}
        <IconButton
          onClick={toggleMode}
          color="inherit"
          aria-label="toggle theme"
          sx={{ mr: 1 }}
        >
          {isDarkMode ? <LightModeIcon /> : <DarkModeIcon />}
        </IconButton>

        {/* User Menu */}
        <UserMenu />
      </Toolbar>
    </MuiAppBar>
  );
}
```

### 6. User Menu

Create `apps/web/src/components/navigation/UserMenu.tsx`:

```tsx
import { useState } from 'react';
import {
  IconButton,
  Avatar,
  Menu,
  MenuItem,
  Divider,
  ListItemIcon,
  ListItemText,
  Typography,
  Box,
} from '@mui/material';
import {
  Settings as SettingsIcon,
  AdminPanelSettings as AdminIcon,
  Logout as LogoutIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { usePermissions } from '../../hooks/usePermissions';

export function UserMenu() {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const { user, logout } = useAuth();
  const { hasPermission } = usePermissions();
  const navigate = useNavigate();

  const open = Boolean(anchorEl);

  const handleOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleNavigate = (path: string) => {
    navigate(path);
    handleClose();
  };

  const handleLogout = async () => {
    handleClose();
    await logout();
  };

  if (!user) return null;

  const initials = user.displayName
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || user.email[0].toUpperCase();

  return (
    <>
      <IconButton
        onClick={handleOpen}
        size="small"
        aria-controls={open ? 'user-menu' : undefined}
        aria-haspopup="true"
        aria-expanded={open ? 'true' : undefined}
      >
        <Avatar
          src={user.profileImageUrl || undefined}
          alt={user.displayName || user.email}
          sx={{ width: 32, height: 32, fontSize: '0.875rem' }}
        >
          {initials}
        </Avatar>
      </IconButton>

      <Menu
        id="user-menu"
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        onClick={handleClose}
        transformOrigin={{ horizontal: 'right', vertical: 'top' }}
        anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
        PaperProps={{
          sx: { minWidth: 200, mt: 1 },
        }}
      >
        {/* User Info Header */}
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle2" noWrap>
            {user.displayName || 'No name set'}
          </Typography>
          <Typography variant="body2" color="text.secondary" noWrap>
            {user.email}
          </Typography>
        </Box>

        <Divider />

        {/* Navigation Items */}
        <MenuItem onClick={() => handleNavigate('/settings')}>
          <ListItemIcon>
            <SettingsIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Settings</ListItemText>
        </MenuItem>

        {hasPermission('system_settings:read') && (
          <MenuItem onClick={() => handleNavigate('/admin/settings')}>
            <ListItemIcon>
              <AdminIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>System Settings</ListItemText>
          </MenuItem>
        )}

        <Divider />

        {/* Logout */}
        <MenuItem onClick={handleLogout}>
          <ListItemIcon>
            <LogoutIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Logout</ListItemText>
        </MenuItem>
      </Menu>
    </>
  );
}
```

---

## Layout

The home page uses a responsive grid layout:

| Breakpoint | Profile Card | Quick Actions |
|------------|--------------|---------------|
| Mobile (<960px) | Full width | Full width below |
| Desktop (≥960px) | 4 columns | 8 columns |

---

## User Profile Card Features

- Avatar with image or initials fallback
- Display name and email
- Role badges (admin badge highlighted)
- Member since date
- Settings navigation button

---

## Quick Actions

Actions are filtered based on permissions:
- User Settings - visible to all
- Theme - visible to all
- System Settings - requires `system_settings:read` permission

---

## Acceptance Criteria

- [ ] Home page renders at `/`
- [ ] Welcome message includes user's display name
- [ ] User profile card shows avatar/initials
- [ ] Profile card shows roles as badges
- [ ] Admin role badge is visually distinct
- [ ] Quick actions filtered by permission
- [ ] System settings only visible to admins
- [ ] App bar shows theme toggle
- [ ] User menu shows navigation options
- [ ] Logout clears session
- [ ] Responsive on mobile and desktop

---

## Notes

- Home page is placeholder for MVP - content can be expanded later
- Avatar falls back to initials if no image
- Quick actions demonstrate permission-based UI filtering
- All navigation respects user permissions
