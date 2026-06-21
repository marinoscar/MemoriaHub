import { useCallback, useEffect, useState } from 'react';
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
  IconButton,
  Tooltip,
  Typography,
  CircularProgress,
} from '@mui/material';
import {
  Home as HomeIcon,
  Settings as SettingsIcon,
  AdminPanelSettings as AdminIcon,
  People as PeopleIcon,
  Map as MapIcon,
  GroupWork as GroupWorkIcon,
  Groups as GroupsIcon,
  Backup as BackupIcon,
  SmartToy as AiIcon,
  Face as FaceIcon,
  WorkHistory as WorkHistoryIcon,
  LocalOffer as LocalOfferIcon,
  Explore as ExploreIcon,
  Add as AddIcon,
  PhotoAlbum as AlbumIcon,
  Insights as InsightsIcon,
  BurstMode as BurstModeIcon,
} from '@mui/icons-material';
import { useNavigate, useLocation } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useAlbums } from '../../hooks/useAlbums';
import { useCircle } from '../../hooks/useCircle';
import { CreateAlbumDialog } from '../album/CreateAlbumDialog';

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
  const { activeCircle, activeCircleId, activeCircleRole } = useCircle();
  const { albums, isLoading: albumsLoading, fetchAlbums } = useAlbums();
  const [createAlbumOpen, setCreateAlbumOpen] = useState(false);

  // Load albums whenever active circle changes
  useEffect(() => {
    if (!activeCircleId) return;
    void fetchAlbums({ circleId: activeCircleId, pageSize: 100, sortBy: 'name', sortOrder: 'asc' });
  }, [activeCircleId, fetchAlbums]);

  const isViewer = activeCircleRole === 'viewer';

  const primaryItems: NavItemDef[] = [
    { label: 'Photos', icon: <HomeIcon />, path: '/' },
    { label: 'Explore', icon: <ExploreIcon />, path: '/search' },
    { label: 'Map', icon: <MapIcon />, path: '/map' },
    { label: 'Sharing', icon: <GroupWorkIcon />, path: '/circles' },
  ];

  const libraryItems: NavItemDef[] = [
    { label: 'People', icon: <GroupsIcon />, path: '/people' },
    { label: 'Review Bursts', icon: <BurstModeIcon />, path: '/bursts' },
  ];

  const adminItems: NavItemDef[] = [
    { label: 'User Management', icon: <PeopleIcon />, path: '/admin/users' },
    { label: 'System Settings', icon: <AdminIcon />, path: '/admin/settings' },
    { label: 'Backup', icon: <BackupIcon />, path: '/admin/backup' },
    { label: 'AI Settings', icon: <AiIcon />, path: '/admin/ai-settings' },
    { label: 'Face Settings', icon: <FaceIcon />, path: '/admin/face-settings' },
    { label: 'Job Queue', icon: <WorkHistoryIcon />, path: '/admin/jobs' },
    { label: 'Tags', icon: <LocalOfferIcon />, path: '/admin/tags' },
    { label: 'Storage Insights', icon: <InsightsIcon />, path: '/admin/insights' },
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

        {/* ALBUMS section */}
        <List
          dense
          disablePadding
          subheader={
            <ListSubheader
              disableSticky
              sx={{
                ...subheaderSx,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                pr: 0.5,
              }}
            >
              <span>Albums</span>
              {!isViewer && activeCircle && (
                <Tooltip title="New album">
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCreateAlbumOpen(true);
                    }}
                    aria-label="Create new album"
                    sx={{ color: theme.palette.text.disabled, p: 0.25 }}
                  >
                    <AddIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </ListSubheader>
          }
        >
          {/* Scrollable album list */}
          <Box sx={{ maxHeight: 240, overflowY: 'auto' }}>
            {albumsLoading && (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
                <CircularProgress size={16} />
              </Box>
            )}
            {!albumsLoading && albums.length === 0 && activeCircleId && (
              <Typography
                variant="caption"
                color="text.disabled"
                sx={{ display: 'block', px: 2, py: 1 }}
              >
                No albums yet
              </Typography>
            )}
            {albums.map((album) => {
              const albumPath = `/albums/${album.id}`;
              const active = isActive(albumPath, location.pathname);
              return (
                <ListItem key={album.id} disablePadding>
                  <ListItemButton
                    selected={active}
                    onClick={() => handleNavigate(albumPath)}
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
                      <AlbumIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText
                      primary={album.name}
                      sx={{
                        my: 0,
                        '& .MuiListItemText-primary': {
                          fontSize: '0.875rem',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        },
                      }}
                    />
                  </ListItemButton>
                </ListItem>
              );
            })}
          </Box>
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

      {/* CreateAlbumDialog — renders via Portal so DOM position is fine */}
      {activeCircle && (
        <CreateAlbumDialog
          open={createAlbumOpen}
          onClose={() => setCreateAlbumOpen(false)}
          circleId={activeCircle.id}
          onCreated={(album) => {
            setCreateAlbumOpen(false);
            void fetchAlbums({ circleId: activeCircle.id, pageSize: 100, sortBy: 'name', sortOrder: 'asc' });
            handleNavigate(`/albums/${album.id}`);
          }}
        />
      )}
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
