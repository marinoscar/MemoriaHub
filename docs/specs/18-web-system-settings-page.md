# Spec 18: Web System Settings Page

**Domain:** Frontend
**Agent:** `frontend-dev`
**Depends On:** 14-web-auth-context
**Estimated Complexity:** Medium

---

## Objective

Create an admin-only system settings page with a JSON editor for viewing and modifying application-wide settings with validation.

---

## Deliverables

### 1. File Structure

```
apps/web/src/
├── pages/
│   └── SystemSettingsPage.tsx
├── components/
│   └── admin/
│       ├── SystemSettingsEditor.tsx
│       └── FeatureFlagsList.tsx
├── hooks/
│   └── useSystemSettings.ts
```

### 2. System Settings Hook

Create `apps/web/src/hooks/useSystemSettings.ts`:

```typescript
import { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../services/api';
import { SystemSettings } from '../types';

interface UseSystemSettingsReturn {
  settings: SystemSettings | null;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  updateSettings: (updates: Partial<SystemSettings>) => Promise<void>;
  replaceSettings: (settings: Omit<SystemSettings, 'updatedAt' | 'updatedBy' | 'version'>) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useSystemSettings(): UseSystemSettingsReturn {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await api.get<SystemSettings>('/system-settings');
      setSettings(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError('You do not have permission to view system settings');
      } else {
        const message = err instanceof ApiError ? err.message : 'Failed to load settings';
        setError(message);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const updateSettings = useCallback(
    async (updates: Partial<SystemSettings>) => {
      if (!settings) return;

      try {
        setIsSaving(true);
        setError(null);

        const data = await api.patch<SystemSettings>('/system-settings', updates, {
          headers: {
            'If-Match': settings.version.toString(),
          },
        });

        setSettings(data);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          await fetchSettings();
          throw new Error('Settings were updated elsewhere. Please review and try again.');
        }
        const message = err instanceof ApiError ? err.message : 'Failed to save settings';
        setError(message);
        throw err;
      } finally {
        setIsSaving(false);
      }
    },
    [settings, fetchSettings],
  );

  const replaceSettings = useCallback(
    async (newSettings: Omit<SystemSettings, 'updatedAt' | 'updatedBy' | 'version'>) => {
      try {
        setIsSaving(true);
        setError(null);

        const data = await api.put<SystemSettings>('/system-settings', newSettings);
        setSettings(data);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Failed to save settings';
        setError(message);
        throw err;
      } finally {
        setIsSaving(false);
      }
    },
    [],
  );

  return {
    settings,
    isLoading,
    error,
    isSaving,
    updateSettings,
    replaceSettings,
    refresh: fetchSettings,
  };
}
```

### 3. System Settings Page

Create `apps/web/src/pages/SystemSettingsPage.tsx`:

```tsx
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
import { SystemSettingsEditor } from '../components/admin/SystemSettingsEditor';
import { FeatureFlagsList } from '../components/admin/FeatureFlagsList';
import { SecuritySettings } from '../components/admin/SecuritySettings';
import { UISettings } from '../components/admin/UISettings';

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
    refresh,
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
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          System Settings
        </Typography>
        <Typography color="text.secondary" paragraph>
          Configure application-wide settings
          {!canWrite && ' (read-only)'}
        </Typography>

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
              value={tabIndex}
              onChange={(_, newValue) => setTabIndex(newValue)}
              sx={{ borderBottom: 1, borderColor: 'divider' }}
            >
              <Tab label="UI Settings" />
              <Tab label="Security" />
              <Tab label="Feature Flags" />
              <Tab label="Advanced (JSON)" />
            </Tabs>

            <Box sx={{ p: 3 }}>
              <TabPanel value={tabIndex} index={0}>
                <UISettings
                  settings={settings.ui}
                  onSave={(ui) => handleSave('ui', ui)}
                  disabled={!canWrite || isSaving}
                />
              </TabPanel>

              <TabPanel value={tabIndex} index={1}>
                <SecuritySettings
                  settings={settings.security}
                  onSave={(security) => handleSave('security', security)}
                  disabled={!canWrite || isSaving}
                />
              </TabPanel>

              <TabPanel value={tabIndex} index={2}>
                <FeatureFlagsList
                  flags={settings.features}
                  onSave={(features) => handleSave('features', features)}
                  disabled={!canWrite || isSaving}
                />
              </TabPanel>

              <TabPanel value={tabIndex} index={3}>
                <SystemSettingsEditor
                  settings={settings}
                  onSave={updateSettings}
                  disabled={!canWrite || isSaving}
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
```

### 4. UI Settings Component

Create `apps/web/src/components/admin/UISettings.tsx`:

