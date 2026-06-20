import {
  BottomNavigation,
  BottomNavigationAction,
  Paper,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  Home as HomeIcon,
  Explore as ExploreIcon,
  Map as MapIcon,
  PhotoLibrary as PhotoLibraryIcon,
  MoreHoriz as MoreHorizIcon,
} from '@mui/icons-material';
import { useNavigate, useLocation } from 'react-router-dom';

interface BottomNavProps {
  onMore: () => void;
}

export function BottomNav({ onMore }: BottomNavProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const navigate = useNavigate();
  const location = useLocation();

  if (!isMobile) return null;

  const getActiveValue = (): string | false => {
    if (location.pathname === '/') return '/';
    if (location.pathname.startsWith('/search')) return '/search';
    if (location.pathname.startsWith('/map')) return '/map';
    if (location.pathname.startsWith('/media')) return '/media';
    return false;
  };

  const handleChange = (_: React.SyntheticEvent, newValue: string) => {
    if (newValue) {
      navigate(newValue);
    }
  };

  return (
    <Paper
      elevation={3}
      sx={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: theme.zIndex.appBar,
      }}
    >
      <BottomNavigation value={getActiveValue()} onChange={handleChange} showLabels>
        <BottomNavigationAction label="Photos" icon={<HomeIcon />} value="/" />
        <BottomNavigationAction label="Explore" icon={<ExploreIcon />} value="/search" />
        <BottomNavigationAction label="Map" icon={<MapIcon />} value="/map" />
        <BottomNavigationAction label="Albums" icon={<PhotoLibraryIcon />} value="/media" />
        <BottomNavigationAction
          label="More"
          icon={<MoreHorizIcon />}
          value={false}
          onClick={(e: React.MouseEvent) => {
            e.preventDefault();
            onMore();
          }}
        />
      </BottomNavigation>
    </Paper>
  );
}
