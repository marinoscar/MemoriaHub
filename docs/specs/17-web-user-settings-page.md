# Spec 17: Web User Settings Page

**Domain:** Frontend
**Agent:** `frontend-dev`
**Depends On:** 14-web-auth-context
**Estimated Complexity:** Medium

---

## Objective

Create the user settings page allowing users to manage their theme preference and profile settings including display name and profile image.

---

## Deliverables

### 1. File Structure

```
apps/web/src/
├── pages/
│   └── UserSettingsPage.tsx
├── components/
│   └── settings/
│       ├── ThemeSettings.tsx
│       ├── ProfileSettings.tsx
│       └── ImageUpload.tsx
├── hooks/
│   └── useUserSettings.ts
```

### 2. User Settings Hook

Create `apps/web/src/hooks/useUserSettings.ts`:

```typescript
import { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../services/api';
import { UserSettings } from '../types';
import { useThemeContext } from '../contexts/ThemeContext';

interface UseUserSettingsReturn {
  settings: UserSettings | null;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  updateSettings: (updates: Partial<UserSettings>) => Promise<void>;
  updateTheme: (theme: 'light' | 'dark' | 'system') => Promise<void>;
  updateProfile: (profile: UserSettings['profile']) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useUserSettings(): UseUserSettingsReturn {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { setMode } = useThemeContext();

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await api.get<UserSettings>('/user-settings');
      setSettings(data);
      // Sync theme with settings
      setMode(data.theme);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to load settings';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [setMode]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const updateSettings = useCallback(
    async (updates: Partial<UserSettings>) => {
      if (!settings) return;

      try {
        setIsSaving(true);
        setError(null);

        const data = await api.patch<UserSettings>('/user-settings', updates, {
          headers: {
            'If-Match': settings.version.toString(),
          },
        });

        setSettings(data);

        // Sync theme if changed
        if (updates.theme) {
          setMode(updates.theme);
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // Version conflict - refresh and retry
          await fetchSettings();
          throw new Error('Settings were updated elsewhere. Please try again.');
        }
        const message = err instanceof ApiError ? err.message : 'Failed to save settings';
        setError(message);
        throw err;
      } finally {
        setIsSaving(false);
      }
    },
    [settings, setMode, fetchSettings],
  );

  const updateTheme = useCallback(
    async (theme: 'light' | 'dark' | 'system') => {
      await updateSettings({ theme });
    },
    [updateSettings],
  );

  const updateProfile = useCallback(
    async (profile: UserSettings['profile']) => {
      await updateSettings({ profile });
    },
    [updateSettings],
  );

  return {
    settings,
    isLoading,
    error,
    isSaving,
    updateSettings,
    updateTheme,
    updateProfile,
    refresh: fetchSettings,
  };
}
```

### 3. User Settings Page

Create `apps/web/src/pages/UserSettingsPage.tsx`:

```tsx
import {
  Container,
  Typography,
  Box,
  Alert,
  Snackbar,
} from '@mui/material';
import { useState } from 'react';
import { ThemeSettings } from '../components/settings/ThemeSettings';
import { ProfileSettings } from '../components/settings/ProfileSettings';
import { useUserSettings } from '../hooks/useUserSettings';
import { LoadingSpinner } from '../components/common/LoadingSpinner';

export default function UserSettingsPage() {
  const {
    settings,
    isLoading,
    error,
    isSaving,
    updateTheme,
    updateProfile,
  } = useUserSettings();

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleThemeChange = async (theme: 'light' | 'dark' | 'system') => {
    try {
      await updateTheme(theme);
      setSuccessMessage('Theme updated');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to update theme');
    }
  };

  const handleProfileSave = async (profile: typeof settings.profile) => {
    try {
      await updateProfile(profile);
      setSuccessMessage('Profile updated');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to update profile');
    }
  };

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Settings
        </Typography>
        <Typography color="text.secondary" paragraph>
          Manage your account preferences
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {settings && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Theme Settings */}
            <ThemeSettings
              currentTheme={settings.theme}
              onThemeChange={handleThemeChange}
              disabled={isSaving}
            />

            {/* Profile Settings */}
            <ProfileSettings
              profile={settings.profile}
              onSave={handleProfileSave}
              disabled={isSaving}
            />
          </Box>
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

### 4. Theme Settings Component

Create `apps/web/src/components/settings/ThemeSettings.tsx`:

```tsx
import {
  Card,
  CardContent,
  Typography,
  ToggleButtonGroup,
  ToggleButton,
  Box,
} from '@mui/material';
import {
  LightMode as LightIcon,
  DarkMode as DarkIcon,
  SettingsBrightness as SystemIcon,
} from '@mui/icons-material';

