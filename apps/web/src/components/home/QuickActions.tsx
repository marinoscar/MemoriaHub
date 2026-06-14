import {
  Card,
  CardContent,
  Typography,
  Grid,
  Button,
  Box,
} from '@mui/material';
import {
  AdminPanelSettings as AdminIcon,
  Person as PersonIcon,
  CloudUpload as UploadIcon,
  PhotoLibrary as LibraryIcon,
  Map as MapIcon,
  Group as CirclesIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';

interface QuickActionsProps {
  onUploadClick: () => void;
}

interface QuickAction {
  title: string;
  description: string;
  icon: React.ReactNode;
  path?: string;
  onClick?: () => void;
  permission?: string;
  adminOnly?: boolean;
}

export function QuickActions({ onUploadClick }: QuickActionsProps) {
  const navigate = useNavigate();
  const { hasPermission, isAdmin } = usePermissions();

  const quickActions: QuickAction[] = [
    {
      title: 'Upload',
      description: 'Add new photos and videos',
      icon: <UploadIcon />,
      onClick: onUploadClick,
    },
    {
      title: 'Browse Library',
      description: 'View all your memories',
      icon: <LibraryIcon />,
      path: '/media',
    },
    {
      title: 'Open Map',
      description: 'Explore memories by location',
      icon: <MapIcon />,
      path: '/map',
    },
    {
      title: 'Manage Circles',
      description: 'Create and manage family circles',
      icon: <CirclesIcon />,
      path: '/circles',
    },
    {
      title: 'User Settings',
      description: 'Manage your profile and preferences',
      icon: <PersonIcon />,
      path: '/settings',
    },
    {
      title: 'System Settings',
      description: 'Configure application settings',
      icon: <AdminIcon />,
      path: '/admin/settings',
      permission: 'system_settings:read',
    },
  ];

  const visibleActions = quickActions.filter((action) => {
    if (action.adminOnly && !isAdmin) return false;
    if (action.permission && !hasPermission(action.permission)) return false;
    return true;
  });

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Quick Actions
        </Typography>

        <Grid container spacing={2}>
          {visibleActions.map((action) => (
            <Grid size={{ xs: 12, sm: 6 }} key={action.path ?? action.title}>
              <Button
                fullWidth
                variant="outlined"
                onClick={() => {
                  if (action.onClick) {
                    action.onClick();
                  } else if (action.path) {
                    navigate(action.path);
                  }
                }}
                sx={{
                  justifyContent: 'flex-start',
                  textAlign: 'left',
                  py: 2,
                  px: 2,
                }}
              >
                <Box sx={{ mr: 2, display: 'flex', color: 'primary.main' }}>
                  {action.icon}
                </Box>
                <Box>
                  <Typography variant="subtitle2">
                    {action.title}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {action.description}
                  </Typography>
                </Box>
              </Button>
            </Grid>
          ))}
        </Grid>
      </CardContent>
    </Card>
  );
}
