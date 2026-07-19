import { Navigate, useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Grid,
  Typography,
} from '@mui/material';
import {
  AdminPanelSettings as AdminIcon,
  People as PeopleIcon,
  SmartToy as AiIcon,
  LocalOffer as LocalOfferIcon,
  Face as FaceIcon,
  BurstMode as BurstModeIcon,
  ContentCopy as ContentCopyIcon,
  MyLocation as MyLocationIcon,
  Map as MapIcon,
  Storage as StorageIcon,
  Insights as InsightsIcon,
  WorkHistory as WorkHistoryIcon,
  Backup as BackupIcon,
  Archive as ArchiveIcon,
  QueryStats as QueryStatsIcon,
  Public as PublicIcon,
  MonitorHeart as MonitorHeartIcon,
  Movie as MovieIcon,
  Hub as HubIcon,
  Email as EmailIcon,
  AccountTree as AccountTreeIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';

interface CardDef {
  title: string;
  description: string;
  icon: React.ReactElement;
  path?: string;
  disabled?: boolean;
  permission?: string;
  alwaysShow?: boolean;
}

interface SectionDef {
  label: string;
  cards: CardDef[];
}

export default function SettingsHubPage() {
  const navigate = useNavigate();
  const { isAdmin, hasPermission } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  const sections: SectionDef[] = [
    {
      label: 'General',
      cards: [
        {
          title: 'System',
          description: 'Configure core system settings, application behavior, and global defaults.',
          icon: <AdminIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/general',
          permission: 'system_settings:read',
        },
        {
          title: 'Users & Allowlist',
          description: 'Manage user accounts, roles, and control who can access the application.',
          icon: <PeopleIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/users',
          permission: 'users:read',
        },
        {
          title: 'Archiving & Deletion',
          description: 'Manage the Trash retention period and review how archiving and deletion work.',
          icon: <ArchiveIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/archiving',
          permission: 'system_settings:read',
        },
        {
          title: 'Email',
          description: 'Configure the outbound email provider (AWS SES or SMTP) and test delivery.',
          icon: <EmailIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/email',
          permission: 'system_settings:read',
        },
      ],
    },
    {
      label: 'AI & Enrichment',
      cards: [
        {
          title: 'AI Providers',
          description: 'Configure AI provider credentials and set the active model for search and tagging.',
          icon: <AiIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/ai',
          permission: 'ai_settings:read',
        },
        {
          title: 'Tagging & Descriptions',
          description: 'Manage the tag vocabulary and configure automatic photo tagging behavior.',
          icon: <LocalOfferIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/tagging',
          permission: 'ai_settings:read',
        },
        {
          title: 'Face Recognition',
          description: 'Set up face detection providers and configure recognition thresholds.',
          icon: <FaceIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/face',
          permission: 'face_settings:read',
        },
        {
          title: 'Bursts & Similar Pictures',
          description: 'Tune burst detection sensitivity, time windows, and review queue settings.',
          icon: <BurstModeIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/bursts',
          permission: 'system_settings:read',
        },
        {
          title: 'Near-Duplicate Detection',
          description: 'Tune visual-duplicate matching sensitivity and run global backfills.',
          icon: <ContentCopyIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/duplicates',
          permission: 'system_settings:read',
        },
        {
          title: 'Social Media Detection',
          description: 'Detect TikTok/Instagram/Facebook videos and skip enrichment',
          icon: <MovieIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/social-media',
          permission: 'system_settings:read',
        },
      ],
    },
    {
      label: 'Media',
      cards: [
        {
          title: 'Geo Location',
          description: 'Configure reverse geocoding providers and forward search settings.',
          icon: <MapIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/geo',
          permission: 'system_settings:read',
        },
        {
          title: 'Location Inference',
          description: 'Tune GPS interpolation from nearby photos, auto-apply thresholds, and run global backfills.',
          icon: <MyLocationIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/location-inference',
          permission: 'system_settings:read',
        },
      ],
    },
    {
      label: 'Storage',
      cards: [
        {
          title: 'Storage Providers',
          description:
            'Manage S3, R2, and local storage credentials, set the active provider, and run migrations.',
          icon: <StorageIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/storage/providers',
          permission: 'storage_settings:read',
        },
        {
          title: 'Storage Insights',
          description: 'View precomputed storage usage metrics and trigger manual snapshot refreshes.',
          icon: <InsightsIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/storage/insights',
          permission: 'system_settings:read',
        },
      ],
    },
    {
      label: 'Operations',
      cards: [
        {
          title: 'Job Queue',
          description: 'Monitor enrichment jobs, retry failed items, and reset stuck workers.',
          icon: <WorkHistoryIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/jobs',
          permission: 'jobs:read',
        },
        {
          title: 'Job Queue Insights',
          description: 'Live queue stats, per-type durations, and an ETA for the backlog.',
          icon: <QueryStatsIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/jobs/insights',
          permission: 'jobs:read',
        },
        {
          title: 'Worker Nodes',
          description: 'Distributed CLI worker nodes: fleet health, heartbeats, and per-node job stats.',
          icon: <HubIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/nodes',
          permission: 'jobs:read',
        },
        {
          title: 'Backup',
          description: 'Trigger backup runs, view run history, and browse backup objects.',
          icon: <BackupIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/backup',
          permission: 'backup:read',
        },
        {
          title: 'Public Sharing',
          description: 'View and manage all public share links; revoke or set expirations in bulk.',
          icon: <PublicIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/sharing',
          permission: 'shares:manage_any',
        },
        {
          title: 'Workflow Automation',
          description: 'Control workflow blast radius, throughput, and safety; oversee runs across all circles.',
          icon: <AccountTreeIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/workflows',
          permission: 'system_settings:read',
        },
        {
          title: 'Doctor',
          description: 'Run configuration health diagnostics and see required action items',
          icon: <MonitorHeartIcon sx={{ fontSize: 40 }} color="primary" />,
          path: '/admin/settings/doctor',
          permission: 'system_settings:read',
        },
      ],
    },
  ];

  return (
    <Box sx={{ p: { xs: 2, md: 4 } }}>
      <Typography variant="h4" gutterBottom sx={{ fontWeight: 700 }}>
        Settings
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Manage system configuration, providers, and operational settings.
      </Typography>

      {sections.map((section) => {
        const visibleCards = section.cards.filter((card) => {
          if (card.alwaysShow) return true;
          if (!card.permission) return true;
          return hasPermission(card.permission);
        });

        if (visibleCards.length === 0) return null;

        return (
          <Box key={section.label} sx={{ mb: 4 }}>
            <Typography
              variant="overline"
              sx={{
                display: 'block',
                mb: 1.5,
                color: 'text.secondary',
                fontWeight: 600,
                letterSpacing: '0.1em',
              }}
            >
              {section.label}
            </Typography>

            <Grid container spacing={2}>
              {visibleCards.map((card) => (
                <Grid key={card.title} size={{ xs: 12, sm: 6, md: 4 }}>
                  {card.disabled ? (
                    <Card
                      sx={{
                        height: '100%',
                        opacity: 0.6,
                        cursor: 'default',
                      }}
                      variant="outlined"
                    >
                      <CardContent>
                        {card.icon}
                        <Typography
                          variant="subtitle1"
                          sx={{ fontWeight: 600, mt: 1 }}
                        >
                          {card.title}
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                          {card.description}
                        </Typography>
                        <Chip label="Coming soon" size="small" sx={{ mt: 1 }} />
                      </CardContent>
                    </Card>
                  ) : (
                    <Card sx={{ height: '100%' }} variant="outlined">
                      <CardActionArea
                        onClick={() => card.path && navigate(card.path)}
                        sx={{ height: '100%', alignItems: 'flex-start' }}
                      >
                        <CardContent>
                          {card.icon}
                          <Typography
                            variant="subtitle1"
                            sx={{ fontWeight: 600, mt: 1 }}
                          >
                            {card.title}
                          </Typography>
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            {card.description}
                          </Typography>
                        </CardContent>
                      </CardActionArea>
                    </Card>
                  )}
                </Grid>
              ))}
            </Grid>
          </Box>
        );
      })}
    </Box>
  );
}