interface ThemeSettingsProps {
  currentTheme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  disabled?: boolean;
}

export function ThemeSettings({
  currentTheme,
  onThemeChange,
  disabled = false,
}: ThemeSettingsProps) {
  const handleChange = (
    _event: React.MouseEvent<HTMLElement>,
    newTheme: 'light' | 'dark' | 'system' | null,
  ) => {
    if (newTheme !== null) {
      onThemeChange(newTheme);
    }
  };

  return (
    <Card id="theme">
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Appearance
        </Typography>
        <Typography variant="body2" color="text.secondary" paragraph>
          Choose how the application looks to you
        </Typography>

        <ToggleButtonGroup
          value={currentTheme}
          exclusive
          onChange={handleChange}
          aria-label="theme selection"
          disabled={disabled}
          sx={{ mt: 1 }}
        >
          <ToggleButton value="light" aria-label="light mode">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1 }}>
              <LightIcon />
              <span>Light</span>
            </Box>
          </ToggleButton>
          <ToggleButton value="dark" aria-label="dark mode">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1 }}>
              <DarkIcon />
              <span>Dark</span>
            </Box>
          </ToggleButton>
          <ToggleButton value="system" aria-label="system preference">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1 }}>
              <SystemIcon />
              <span>System</span>
            </Box>
          </ToggleButton>
        </ToggleButtonGroup>
      </CardContent>
    </Card>
  );
}
```

### 5. Profile Settings Component

Create `apps/web/src/components/settings/ProfileSettings.tsx`:

```tsx
import { useState, useEffect } from 'react';
import {
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Box,
  Switch,
  FormControlLabel,
  Avatar,
  Stack,
} from '@mui/material';
import { useAuth } from '../../contexts/AuthContext';
import { ImageUpload } from './ImageUpload';

interface ProfileSettingsProps {
  profile: {
    displayName?: string;
    useProviderImage: boolean;
    customImageUrl?: string | null;
  };
  onSave: (profile: ProfileSettingsProps['profile']) => Promise<void>;
  disabled?: boolean;
}

export function ProfileSettings({
  profile,
  onSave,
  disabled = false,
}: ProfileSettingsProps) {
  const { user, refreshUser } = useAuth();
  const [displayName, setDisplayName] = useState(profile.displayName || '');
  const [useProviderImage, setUseProviderImage] = useState(profile.useProviderImage);
  const [customImageUrl, setCustomImageUrl] = useState(profile.customImageUrl || '');
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Reset form when profile changes
  useEffect(() => {
    setDisplayName(profile.displayName || '');
    setUseProviderImage(profile.useProviderImage);
    setCustomImageUrl(profile.customImageUrl || '');
    setHasChanges(false);
  }, [profile]);

  // Track changes
  useEffect(() => {
    const changed =
      displayName !== (profile.displayName || '') ||
      useProviderImage !== profile.useProviderImage ||
      customImageUrl !== (profile.customImageUrl || '');
    setHasChanges(changed);
  }, [displayName, useProviderImage, customImageUrl, profile]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave({
        displayName: displayName || undefined,
        useProviderImage,
        customImageUrl: customImageUrl || null,
      });
      // Refresh user to get updated profile
      await refreshUser();
    } finally {
      setIsSaving(false);
    }
  };

  const handleImageUpload = (url: string) => {
    setCustomImageUrl(url);
    setUseProviderImage(false);
  };

  const currentImageUrl = useProviderImage
    ? user?.profileImageUrl
    : customImageUrl || user?.profileImageUrl;

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Profile
        </Typography>
        <Typography variant="body2" color="text.secondary" paragraph>
          Customize how you appear to others
        </Typography>

        <Stack spacing={3}>
          {/* Profile Image */}
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Profile Image
            </Typography>
            <Stack direction="row" spacing={3} alignItems="center">
              <Avatar
                src={currentImageUrl || undefined}
                alt={user?.displayName || user?.email}
                sx={{ width: 80, height: 80 }}
              />
              <Box sx={{ flexGrow: 1 }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={useProviderImage}
                      onChange={(e) => setUseProviderImage(e.target.checked)}
                      disabled={disabled}
                    />
                  }
                  label="Use Google profile image"
                />
                {!useProviderImage && (
                  <ImageUpload
                    onUpload={handleImageUpload}
                    disabled={disabled || isSaving}
                  />
                )}
              </Box>
            </Stack>
          </Box>

          {/* Display Name */}
          <TextField
            label="Display Name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={user?.email?.split('@')[0]}
            helperText="Leave empty to use your Google name"
            disabled={disabled}
            fullWidth
          />

          {/* Email (read-only) */}
          <TextField
            label="Email"
            value={user?.email || ''}
            disabled
            fullWidth
            helperText="Email cannot be changed"
          />

          {/* Save Button */}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="contained"
              onClick={handleSave}
              disabled={disabled || !hasChanges || isSaving}
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}
```

### 6. Image Upload Component

Create `apps/web/src/components/settings/ImageUpload.tsx`:

```tsx
import { useState, useRef } from 'react';
import { Button, Box, Typography, CircularProgress } from '@mui/material';
import { CloudUpload as UploadIcon } from '@mui/icons-material';
import { api, ApiError } from '../../services/api';

