import {
  AppBar,
  Toolbar,
  Typography,
  Box,
  IconButton,
  Button,
} from '@mui/material';
import { Menu as MenuIcon, PhotoLibrary as LogoIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks';
import { UserMenu } from './UserMenu';

interface TopBarProps {
  /** Handler for menu button click */
  onMenuClick: () => void;
  /** Drawer width for positioning */
  drawerWidth: number;
}

/**
 * Top app bar with logo and user menu
 */
export function TopBar({ onMenuClick, drawerWidth }: TopBarProps) {
  const { isAuthenticated, user } = useAuth();
  const navigate = useNavigate();

  return (
    <AppBar
      position="fixed"
      sx={{
        width: { sm: `calc(100% - ${drawerWidth}px)` },
        ml: { sm: `${drawerWidth}px` },
        bgcolor: 'background.paper',
        color: 'text.primary',
        borderBottom: 1,
        borderColor: 'divider',
      }}
    >
      <Toolbar>
        {/* Menu button (mobile only) */}
        <IconButton
          color="inherit"
          aria-label="open drawer"
          edge="start"
          onClick={onMenuClick}
          sx={{ mr: 2, display: { sm: 'none' } }}
        >
          <MenuIcon />
        </IconButton>

        {/* Logo and title */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <LogoIcon color="primary" />
          <Typography
            variant="h6"
            noWrap
            component="div"
            sx={{
              fontWeight: 600,
              cursor: 'pointer',
            }}
            onClick={() => navigate('/')}
          >
            MemoriaHub
          </Typography>
        </Box>

        {/* Spacer */}
        <Box sx={{ flexGrow: 1 }} />

        {/* User menu or login button */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {isAuthenticated && user ? (
            <UserMenu user={user} />
          ) : (
            <Button
              variant="outlined"
              color="primary"
              onClick={() => navigate('/login')}
            >
              Sign In
            </Button>
          )}
        </Box>
      </Toolbar>
    </AppBar>
  );
}
