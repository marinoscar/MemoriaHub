import { Box, Typography, Paper, Grid } from '@mui/material';
import {
  PhotoLibrary as LibraryIcon,
  CloudUpload as UploadIcon,
  Search as SearchIcon,
  People as PeopleIcon,
} from '@mui/icons-material';
import { useAuth } from '../hooks';

/**
 * Feature card component
 */
interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  disabled?: boolean;
}

function FeatureCard({ icon, title, description, disabled }: FeatureCardProps) {
  return (
    <Paper
      sx={{
        p: 3,
        height: '100%',
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'transform 0.2s, box-shadow 0.2s',
        '&:hover': {
          transform: disabled ? 'none' : 'translateY(-4px)',
          boxShadow: disabled ? undefined : 6,
        },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
        <Box
          sx={{
            p: 1,
            borderRadius: 2,
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            mr: 2,
          }}
        >
          {icon}
        </Box>
        <Typography variant="h6">{title}</Typography>
        {disabled && (
          <Box
            component="span"
            sx={{
              ml: 'auto',
              fontSize: '0.75rem',
              bgcolor: 'action.disabledBackground',
              px: 1,
              py: 0.5,
              borderRadius: 1,
            }}
          >
            Coming Soon
          </Box>
        )}
      </Box>
      <Typography variant="body2" color="text.secondary">
        {description}
      </Typography>
    </Paper>
  );
}

/**
 * Home page / dashboard
 */
export function HomePage() {
  const { user } = useAuth();

  return (
    <Box>
      {/* Welcome section */}
      <Box sx={{ mb: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Welcome{user?.displayName ? `, ${user.displayName.split(' ')[0]}` : ''}!
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Your privacy-first platform for organizing and cherishing family memories.
        </Typography>
      </Box>

      {/* Feature cards */}
      <Grid container spacing={3}>
        <Grid item xs={12} sm={6} md={3}>
          <FeatureCard
            icon={<LibraryIcon />}
            title="Libraries"
            description="Create and organize photo libraries for different occasions, events, or family members."
            disabled
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <FeatureCard
            icon={<UploadIcon />}
            title="Upload"
            description="Upload photos via WebDAV or web interface with automatic backup and sync."
            disabled
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <FeatureCard
            icon={<SearchIcon />}
            title="Search"
            description="Find photos using AI-powered search with natural language queries."
            disabled
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <FeatureCard
            icon={<PeopleIcon />}
            title="People"
            description="Automatically detect and organize photos by the people in them."
            disabled
          />
        </Grid>
      </Grid>

      {/* Getting started section */}
      <Paper sx={{ mt: 4, p: 3 }}>
        <Typography variant="h6" gutterBottom>
          Getting Started
        </Typography>
        <Typography variant="body2" color="text.secondary" paragraph>
          MemoriaHub is currently in development. The following features are being built:
        </Typography>
        <Box component="ul" sx={{ pl: 2, color: 'text.secondary' }}>
          <li>Library creation and management</li>
          <li>WebDAV upload support for any photo management app</li>
          <li>Automatic metadata extraction and thumbnail generation</li>
          <li>AI-powered search and face recognition</li>
          <li>Sharing with family members</li>
          <li>Local sync and redundant backup</li>
        </Box>
      </Paper>
    </Box>
  );
}
