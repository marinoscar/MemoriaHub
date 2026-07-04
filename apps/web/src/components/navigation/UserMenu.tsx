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
  GroupWork as CircleIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { usePermissions } from '../../hooks/usePermissions';
import { useCircle } from '../../hooks/useCircle';

export function UserMenu() {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const { user, logout } = useAuth();
  const { hasPermission } = usePermissions();
  const { circles, activeCircle, setActiveCircle } = useCircle();
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
        slotProps={{
          paper: { sx: { minWidth: 200, mt: 1 } },
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

        {/* Circle Section */}
        <Typography
          variant="overline"
          sx={{ px: 2, pt: 1, display: 'block' }}
          color="text.secondary"
        >
          Circle
        </Typography>

        {circles.length === 0 ? (
          <MenuItem disabled>
            <ListItemText>No circles yet</ListItemText>
          </MenuItem>
        ) : (
          circles.map((c) => (
            <MenuItem
              key={c.id}
              selected={c.id === activeCircle?.id}
              onClick={() => void setActiveCircle(c.id)}
            >
              <ListItemIcon>
                <CircleIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{c.name}</ListItemText>
            </MenuItem>
          ))
        )}

        <MenuItem onClick={() => handleNavigate('/circles')}>
          <ListItemIcon>
            <CircleIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Manage Circles</ListItemText>
        </MenuItem>

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