```tsx
import {
  Box,
  Typography,
  Switch,
  FormControlLabel,
  Button,
} from '@mui/material';
import { useState, useEffect } from 'react';

interface UISettingsProps {
  settings: {
    allowUserThemeOverride: boolean;
  };
  onSave: (settings: UISettingsProps['settings']) => Promise<void>;
  disabled?: boolean;
}

export function UISettings({ settings, onSave, disabled }: UISettingsProps) {
  const [allowThemeOverride, setAllowThemeOverride] = useState(
    settings.allowUserThemeOverride,
  );
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setAllowThemeOverride(settings.allowUserThemeOverride);
  }, [settings]);

  const hasChanges = allowThemeOverride !== settings.allowUserThemeOverride;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave({ allowUserThemeOverride: allowThemeOverride });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        User Interface
      </Typography>

      <FormControlLabel
        control={
          <Switch
            checked={allowThemeOverride}
            onChange={(e) => setAllowThemeOverride(e.target.checked)}
            disabled={disabled}
          />
        }
        label="Allow users to override system theme"
      />
      <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mb: 2 }}>
        When disabled, all users will use the system-defined theme
      </Typography>

      <Box sx={{ mt: 3 }}>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={disabled || !hasChanges || isSaving}
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </Box>
    </Box>
  );
}
```

### 5. Security Settings Component

Create `apps/web/src/components/admin/SecuritySettings.tsx`:

```tsx
import {
  Box,
  Typography,
  TextField,
  Button,
  Stack,
  Alert,
} from '@mui/material';
import { useState, useEffect } from 'react';

interface SecuritySettingsProps {
  settings: {
    jwtAccessTtlMinutes: number;
    refreshTtlDays: number;
  };
  onSave: (settings: SecuritySettingsProps['settings']) => Promise<void>;
  disabled?: boolean;
}

export function SecuritySettings({ settings, onSave, disabled }: SecuritySettingsProps) {
  const [accessTtl, setAccessTtl] = useState(settings.jwtAccessTtlMinutes);
  const [refreshTtl, setRefreshTtl] = useState(settings.refreshTtlDays);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAccessTtl(settings.jwtAccessTtlMinutes);
    setRefreshTtl(settings.refreshTtlDays);
  }, [settings]);

  const hasChanges =
    accessTtl !== settings.jwtAccessTtlMinutes ||
    refreshTtl !== settings.refreshTtlDays;

  const validate = (): boolean => {
    if (accessTtl < 1 || accessTtl > 60) {
      setError('Access token TTL must be between 1 and 60 minutes');
      return false;
    }
    if (refreshTtl < 1 || refreshTtl > 90) {
      setError('Refresh token TTL must be between 1 and 90 days');
      return false;
    }
    setError(null);
    return true;
  };

  const handleSave = async () => {
    if (!validate()) return;

    setIsSaving(true);
    try {
      await onSave({
        jwtAccessTtlMinutes: accessTtl,
        refreshTtlDays: refreshTtl,
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Security Settings
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Alert severity="warning" sx={{ mb: 3 }}>
        Changes to token TTL will affect new sessions only. Existing sessions
        will continue with their current tokens until they expire.
      </Alert>

      <Stack spacing={3} sx={{ maxWidth: 400 }}>
        <TextField
          label="Access Token TTL (minutes)"
          type="number"
          value={accessTtl}
          onChange={(e) => setAccessTtl(parseInt(e.target.value, 10) || 0)}
          inputProps={{ min: 1, max: 60 }}
          helperText="How long access tokens are valid (1-60 minutes)"
          disabled={disabled}
        />

        <TextField
          label="Refresh Token TTL (days)"
          type="number"
          value={refreshTtl}
          onChange={(e) => setRefreshTtl(parseInt(e.target.value, 10) || 0)}
          inputProps={{ min: 1, max: 90 }}
          helperText="How long refresh tokens are valid (1-90 days)"
          disabled={disabled}
        />

        <Button
          variant="contained"
          onClick={handleSave}
          disabled={disabled || !hasChanges || isSaving}
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </Stack>
    </Box>
  );
}
```

### 6. Feature Flags Component

Create `apps/web/src/components/admin/FeatureFlagsList.tsx`:

