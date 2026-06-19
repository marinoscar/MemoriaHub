import { Box, useTheme } from '@mui/material';
import { Outlet } from 'react-router-dom';
import { useState, useCallback } from 'react';
import { AppBar } from '../navigation/AppBar';
import { Sidebar, DRAWER_WIDTH } from '../navigation/Sidebar';
import { BottomNav } from '../navigation/BottomNav';

export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const theme = useTheme();

  const handleSidebarToggle = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const handleSidebarClose = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  return (
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
          sx={{
            flexGrow: 1,
            p: 3,
            pb: { xs: 10, md: 3 },
            ml: { md: `${DRAWER_WIDTH}px` },
          }}
        >
          <Outlet />
        </Box>
      </Box>
      <BottomNav onMore={() => setSidebarOpen(true)} />
    </Box>
  );
}
