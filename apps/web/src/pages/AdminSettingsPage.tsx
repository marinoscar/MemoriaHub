import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  Paper,
  Tabs,
  Tab,
  List,
  ListItem,
  ListItemText,
  Switch,
  Divider,
  TextField,
  FormControl,
  Alert,
  Snackbar,
  CircularProgress,
  InputAdornment,
  IconButton,
  Select,
  MenuItem,
} from '@mui/material';
import {
  Settings as GeneralIcon,
  ToggleOn as FeatureIcon,
  Email as EmailIcon,
  Notifications as PushIcon,
  Storage as StorageIcon,
  Visibility as VisibilityIcon,
  VisibilityOff as VisibilityOffIcon,
} from '@mui/icons-material';
import { settingsApi } from '../services/api/settings.api';
import type {
  SystemSettingsCategory,
  GeneralSettings,
  FeatureSettings,
  SmtpSettings,
  PushSettings,
  StorageSettings,
} from '@memoriahub/shared';

interface TabPanelProps {
  children?: React.ReactNode;
  value: SystemSettingsCategory;
  selected: SystemSettingsCategory;
}

function TabPanel({ children, value, selected }: TabPanelProps) {
  return (
    <div hidden={value !== selected} role="tabpanel">
      {value === selected && <Box sx={{ py: 3 }}>{children}</Box>}
    </div>
  );
}

/**
 * Admin Settings Page
 *
 * System-wide configuration for administrators:
 * - General settings (site name, registration)
 * - Feature flags (AI search, face recognition, etc.)
 * - Email (SMTP) configuration
 * - Push notification settings
 * - Storage backend settings
 */
