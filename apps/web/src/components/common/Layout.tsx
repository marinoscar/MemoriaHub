import { Box, useTheme } from '@mui/material';
import { Outlet } from 'react-router-dom';
import { useState, useCallback } from 'react';
import { AppBar } from '../navigation/AppBar';
import { Sidebar } from '../navigation/Sidebar';
import { BottomNav } from '../navigation/BottomNav';
import { MediaRefreshProvider } from '../../contexts/MediaRefreshContext';
import { MediaPreviewProvider } from '../../contexts/MediaPreviewContext';
import { SearchProvider } from '../../contexts/SearchContext';
import { MaintenanceBanner } from './MaintenanceBanner';

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
            // The shell is the ONLY owner of viewport height — pages must not
            // nest their own 100vh inside it (issue #237), or the document is
            // always at least 100vh + AppBar + padding tall and scrolls even
            // when the content fits. `100dvh` tracks mobile browser chrome;
            // `100vh` measures against the LARGEST viewport, so a collapsing
            // URL bar adds jitter. The plain 100vh below is the fallback for
            // browsers without dvh support (same lesson as MediaMapPage).
            minHeight: '100vh',
            '@supports (min-height: 100dvh)': { minHeight: '100dvh' },
            backgroundColor: theme.palette.background.default,
          }}
        >
          {/* Above the AppBar so it is visible on every authenticated screen
              (issue #348). Renders nothing for non-admins. */}
          <MaintenanceBanner />
          <AppBar onMenuClick={handleSidebarToggle} />
          <Box sx={{ display: 'flex', flexGrow: 1 }}>
            <Sidebar open={sidebarOpen} onClose={handleSidebarClose} />
            <Box
              component="main"
              // `minWidth: 0` in BOTH branches is load-bearing, not cosmetic
              // (issue #291). A flex item's `min-width` defaults to `auto` —
              // its min-content width — so without this, any descendant that
              // reports a large intrinsic inline size (a `content-visibility`
              // placeholder, a wide table, a long unbroken string) cannot be
              // shrunk and widens the whole app shell past the viewport.
              sx={
                fullBleed
                  ? {
                      flexGrow: 1,
                      display: 'flex',
                      minWidth: 0,
                      minHeight: 0,
                      p: 0,
                    }
                  : {
                      flexGrow: 1,
                      minWidth: 0,
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