```tsx
import {
  Box,
  Typography,
  Switch,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  TextField,
  Button,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon } from '@mui/icons-material';
import { useState } from 'react';

interface FeatureFlagsListProps {
  flags: Record<string, boolean>;
  onSave: (flags: Record<string, boolean>) => Promise<void>;
  disabled?: boolean;
}

export function FeatureFlagsList({ flags, onSave, disabled }: FeatureFlagsListProps) {
  const [localFlags, setLocalFlags] = useState<Record<string, boolean>>(flags);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newFlagName, setNewFlagName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const hasChanges = JSON.stringify(localFlags) !== JSON.stringify(flags);

  const handleToggle = (key: string) => {
    setLocalFlags((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleDelete = (key: string) => {
    setLocalFlags((prev) => {
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  const handleAddFlag = () => {
    if (newFlagName && !localFlags.hasOwnProperty(newFlagName)) {
      setLocalFlags((prev) => ({
        ...prev,
        [newFlagName]: false,
      }));
      setNewFlagName('');
      setDialogOpen(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(localFlags);
    } finally {
      setIsSaving(false);
    }
  };

  const flagEntries = Object.entries(localFlags).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h6">Feature Flags</Typography>
        <Button
          startIcon={<AddIcon />}
          onClick={() => setDialogOpen(true)}
          disabled={disabled}
        >
          Add Flag
        </Button>
      </Box>

      {flagEntries.length === 0 ? (
        <Typography color="text.secondary">
          No feature flags configured
        </Typography>
      ) : (
        <List>
          {flagEntries.map(([key, value]) => (
            <ListItem key={key} divider>
              <ListItemText
                primary={key}
                secondary={value ? 'Enabled' : 'Disabled'}
              />
              <ListItemSecondaryAction>
                <Switch
                  checked={value}
                  onChange={() => handleToggle(key)}
                  disabled={disabled}
                />
                <IconButton
                  edge="end"
                  onClick={() => handleDelete(key)}
                  disabled={disabled}
                  sx={{ ml: 1 }}
                >
                  <DeleteIcon />
                </IconButton>
              </ListItemSecondaryAction>
            </ListItem>
          ))}
        </List>
      )}

      <Box sx={{ mt: 3 }}>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={disabled || !hasChanges || isSaving}
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </Box>

      {/* Add Flag Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <DialogTitle>Add Feature Flag</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            label="Flag Name"
            value={newFlagName}
            onChange={(e) => setNewFlagName(e.target.value.replace(/\s/g, '_'))}
            fullWidth
            sx={{ mt: 1 }}
            helperText="Use snake_case or camelCase"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleAddFlag} disabled={!newFlagName}>
            Add
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
```

### 7. JSON Editor Component

Create `apps/web/src/components/admin/SystemSettingsEditor.tsx`:

```tsx
import { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Alert,
} from '@mui/material';
import { SystemSettings } from '../../types';

interface SystemSettingsEditorProps {
  settings: SystemSettings;
  onSave: (updates: Partial<SystemSettings>) => Promise<void>;
  disabled?: boolean;
}

export function SystemSettingsEditor({
  settings,
  onSave,
  disabled,
}: SystemSettingsEditorProps) {
  const editableSettings = {
    ui: settings.ui,
    security: settings.security,
    features: settings.features,
  };

  const [jsonValue, setJsonValue] = useState(
    JSON.stringify(editableSettings, null, 2),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setJsonValue(JSON.stringify(editableSettings, null, 2));
  }, [settings]);

  const validateJson = (): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(jsonValue);

      // Basic structure validation
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('Settings must be an object');
      }

      if (parsed.ui && typeof parsed.ui.allowUserThemeOverride !== 'boolean') {
        throw new Error('ui.allowUserThemeOverride must be a boolean');
      }

      if (parsed.security) {
        if (
          typeof parsed.security.jwtAccessTtlMinutes !== 'number' ||
          parsed.security.jwtAccessTtlMinutes < 1 ||
          parsed.security.jwtAccessTtlMinutes > 60
        ) {
          throw new Error('security.jwtAccessTtlMinutes must be 1-60');
        }
        if (
          typeof parsed.security.refreshTtlDays !== 'number' ||
          parsed.security.refreshTtlDays < 1 ||
          parsed.security.refreshTtlDays > 90
        ) {
          throw new Error('security.refreshTtlDays must be 1-90');
        }
      }

      setError(null);
      return parsed;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON');
      return null;
    }
  };

  const handleSave = async () => {
    const parsed = validateJson();
    if (!parsed) return;

    setIsSaving(true);
    try {
      await onSave(parsed as Partial<SystemSettings>);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanges = jsonValue !== JSON.stringify(editableSettings, null, 2);

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Advanced JSON Editor
      </Typography>

      <Alert severity="info" sx={{ mb: 2 }}>
        Edit the raw JSON settings. Be careful - invalid values may cause issues.
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <TextField
        multiline
        fullWidth
        minRows={15}
        maxRows={30}
        value={jsonValue}
        onChange={(e) => setJsonValue(e.target.value)}
        disabled={disabled}
        sx={{
          fontFamily: 'monospace',
          '& .MuiInputBase-input': {
            fontFamily: 'monospace',
            fontSize: '0.875rem',
          },
        }}
      />

      <Box sx={{ mt: 2 }}>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={disabled || !hasChanges || isSaving}
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </Box>
    </Box>
  );
}
```

---

## Acceptance Criteria

- [ ] System settings page renders at `/admin/settings`
- [ ] Non-admin users redirected to home
- [ ] Read-only mode for users without write permission
- [ ] UI settings tab controls theme override
- [ ] Security settings tab controls token TTL
- [ ] Feature flags can be toggled, added, and removed
- [ ] JSON editor shows formatted settings
- [ ] JSON validation before save
- [ ] Last updated info displayed
- [ ] Version conflict handled gracefully
- [ ] Success/error notifications display

---

## Notes

- System settings require `system_settings:read` permission to view
- Modifications require `system_settings:write` permission
- JSON editor is for advanced users - structured UI preferred
- Security settings changes only affect new sessions
- Feature flags support dynamic keys
