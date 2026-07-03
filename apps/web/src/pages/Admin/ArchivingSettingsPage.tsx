import { useEffect, useState } from 'react';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  Paper,
  TextField,
  Button,
  Stack,
  Alert,
  Snackbar,
  Link,
} from '@mui/material';
import { Archive as ArchiveIcon } from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';

const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;

function ArchivingSettingsContent() {
  const { hasPermission } = usePermissions();
  const { settings, isLoading, isSaving, error, updateSettings } = useSystemSettings();

  const canWrite = hasPermission('system_settings:write');

  const [retentionDays, setRetentionDays] = useState<number>(
    settings?.storage?.trash?.retentionDays ?? DEFAULT_RETENTION_DAYS,
  );
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setRetentionDays(settings?.storage?.trash?.retentionDays ?? DEFAULT_RETENTION_DAYS);
  }, [settings]);

  const hasChanges =
    retentionDays !== (settings?.storage?.trash?.retentionDays ?? DEFAULT_RETENTION_DAYS);

  const handleRetentionChange = (raw: string) => {
    const val = parseInt(raw, 10);
    setRetentionDays(isNaN(val) ? 0 : val);
    if (isNaN(val) || val < MIN_RETENTION_DAYS || val > MAX_RETENTION_DAYS) {
      setRetentionError(`Must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`);
    } else {
      setRetentionError(null);
    }
  };

  const handleSave = async () => {
    if (retentionError || !hasChanges) return;
    try {
      await updateSettings({ storage: { trash: { retentionDays } } });
      setSuccessMessage('Trash retention period saved');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to save settings');
    }
  };

  if (isLoading) {
    return <LoadingSpinner />;
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
          <ArchiveIcon color="primary" />
          <Typography variant="h4" component="h1">
            Archiving &amp; Deletion
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Archive hides items from browse surfaces (Home, Albums, People, Explore, Map) without
          deleting them; search still finds archived items by default. Trash is a recoverable
          deletion state — items are purged permanently after the retention period below.
          Archiving and moving items to Trash are performed manually or in bulk from the media
          views, not from this page.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Trash Retention
          </Typography>

          <TextField
            label="Trash retention period (days)"
            type="number"
            value={retentionDays}
            onChange={(e) => handleRetentionChange(e.target.value)}
            disabled={!canWrite || isSaving}
            error={!!retentionError}
            helperText={
              retentionError ??
              `How long deleted items are kept in Trash before permanent deletion. Default: ${DEFAULT_RETENTION_DAYS} days.`
            }
            slotProps={{ htmlInput: { min: MIN_RETENTION_DAYS, max: MAX_RETENTION_DAYS, step: 1 } }}
            sx={{ width: 320 }}
          />

          <Box sx={{ mt: 3 }}>
            <Button
              variant="contained"
              onClick={() => void handleSave()}
              disabled={!canWrite || !hasChanges || isSaving || !!retentionError}
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </Box>
        </Paper>

        <Paper variant="outlined" sx={{ p: 3 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Review Archive &amp; Trash
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <Button variant="outlined" component={RouterLink} to="/archive">
              View Archive
            </Button>
            <Button variant="outlined" component={RouterLink} to="/trash">
              View Trash
            </Button>
          </Stack>
        </Paper>

        {/* Success Snackbar */}
        <Snackbar
          open={!!successMessage}
          autoHideDuration={3000}
          onClose={() => setSuccessMessage(null)}
          message={successMessage}
        />

        {/* Error Snackbar */}
        <Snackbar open={!!localError} autoHideDuration={5000} onClose={() => setLocalError(null)}>
          <Alert severity="error" onClose={() => setLocalError(null)}>
            {localError}
          </Alert>
        </Snackbar>
      </Box>
    </Container>
  );
}

export default function ArchivingSettingsPage() {
  const { hasPermission } = usePermissions();

  if (!hasPermission('system_settings:read')) {
    return <Navigate to="/" replace />;
  }

  return <ArchivingSettingsContent />;
}
