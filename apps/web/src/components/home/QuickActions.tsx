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
  Palette as ThemeIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';

interface QuickAction {
  title: string;
  description: string;
  icon: React.ReactNode;
  path: string;
  permission?: string;
  adminOnly?: boolean;
}

const quickActions: QuickAction[] = [
  {
    title: 'User Settings',
    description: 'Manage your profile and preferences',
    icon: <PersonIcon />,
    path: '/settings',
  },
  {
    title: 'Theme',
    description: 'Customize your display preferences',
    icon: <ThemeIcon />,
    path: '/settings#theme',
  },
  {
    title: 'System Settings',
    description: 'Configure application settings',
    icon: <AdminIcon />,
    path: '/admin/settings',
    permission: 'system_settings:read',
  },
];

export function QuickActions() {
  const navigate = useNavigate();
  const { hasPermission, isAdmin } = usePermissions();

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
            <Grid size={{ xs: 12, sm: 6 }} key={action.path}>
              <Button
                fullWidth
                variant="outlined"
                onClick={() => navigate(action.path)}
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
