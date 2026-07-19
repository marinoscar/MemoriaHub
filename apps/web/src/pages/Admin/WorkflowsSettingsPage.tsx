import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  Link,
  CircularProgress,
  Alert,
} from '@mui/material';
import { AccountTree as AccountTreeIcon } from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';

// ---------------------------------------------------------------------------
// Media Workflow Automation — admin settings & oversight (issue #143).
//
// Sub-page of the Settings hub (Operations group). Feature/trigger toggles and
// engine limits (saved via PATCH /api/system-settings), a hard-delete danger
// card, a KPI strip, and a cross-circle oversight table are layered in across
// the Phase 5 checkpoints.
// ---------------------------------------------------------------------------

function WorkflowsSettingsContent() {
  const { settings, error } = useSystemSettings();

  if (!settings && !error) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !settings) {
    return (
      <Alert severity="error" sx={{ m: 3 }}>
        {error}
      </Alert>
    );
  }

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Link
          component={RouterLink}
          to="/admin/settings"
          underline="hover"
          variant="body2"
          sx={{ display: 'inline-block', mb: 2 }}
        >
          &larr; Back to Settings
        </Link>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <AccountTreeIcon color="primary" />
          <Typography variant="h4" component="h1">
            Workflow Automation
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Control the blast radius, throughput, and safety of automated media
          workflows across every circle.
        </Typography>
      </Box>
    </Container>
  );
}

export default function WorkflowsSettingsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <WorkflowsSettingsContent />;
}
