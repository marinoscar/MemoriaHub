import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Box, Toolbar } from '@mui/material';
import { TopBar } from './TopBar';
import { SideNav } from './SideNav';

/**
 * Drawer width constant
 */
const DRAWER_WIDTH = 240;

/**
 * Main application layout with top bar and side navigation
 */
export function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleDrawerToggle = () => {
    setMobileOpen(!mobileOpen);
  };

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      {/* Top bar */}
      <TopBar onMenuClick={handleDrawerToggle} drawerWidth={DRAWER_WIDTH} />

      {/* Side navigation */}
      <SideNav
        drawerWidth={DRAWER_WIDTH}
        mobileOpen={mobileOpen}
        onClose={handleDrawerToggle}
      />

      {/* Main content area */}
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          p: 3,
          width: { sm: `calc(100% - ${DRAWER_WIDTH}px)` },
          minHeight: '100vh',
          bgcolor: 'background.default',
        }}
      >
        {/* Toolbar spacer for fixed app bar */}
        <Toolbar />

        {/* Page content (from nested routes) */}
        <Outlet />
      </Box>
    </Box>
  );
}