export function AdminSettingsPage() {
  const [activeTab, setActiveTab] = useState<SystemSettingsCategory>('general');
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  // Load all settings
  const loadSettings = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const allSettings = await settingsApi.getAllSystemSettings();

      // Convert array to object keyed by category
      const settingsMap: Record<string, unknown> = {};
      for (const item of allSettings) {
        settingsMap[item.category] = item.settings;
      }
      setSettings(settingsMap);
    } catch (err) {
      console.error('Failed to load system settings:', err);
      setError('Failed to load system settings. Make sure you have admin privileges.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const updateSetting = useCallback(
    async (category: SystemSettingsCategory, field: string, value: unknown) => {
      try {
        setSaving(true);
        setError(null);

        const update = { [field]: value };
        await settingsApi.updateSystemSettings(category, update);

        // Update local state
        setSettings((prev) => ({
          ...prev,
          [category]: {
            ...(prev[category] as Record<string, unknown>),
            [field]: value,
          },
        }));
        setSuccess('Setting saved');
      } catch (err) {
        console.error('Failed to save setting:', err);
        setError('Failed to save setting');
      } finally {
        setSaving(false);
      }
    },
    []
  );

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  const generalSettings = settings.general as GeneralSettings | undefined;
  const featureSettings = settings.features as FeatureSettings | undefined;
  const smtpSettings = settings.smtp as SmtpSettings | undefined;
  const pushSettings = settings.push as PushSettings | undefined;
  const storageSettings = settings.storage as StorageSettings | undefined;

  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
        System Settings
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Paper>
        <Tabs
          value={activeTab}
          onChange={(_, v: SystemSettingsCategory) => setActiveTab(v)}
          variant="scrollable"
          scrollButtons="auto"
        >
          <Tab icon={<GeneralIcon />} label="General" value="general" />
          <Tab icon={<FeatureIcon />} label="Features" value="features" />
          <Tab icon={<EmailIcon />} label="Email (SMTP)" value="smtp" />
          <Tab icon={<PushIcon />} label="Push" value="push" />
          <Tab icon={<StorageIcon />} label="Storage" value="storage" />
        </Tabs>

        <Box sx={{ px: 3 }}>
          {/* General Settings */}
          <TabPanel value="general" selected={activeTab}>
            <List>
              <ListItem>
                <ListItemText
                  primary="Site Name"
                  secondary="The name displayed in the browser title and emails"
                />
                <TextField
                  size="small"
                  value={generalSettings?.siteName || ''}
                  onChange={(e) => void updateSetting('general', 'siteName', e.target.value)}
                  disabled={saving}
                  sx={{ width: 200 }}
                />
              </ListItem>
              <Divider component="li" />

              <ListItem>
                <ListItemText
                  primary="Max Upload Size (MB)"
                  secondary="Maximum file size for uploads"
                />
                <TextField
                  size="small"
                  type="number"
                  value={generalSettings?.maxUploadSizeMB ?? 100}
                  onChange={(e) =>
                    void updateSetting('general', 'maxUploadSizeMB', parseInt(e.target.value, 10))
                  }
                  disabled={saving}
                  sx={{ width: 100 }}
                />
              </ListItem>
              <Divider component="li" />

              <ListItem>
                <ListItemText
                  primary="Allow Registration"
                  secondary="Allow new users to register via OAuth"
                />
                <Switch
                  checked={generalSettings?.allowRegistration ?? true}
                  onChange={(e) => void updateSetting('general', 'allowRegistration', e.target.checked)}
                  disabled={saving}
                  edge="end"
                />
              </ListItem>
              <Divider component="li" />

              <ListItem>
                <ListItemText
                  primary="Require Email Verification"
                  secondary="Users must verify their email before accessing content"
                />
                <Switch
                  checked={generalSettings?.requireEmailVerification ?? false}
                  onChange={(e) =>
                    void updateSetting('general', 'requireEmailVerification', e.target.checked)
                  }
                  disabled={saving}
                  edge="end"
                />
              </ListItem>
            </List>
          </TabPanel>

          {/* Feature Flags */}
          <TabPanel value="features" selected={activeTab}>
            <List>
              <ListItem>
                <ListItemText
                  primary="AI Search"
                  secondary="Enable AI-powered search using image recognition"
                />
                <Switch
                  checked={featureSettings?.aiSearch ?? false}
                  onChange={(e) => void updateSetting('features', 'aiSearch', e.target.checked)}
                  disabled={saving}
                  edge="end"
                />
              </ListItem>
              <Divider component="li" />

              <ListItem>
                <ListItemText
                  primary="Face Recognition"
                  secondary="Enable automatic face detection and grouping"
                />
                <Switch
                  checked={featureSettings?.faceRecognition ?? false}
                  onChange={(e) => void updateSetting('features', 'faceRecognition', e.target.checked)}
                  disabled={saving}
                  edge="end"
                />
              </ListItem>
              <Divider component="li" />

              <ListItem>
                <ListItemText
                  primary="WebDAV Sync"
                  secondary="Allow syncing via WebDAV protocol"
                />
                <Switch
                  checked={featureSettings?.webdavSync ?? false}
                  onChange={(e) => void updateSetting('features', 'webdavSync', e.target.checked)}
                  disabled={saving}
                  edge="end"
                />
              </ListItem>
              <Divider component="li" />

              <ListItem>
                <ListItemText
                  primary="Public Sharing"
                  secondary="Allow users to share albums publicly"
                />
                <Switch
                  checked={featureSettings?.publicSharing ?? false}
                  onChange={(e) => void updateSetting('features', 'publicSharing', e.target.checked)}
                  disabled={saving}
                  edge="end"
                />
              </ListItem>
              <Divider component="li" />

              <ListItem>
                <ListItemText
                  primary="Guest Uploads"
                  secondary="Allow guests to upload to shared albums"
                />
                <Switch
                  checked={featureSettings?.guestUploads ?? false}
                  onChange={(e) => void updateSetting('features', 'guestUploads', e.target.checked)}
                  disabled={saving}
                  edge="end"
                />
              </ListItem>
            </List>
          </TabPanel>

          {/* SMTP Settings */}
          <TabPanel value="smtp" selected={activeTab}>
            <Alert severity="info" sx={{ mb: 2 }}>
              Configure SMTP to enable email notifications. Passwords are encrypted at rest.
            </Alert>
            <List>
              <ListItem>
                <ListItemText primary="SMTP Host" secondary="Mail server hostname" />
                <TextField
                  size="small"
                  value={smtpSettings?.host || ''}
                  onChange={(e) => void updateSetting('smtp', 'host', e.target.value)}
                  disabled={saving}
                  placeholder="smtp.example.com"
                  sx={{ width: 200 }}
                />
              </ListItem>
              <Divider component="li" />

              <ListItem>
                <ListItemText primary="SMTP Port" secondary="Usually 587 (TLS) or 465 (SSL)" />
                <TextField
                  size="small"
                  type="number"
                  value={smtpSettings?.port || 587}
                  onChange={(e) => void updateSetting('smtp', 'port', parseInt(e.target.value, 10))}
                  disabled={saving}
                  sx={{ width: 100 }}
                />
              </ListItem>
              <Divider component="li" />

              <ListItem>
                <ListItemText primary="Use TLS" secondary="Enable TLS encryption" />
                <Switch
                  checked={smtpSettings?.secure ?? true}
                  onChange={(e) => void updateSetting('smtp', 'secure', e.target.checked)}
                  disabled={saving}
                  edge="end"
                />
              </ListItem>
              <Divider component="li" />

              <ListItem>
                <ListItemText primary="Username" secondary="SMTP authentication username" />
                <TextField
                  size="small"
                  value={smtpSettings?.username || ''}
                  onChange={(e) => void updateSetting('smtp', 'username', e.target.value)}
                  disabled={saving}
                  sx={{ width: 200 }}
                />
              </ListItem>
              <Divider component="li" />

              <ListItem>
                <ListItemText primary="Password" secondary="SMTP authentication password" />
                <TextField
                  size="small"
                  type={showPassword ? 'text' : 'password'}
                  value={smtpSettings?.password || ''}
                  onChange={(e) => void updateSetting('smtp', 'password', e.target.value)}
                  disabled={saving}
                  sx={{ width: 200 }}
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          onClick={() => setShowPassword(!showPassword)}
                          edge="end"
                          size="small"
                        >
                          {showPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
                        </IconButton>
                      </InputAdornment>
                    ),
                  }}
                />
              </ListItem>
              <Divider component="li" />

              <ListItem>
                <ListItemText primary="From Address" secondary="Sender email address" />
                <TextField
                  size="small"
                  value={smtpSettings?.fromAddress || ''}
                  onChange={(e) => void updateSetting('smtp', 'fromAddress', e.target.value)}
                  disabled={saving}
                  placeholder="noreply@example.com"
                  sx={{ width: 200 }}
                />
              </ListItem>
              <Divider component="li" />

              <ListItem>
                <ListItemText primary="From Name" secondary="Sender display name" />
                <TextField
                  size="small"
                  value={smtpSettings?.fromName || ''}
                  onChange={(e) => void updateSetting('smtp', 'fromName', e.target.value)}
                  disabled={saving}
                  placeholder="MemoriaHub"
                  sx={{ width: 200 }}
                />
              </ListItem>
            </List>
          </TabPanel>

          {/* Push Settings */}
          <TabPanel value="push" selected={activeTab}>
            <Alert severity="info" sx={{ mb: 2 }}>
              Configure push notifications using Firebase Cloud Messaging or Web Push.
            </Alert>
            <List>
              <ListItem>
                <ListItemText primary="Push Provider" secondary="Notification delivery service" />
                <FormControl size="small" sx={{ width: 150 }}>
                  <Select
                    value={pushSettings?.provider || 'none'}
                    onChange={(e) => void updateSetting('push', 'provider', e.target.value)}
                    disabled={saving}
                  >
                    <MenuItem value="none">Disabled</MenuItem>
                    <MenuItem value="firebase">Firebase</MenuItem>
                    <MenuItem value="webpush">Web Push</MenuItem>
                  </Select>
                </FormControl>
              </ListItem>
            </List>
          </TabPanel>

          {/* Storage Settings */}
          <TabPanel value="storage" selected={activeTab}>
            <Alert severity="info" sx={{ mb: 2 }}>
              Configure the default storage backend for media files.
            </Alert>
            <List>
              <ListItem>
                <ListItemText
                  primary="Default Storage Backend"
                  secondary="Where to store uploaded media files"
                />
                <FormControl size="small" sx={{ width: 150 }}>
                  <Select
                    value={storageSettings?.defaultBackend || 'local'}
                    onChange={(e) => void updateSetting('storage', 'defaultBackend', e.target.value)}
                    disabled={saving}
                  >
                    <MenuItem value="local">Local</MenuItem>
                    <MenuItem value="s3">S3</MenuItem>
                  </Select>
                </FormControl>
              </ListItem>
            </List>
          </TabPanel>
        </Box>
      </Paper>

      {/* Success Snackbar */}
      <Snackbar
        open={!!success}
        autoHideDuration={3000}
        onClose={() => setSuccess(null)}
        message={success}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />

      {/* Saving Indicator */}
      {saving && (
        <Box
          sx={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            bgcolor: 'background.paper',
            px: 2,
            py: 1,
            borderRadius: 2,
            boxShadow: 3,
          }}
        >
          <CircularProgress size={20} />
          <Typography variant="body2">Saving...</Typography>
        </Box>
      )}
    </Box>
  );
}
