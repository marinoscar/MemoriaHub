import { Box, useTheme } from '@mui/material';
import { Outlet } from 'react-router-dom';
import { useState, useCallback } from 'react';
import { AppBar } from '../navigation/AppBar';
import { Sidebar } from '../navigation/Sidebar';
import { BottomNav } from '../navigation/BottomNav';
import { MediaRefreshProvider } from '../../contexts/MediaRefreshContext';
import { MediaPreviewProvider } from '../../contexts/MediaPreviewContext';
import { SearchProvider } from '../../contexts/SearchContext';

interface LayoutProps {
  /**
   * When true, `<main>` drops its padding and becomes a flex container so a
   * child (e.g. the Map page) can own the full available area edge-to-edge.
   */
  fullBleed?: boolean;
}

export function Layout({ fullBleed = false }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const theme = useTheme();

  const handleSidebarToggle = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const handleSidebarClose = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  return (
    <MediaRefreshProvider>
      <MediaPreviewProvider>
      <SearchProvider>
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            minHeight: '100vh',
            backgroundColor: theme.palette.background.default,
          }}
        >
          <AppBar onMenuClick={handleSidebarToggle} />
          <Box sx={{ display: 'flex', flexGrow: 1 }}>
            <Sidebar open={sidebarOpen} onClose={handleSidebarClose} />
            <Box
              component="main"
              sx={
                fullBleed
                  ? {
                      flexGrow: 1,
                      display: 'flex',
                      minHeight: 0,
                      p: 0,
                    }
                  : {
                      flexGrow: 1,
                      p: 3,
                      pb: { xs: 10, md: 3 },
                    }
              }
            >
              <Outlet />
            </Box>
          </Box>
          <BottomNav onMore={() => setSidebarOpen(true)} />
        </Box>
      </SearchProvider>
      </MediaPreviewProvider>
    </MediaRefreshProvider>
  );
}
