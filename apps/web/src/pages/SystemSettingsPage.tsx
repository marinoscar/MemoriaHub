import {
  Container,
  Typography,
  Box,
  Alert,
  Snackbar,
  Tabs,
  Tab,
  Paper,
} from '@mui/material';
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '../hooks/usePermissions';
import { useSystemSettings } from '../hooks/useSystemSettings';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { UISettings } from '../components/admin/UISettings';
import { StorageSettings } from '../components/admin/StorageSettings';
import { MaintenanceSettings } from '../components/admin/MaintenanceSettings';
import { resetJobHistory } from '../services/jobInsights';
import { AdminPageHeader } from '../components/admin/AdminPageHeader';
import { scrollableTabsProps } from '../components/common/tabs';

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel({ children, value, index }: TabPanelProps) {
  return (
    <div role="tabpanel" hidden={value !== index}>
      {value === index && <Box sx={{ py: 3 }}>{children}</Box>}
    </div>
  );
}

export default function SystemSettingsPage() {
  const { hasPermission } = usePermissions();
  const {
    settings,
    isLoading,
    error,
    isSaving,
    updateSettings,
  } = useSystemSettings();

  const [tabIndex, setTabIndex] = useState(0);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Check permission
  if (!hasPermission('system_settings:read')) {
    return <Navigate to="/" replace />;
  }

  const canWrite = hasPermission('system_settings:write');

  const handleSave = async (key: string, value: unknown) => {
    try {
      await updateSettings({ [key]: value });
      setSuccessMessage('Settings saved');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: { xs: 2, sm: 4 } }}>
        <AdminPageHeader
          title={<>System Settings</>}
          description={
            <>
              Configure application-wide settings
              {!canWrite && ' (read-only)'}
            </>
          }
        />

        {/* Last Updated Info */}
        {settings?.updatedBy && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Last updated by {settings.updatedBy.email} on{' '}
            {new Date(settings.updatedAt).toLocaleString()}
          </Typography>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {settings && (
          <Paper sx={{ mt: 2 }}>
            <Tabs
              {...scrollableTabsProps}
              value={tabIndex}
              onChange={(_, newValue) => setTabIndex(newValue)}
              sx={{ borderBottom: 1, borderColor: 'divider' }}
            >
              <Tab label="UI Settings" />
              <Tab label="Storage" />
              <Tab label="Maintenance" />
            </Tabs>

            <Box sx={{ p: { xs: 2, sm: 3 } }}>
              <TabPanel value={tabIndex} index={0}>
                <UISettings
                  settings={settings.ui}
                  onSave={(ui) => handleSave('ui', ui)}
                  disabled={!canWrite || isSaving}
                />
              </TabPanel>

              <TabPanel value={tabIndex} index={1}>
                <StorageSettings
                  settings={settings.storage}
                  jobsSettings={settings.jobs}
                  notificationsSettings={settings.notifications}
                  onSave={(storage) => handleSave('storage', storage)}
                  onSaveJobs={(jobs) => handleSave('jobs', jobs)}
                  onSaveNotifications={(notifications) =>
                    handleSave('notifications', notifications)
                  }
                  onResetHistory={canWrite ? () => resetJobHistory().then(() => undefined) : undefined}
                  disabled={!canWrite || isSaving}
                />
              </TabPanel>

              {/* Maintenance mode (issue #348). Not part of the system-settings
                  PUT above — it has its own endpoint pair, which is exempt from
                  the maintenance block so this toggle keeps working while the
                  rest of the API is 503ing. */}
              <TabPanel value={tabIndex} index={2}>
                <MaintenanceSettings
                  disabled={!canWrite}
                  onSaved={(active) =>
                    setSuccessMessage(
                      active
                        ? 'Maintenance mode enabled'
                        : 'Maintenance mode disabled',
                    )
                  }
                />
              </TabPanel>
            </Box>
          </Paper>
        )}

        {/* Success Snackbar */}
        <Snackbar
          open={!!successMessage}
          autoHideDuration={3000}
          onClose={() => setSuccessMessage(null)}
          message={successMessage}
        />

        {/* Error Snackbar */}
        <Snackbar
          open={!!localError}
          autoHideDuration={5000}
          onClose={() => setLocalError(null)}
        >
          <Alert severity="error" onClose={() => setLocalError(null)}>
            {localError}
          </Alert>
        </Snackbar>
      </Box>
    </Container>
  );
}
