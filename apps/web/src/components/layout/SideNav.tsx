import {
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Box,
  Divider,
  useTheme,
  useMediaQuery,
} from '@mui/material';
import {
  PhotoLibrary as LibraryIcon,
  Collections as AllMediaIcon,
  Search as SearchIcon,
  People as PeopleIcon,
  Label as TagIcon,
  Settings as SettingsIcon,
  AdminPanelSettings as AdminIcon,
} from '@mui/icons-material';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks';

interface SideNavProps {
  /** Drawer width */
  drawerWidth: number;
  /** Whether drawer is open (mobile) */
  mobileOpen: boolean;
  /** Handler to close drawer (mobile) */
  onClose: () => void;
}

/**
 * Navigation item configuration
 */
interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
  disabled?: boolean;
}

/**
 * Main navigation items
 */
const mainNavItems: NavItem[] = [
  { label: 'All Media', path: '/media', icon: <AllMediaIcon /> },
  { label: 'Libraries', path: '/libraries', icon: <LibraryIcon /> },
  { label: 'Search', path: '/search', icon: <SearchIcon />, disabled: true },
  { label: 'People', path: '/people', icon: <PeopleIcon />, disabled: true },
  { label: 'Tags', path: '/tags', icon: <TagIcon />, disabled: true },
];


/**
 * Side navigation drawer
 */
export function SideNav({ drawerWidth, mobileOpen, onClose }: SideNavProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const location = useLocation();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();

  // Build bottom navigation items dynamically based on user role
  const bottomNavItems: NavItem[] = [
    { label: 'Settings', path: '/settings', icon: <SettingsIcon /> },
    ...(isAdmin ? [{ label: 'Admin', path: '/admin', icon: <AdminIcon /> }] : []),
  ];

  const handleNavigation = (path: string, disabled?: boolean) => {
    if (disabled) return;
    navigate(path);
    if (isMobile) {
      onClose();
    }
  };

  const isSelected = (path: string) => {
    if (path === '/') {
      return location.pathname === '/';
    }
    return location.pathname.startsWith(path);
  };

  const drawerContent = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Toolbar />

      {/* Main navigation */}
      <List sx={{ flexGrow: 1, px: 1 }}>
        {mainNavItems.map((item) => (
          <ListItem key={item.path} disablePadding sx={{ mb: 0.5 }}>
            <ListItemButton
              selected={isSelected(item.path)}
              disabled={item.disabled}
              onClick={() => handleNavigation(item.path, item.disabled)}
              sx={{
                borderRadius: 2,
                '&.Mui-selected': {
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  '&:hover': {
                    bgcolor: 'primary.dark',
                  },
                  '& .MuiListItemIcon-root': {
                    color: 'primary.contrastText',
                  },
                },
              }}
            >
              <ListItemIcon
                sx={{
                  minWidth: 40,
                  color: item.disabled ? 'text.disabled' : 'inherit',
                }}
              >
                {item.icon}
              </ListItemIcon>
              <ListItemText
                primary={item.label}
                primaryTypographyProps={{
                  fontSize: '0.875rem',
                  fontWeight: isSelected(item.path) ? 600 : 400,
                }}
              />
              {item.disabled && (
                <Box
                  component="span"
                  sx={{
                    fontSize: '0.625rem',
                    bgcolor: 'action.disabledBackground',
                    px: 0.75,
                    py: 0.25,
                    borderRadius: 1,
                    color: 'text.disabled',
                  }}
                >
                  Soon
                </Box>
              )}
            </ListItemButton>
          </ListItem>
        ))}
      </List>

      <Divider />

      {/* Bottom navigation */}
      <List sx={{ px: 1, pb: 2 }}>
        {bottomNavItems.map((item) => (
          <ListItem key={item.path} disablePadding sx={{ mb: 0.5 }}>
            <ListItemButton
              selected={isSelected(item.path)}
              disabled={item.disabled}
              onClick={() => handleNavigation(item.path, item.disabled)}
              sx={{ borderRadius: 2 }}
            >
              <ListItemIcon sx={{ minWidth: 40 }}>{item.icon}</ListItemIcon>
              <ListItemText
                primary={item.label}
                primaryTypographyProps={{
                  fontSize: '0.875rem',
                  fontWeight: isSelected(item.path) ? 600 : 400,
                }}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    </Box>
  );

  return (
    <Box
      component="nav"
      sx={{ width: { sm: drawerWidth }, flexShrink: { sm: 0 } }}
    >
      {/* Mobile drawer */}
      <Drawer
        variant="temporary"
        open={mobileOpen}
        onClose={onClose}
        ModalProps={{ keepMounted: true }} // Better mobile performance
        sx={{
          display: { xs: 'block', sm: 'none' },
          '& .MuiDrawer-paper': {
            boxSizing: 'border-box',
            width: drawerWidth,
          },
        }}
      >
        {drawerContent}
      </Drawer>

      {/* Desktop drawer */}
      <Drawer
        variant="permanent"
        sx={{
          display: { xs: 'none', sm: 'block' },
          '& .MuiDrawer-paper': {
            boxSizing: 'border-box',
            width: drawerWidth,
            borderRight: 1,
            borderColor: 'divider',
          },
        }}
        open
      >
        {drawerContent}
      </Drawer>
    </Box>
  );
}