interface ImageUploadProps {
  onUpload: (url: string) => void;
  disabled?: boolean;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export function ImageUpload({ onUpload, disabled = false }: ImageUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('Please select a valid image file (JPEG, PNG, GIF, or WebP)');
      return;
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      setError('File size must be less than 5MB');
      return;
    }

    setError(null);
    setIsUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);

      // Note: This endpoint would need to be implemented in the API
      // For MVP, you could use a simple file storage or cloud service
      const response = await fetch('/api/users/profile-image', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${api.getAccessToken()}`,
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Upload failed');
      }

      const data = await response.json();
      onUpload(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload image');
    } finally {
      setIsUploading(false);
      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <Box sx={{ mt: 1 }}>
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_TYPES.join(',')}
        onChange={handleFileSelect}
        style={{ display: 'none' }}
        disabled={disabled || isUploading}
      />
      <Button
        variant="outlined"
        size="small"
        startIcon={isUploading ? <CircularProgress size={16} /> : <UploadIcon />}
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled || isUploading}
      >
        {isUploading ? 'Uploading...' : 'Upload Custom Image'}
      </Button>
      {error && (
        <Typography variant="caption" color="error" display="block" sx={{ mt: 0.5 }}>
          {error}
        </Typography>
      )}
    </Box>
  );
}
```

---

## User Settings Structure

```typescript
interface UserSettings {
  theme: 'light' | 'dark' | 'system';
  profile: {
    displayName?: string;
    useProviderImage: boolean;
    customImageUrl?: string | null;
  };
  updatedAt: string;
  version: number;
}
```

---

## Optimistic Concurrency

The settings use optimistic concurrency via the `If-Match` header:
1. Settings fetched with version number
2. Update request includes `If-Match: {version}`
3. If version mismatch, server returns 409 Conflict
4. Hook refreshes settings and prompts user to retry

---

## Acceptance Criteria

- [ ] Settings page renders at `/settings`
- [ ] Theme toggle buttons work correctly
- [ ] Theme change persists to server
- [ ] Theme syncs with ThemeContext
- [ ] Display name can be edited and saved
- [ ] Email is displayed but read-only
- [ ] Profile image toggle between provider/custom
- [ ] Image upload validates file type and size
- [ ] Save button disabled when no changes
- [ ] Success/error notifications display
- [ ] Version conflict handled gracefully
- [ ] Loading state during save

---

## Notes

- Theme preference synced to both API and ThemeContext
- Profile image upload requires API endpoint (spec 08 mentions it)
- Form tracks dirty state to enable/disable save
- Version number used for optimistic concurrency
