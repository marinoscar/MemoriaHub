import { useCallback } from 'react';
import {
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Toolbar,
  Divider,
  Box,
  useTheme,
  useMediaQuery,
} from '@mui/material';
import {
  Home as HomeIcon,
  Settings as SettingsIcon,
  AdminPanelSettings as AdminIcon,
  People as PeopleIcon,
  PhotoLibrary as PhotoLibraryIcon,
  Map as MapIcon,
  GroupWork as GroupWorkIcon,
  Groups as GroupsIcon,
  Backup as BackupIcon,
  SmartToy as AiIcon,
  Face as FaceIcon,
  WorkHistory as WorkHistoryIcon,
  LocalOffer as LocalOfferIcon,
  Explore as ExploreIcon,
} from '@mui/icons-material';
import { useNavigate, useLocation } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

interface NavItemDef {
  label: string;
  icon: React.ReactElement;
  path: string;
}

const DRAWER_WIDTH = 240;

function isActive(itemPath: string, currentPath: string): boolean {
  if (itemPath === '/') return currentPath === '/';
  return currentPath.startsWith(itemPath);
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const navigate = useNavigate();
  const location = useLocation();
  const { isAdmin } = usePermissions();

  const primaryItems: NavItemDef[] = [
    { label: 'Photos', icon: <HomeIcon />, path: '/' },
    { label: 'Explore', icon: <ExploreIcon />, path: '/search' },
    { label: 'Map', icon: <MapIcon />, path: '/map' },
    { label: 'Sharing', icon: <GroupWorkIcon />, path: '/circles' },
  ];

  const libraryItems: NavItemDef[] = [
    { label: 'People', icon: <GroupsIcon />, path: '/people' },
    { label: 'Albums', icon: <PhotoLibraryIcon />, path: '/media' },
  ];

  const adminItems: NavItemDef[] = [
    { label: 'User Management', icon: <PeopleIcon />, path: '/admin/users' },
    { label: 'System Settings', icon: <AdminIcon />, path: '/admin/settings' },
    { label: 'Admin Circles', icon: <GroupWorkIcon />, path: '/admin/circles' },
    { label: 'Backup', icon: <BackupIcon />, path: '/admin/backup' },
    { label: 'AI Settings', icon: <AiIcon />, path: '/admin/ai-settings' },
    { label: 'Face Settings', icon: <FaceIcon />, path: '/admin/face-settings' },
    { label: 'Job Queue', icon: <WorkHistoryIcon />, path: '/admin/jobs' },
    { label: 'Tags', icon: <LocalOfferIcon />, path: '/admin/tags' },
  ];

  const handleNavigate = useCallback(
    (path: string) => {
      onClose();
      setTimeout(() => {
        navigate(path);
      }, 0);
    },
    [onClose, navigate],
  );

  const subheaderSx = {
    fontSize: '0.7rem',
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: theme.palette.text.disabled,
    lineHeight: '2rem',
    mt: 1,
    backgroundColor: theme.palette.background.paper,
  };

  const NavItem = ({ item }: { item: NavItemDef }) => {
    const active = isActive(item.path, location.pathname);
    return (
      <ListItem disablePadding>
        <ListItemButton
          selected={active}
          onClick={() => handleNavigate(item.path)}
          sx={{
            borderRadius: 1,
            mx: 0.5,
            '&.Mui-selected': {
              backgroundColor: theme.palette.action.selected,
              '&:hover': {
                backgroundColor: theme.palette.action.hover,
              },
            },
          }}
        >
          <ListItemIcon
            sx={{
              color: active
                ? theme.palette.primary.main
                : theme.palette.text.secondary,
              minWidth: 40,
            }}
          >
            {item.icon}
          </ListItemIcon>
          <ListItemText primary={item.label} />
        </ListItemButton>
      </ListItem>
    );
  };

  const drawerContent = (
    <>
      <Toolbar />
      <Divider />
      <Box sx={{ overflow: 'auto', flexGrow: 1, py: 1 }}>
        {/* PRIMARY section — no subheader */}
        <List dense disablePadding>
          {primaryItems.map((item) => (
            <NavItem key={item.path} item={item} />
          ))}
        </List>

        {/* LIBRARY section */}
        <List
          dense
          disablePadding
          subheader={
            <ListSubheader disableSticky sx={subheaderSx}>
              Library
            </ListSubheader>
          }
        >
          {libraryItems.map((item) => (
            <NavItem key={item.path} item={item} />
          ))}
        </List>

        {/* ADMINISTRATION section — only when isAdmin */}
        {isAdmin && (
          <List
            dense
            disablePadding
            subheader={
              <ListSubheader disableSticky sx={subheaderSx}>
                Administration
              </ListSubheader>
            }
          >
            {adminItems.map((item) => (
              <NavItem key={item.path} item={item} />
            ))}
          </List>
        )}
      </Box>

      <Divider />
      {/* User Settings pinned at bottom */}
      <List dense disablePadding sx={{ py: 0.5 }}>
        <NavItem
          item={{ label: 'User Settings', icon: <SettingsIcon />, path: '/settings' }}
        />
      </List>
    </>
  );

  if (isDesktop) {
    return (
      <Drawer
        variant="permanent"
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width: DRAWER_WIDTH,
            boxSizing: 'border-box',
            backgroundColor: theme.palette.background.paper,
            borderRight: `1px solid ${theme.palette.divider}`,
            display: 'flex',
            flexDirection: 'column',
            top: 64,
            height: 'calc(100% - 64px)',
          },
        }}
      >
        {drawerContent}
      </Drawer>
    );
  }

  return (
    <Drawer
      variant="temporary"
      open={open}
      onClose={onClose}
      sx={{
        width: DRAWER_WIDTH,
        flexShrink: 0,
        '& .MuiBackdrop-root': {
          top: { xs: 56, sm: 64 },
        },
        '& .MuiDrawer-paper': {
          width: DRAWER_WIDTH,
          boxSizing: 'border-box',
          backgroundColor: theme.palette.background.paper,
          borderRight: `1px solid ${theme.palette.divider}`,
          display: 'flex',
          flexDirection: 'column',
          top: { xs: 56, sm: 64 },
          height: { xs: 'calc(100% - 56px)', sm: 'calc(100% - 64px)' },
        },
      }}
      ModalProps={{
        keepMounted: false,
        disablePortal: true,
      }}
    >
      {drawerContent}
    </Drawer>
  );
}

export { DRAWER_WIDTH };
