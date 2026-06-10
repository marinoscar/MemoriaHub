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
  Menu as MenuIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useThemeContext } from '../../contexts/ThemeContext';
import { UserMenu } from './UserMenu';

interface AppBarProps {
  onMenuClick?: () => void;
}

export function AppBar({ onMenuClick }: AppBarProps) {
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
        {/* Hamburger Menu (Always Visible) */}
        <IconButton
          color="inherit"
          aria-label="toggle drawer"
          edge="start"
          onClick={onMenuClick}
          sx={{ mr: 2 }}
        >
          <MenuIcon />
        </IconButton>

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
