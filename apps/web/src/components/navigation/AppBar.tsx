import { useState, useCallback } from 'react';
import {
  AppBar as MuiAppBar,
  Toolbar,
  Typography,
  IconButton,
  Button,
  Snackbar,
  Alert,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  Brightness4 as DarkModeIcon,
  Brightness7 as LightModeIcon,
  Menu as MenuIcon,
  CloudUpload as UploadIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useThemeContext } from '../../contexts/ThemeContext';
import { useCircle } from '../../hooks/useCircle';
import { useMediaRefresh } from '../../contexts/MediaRefreshContext';
import { UserMenu } from './UserMenu';
import { CircleSwitcher } from '../circles/CircleSwitcher';
import { TopbarSearch } from '../search/TopbarSearch';
import { MediaUploadDialog } from '../media/MediaUploadDialog';
import { APP_NAME } from '../../constants/app';

interface AppBarProps {
  onMenuClick?: () => void;
}

export function AppBar({ onMenuClick }: AppBarProps) {
  const theme = useTheme();
  const navigate = useNavigate();
  const { isDarkMode, toggleMode } = useThemeContext();
  const { activeCircle } = useCircle();
  const { triggerRefresh } = useMediaRefresh();
  const isMd = useMediaQuery(theme.breakpoints.up('md'));
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadSnackbar, setUploadSnackbar] = useState(false);

  const handleUploadSuccess = useCallback(() => {
    setUploadOpen(false);
    triggerRefresh();
    setUploadSnackbar(true);
  }, [triggerRefresh]);

  return (
    <>
      <MuiAppBar
        position="sticky"
        color="default"
        elevation={0}
        sx={{
          backgroundColor: theme.palette.background.paper,
          // Ensure the phone search overlay (position:absolute inside Toolbar)
          // renders above sibling elements.
          zIndex: theme.zIndex.appBar,
        }}
      >
        <Toolbar sx={{ gap: 1, position: 'relative' }}>
          {/* Hamburger */}
          <IconButton
            color="inherit"
            aria-label="toggle drawer"
            edge="start"
            onClick={onMenuClick}
            sx={{ flexShrink: 0 }}
          >
            <MenuIcon />
          </IconButton>

          {/* Logo — hide text on phones to save space */}
          {!isPhone && (
            <Typography
              variant="h6"
              component="div"
              sx={{
                cursor: 'pointer',
                fontWeight: 600,
                flexShrink: 0,
                whiteSpace: 'nowrap',
              }}
              onClick={() => navigate('/')}
            >
              {APP_NAME}
            </Typography>
          )}

          {/* Central search pill — takes available space */}
          <TopbarSearch />

          {/* Upload button */}
          {activeCircle && (
            isMd ? (
              <Button
                variant="outlined"
                size="small"
                startIcon={<UploadIcon />}
                onClick={() => setUploadOpen(true)}
                aria-label="Upload media"
                sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
              >
                Upload
              </Button>
            ) : (
              <IconButton
                color="inherit"
                aria-label="Upload media"
                onClick={() => setUploadOpen(true)}
                sx={{ flexShrink: 0 }}
              >
                <UploadIcon />
              </IconButton>
            )
          )}

          {/* Circle Switcher */}
          <CircleSwitcher />

          {/* Theme Toggle */}
          <IconButton
            onClick={toggleMode}
            color="inherit"
            aria-label="toggle theme"
            sx={{ flexShrink: 0 }}
          >
            {isDarkMode ? <LightModeIcon /> : <DarkModeIcon />}
          </IconButton>

          {/* User Menu */}
          <UserMenu />
        </Toolbar>
      </MuiAppBar>

      {/* Upload dialog */}
      <MediaUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSuccess={handleUploadSuccess}
        circleId={activeCircle?.id}
      />

      {/* Upload success snackbar */}
      <Snackbar
        open={uploadSnackbar}
        autoHideDuration={4000}
        onClose={() => setUploadSnackbar(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setUploadSnackbar(false)}
          severity="success"
          sx={{ width: '100%' }}
        >
          Upload complete
        </Alert>
      </Snackbar>
    </>
  );
}
