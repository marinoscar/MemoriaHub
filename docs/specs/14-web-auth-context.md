# Spec 14: Web Auth Context

**Domain:** Frontend
**Agent:** `frontend-dev`
**Depends On:** 13-web-project-setup
**Estimated Complexity:** Medium

---

## Objective

Implement authentication context and theme context for managing user sessions, token handling, and theme preferences throughout the React application.

---

## Deliverables

### 1. File Structure

```
apps/web/src/
├── contexts/
│   ├── AuthContext.tsx
│   └── ThemeContext.tsx
├── hooks/
│   ├── useAuth.ts
│   └── usePermissions.ts
```

### 2. Auth Context

Create `apps/web/src/contexts/AuthContext.tsx`:

```tsx
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api, ApiError } from '../services/api';
import { User, AuthProvider as AuthProviderType } from '../types';

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  providers: AuthProviderType[];
  login: (provider: string) => void;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [providers, setProviders] = useState<AuthProviderType[]>([]);
  const navigate = useNavigate();
  const location = useLocation();

  // Fetch auth providers on mount
  useEffect(() => {
    const fetchProviders = async () => {
      try {
        const data = await api.get<AuthProviderType[]>('/auth/providers', {
          skipAuth: true,
        });
        setProviders(data);
      } catch (error) {
        console.error('Failed to fetch auth providers:', error);
      }
    };
    fetchProviders();
  }, []);

  // Check for existing session on mount
  useEffect(() => {
    const initAuth = async () => {
      try {
        // Try to refresh token (uses httpOnly cookie)
        const refreshed = await api.refreshToken();
        if (refreshed) {
          await fetchUser();
        }
      } catch (error) {
        console.error('Auth initialization failed:', error);
      } finally {
        setIsLoading(false);
      }
    };
    initAuth();
  }, []);

  const fetchUser = useCallback(async () => {
    try {
      const userData = await api.get<User>('/auth/me');
      setUser(userData);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setUser(null);
        api.setAccessToken(null);
      }
      throw error;
    }
  }, []);

  const login = useCallback((provider: string) => {
    // Store return URL for redirect after login
    const from = location.state?.from?.pathname || '/';
    sessionStorage.setItem('auth_return_url', from);

    // Redirect to OAuth provider
    window.location.href = `/api/auth/${provider}`;
  }, [location.state]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setUser(null);
      api.setAccessToken(null);
      navigate('/login');
    }
  }, [navigate]);

  const refreshUser = useCallback(async () => {
    await fetchUser();
  }, [fetchUser]);

  const value: AuthContextValue = {
    user,
    isLoading,
    isAuthenticated: !!user,
    providers,
    login,
    logout,
    refreshUser,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
```

### 3. Theme Context

Create `apps/web/src/contexts/ThemeContext.tsx`:

```tsx
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  ReactNode,
  useCallback,
} from 'react';
import { Theme, useMediaQuery } from '@mui/material';
import { lightTheme, darkTheme, ThemeMode } from '../theme';

interface ThemeContextValue {
  mode: ThemeMode;
  theme: Theme;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
  isDarkMode: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const THEME_STORAGE_KEY = 'theme_mode';

interface ThemeContextProviderProps {
  children: ReactNode;
}

export function ThemeContextProvider({ children }: ThemeContextProviderProps) {
  // Check system preference
  const prefersDarkMode = useMediaQuery('(prefers-color-scheme: dark)');

  // Load saved preference or default to 'system'
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') {
      return saved;
    }
    return 'system';
  });

  // Persist mode changes
  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    localStorage.setItem(THEME_STORAGE_KEY, newMode);
  }, []);

  // Resolve actual theme based on mode and system preference
  const isDarkMode = useMemo(() => {
    if (mode === 'system') {
      return prefersDarkMode;
    }
    return mode === 'dark';
  }, [mode, prefersDarkMode]);

  const theme = useMemo(() => {
    return isDarkMode ? darkTheme : lightTheme;
  }, [isDarkMode]);

  const toggleMode = useCallback(() => {
    setMode(isDarkMode ? 'light' : 'dark');
  }, [isDarkMode, setMode]);

  // Sync theme with user settings when available
  const syncWithUserSettings = useCallback((userTheme: ThemeMode) => {
    setModeState(userTheme);
    // Don't persist to localStorage as this comes from server
  }, []);

  const value: ThemeContextValue = {
    mode,
    theme,
    setMode,
    toggleMode,
    isDarkMode,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useThemeContext(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useThemeContext must be used within a ThemeContextProvider');
  }
  return context;
}
```

### 4. Permissions Hook

Create `apps/web/src/hooks/usePermissions.ts`:

```typescript
import { useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';

export function usePermissions() {
  const { user } = useAuth();

  const permissions = useMemo(() => {
    return new Set(user?.permissions || []);
  }, [user?.permissions]);

  const roles = useMemo(() => {
    return new Set(user?.roles || []);
  }, [user?.roles]);

  const hasPermission = (permission: string): boolean => {
    return permissions.has(permission);
  };

  const hasAnyPermission = (...perms: string[]): boolean => {
    return perms.some((p) => permissions.has(p));
  };

  const hasAllPermissions = (...perms: string[]): boolean => {
    return perms.every((p) => permissions.has(p));
  };

  const hasRole = (role: string): boolean => {
    return roles.has(role);
  };

  const hasAnyRole = (...roleList: string[]): boolean => {
    return roleList.some((r) => roles.has(r));
  };

  const isAdmin = useMemo(() => {
    return roles.has('admin');
  }, [roles]);

  return {
    permissions,
    roles,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    hasRole,
    hasAnyRole,
    isAdmin,
  };
}
```

### 5. Auth Callback Page

Create `apps/web/src/pages/AuthCallbackPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Box, Typography, CircularProgress, Alert } from '@mui/material';
import { api } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

export default function AuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleCallback = async () => {
      const token = searchParams.get('token');
      const errorParam = searchParams.get('error');

      if (errorParam) {
        setError(errorParam);
        return;
      }

      if (!token) {
        setError('No authentication token received');
        return;
      }

      try {
        // Store the access token
        api.setAccessToken(token);

        // Fetch user data
        await refreshUser();

        // Get return URL and clear it
        const returnUrl = sessionStorage.getItem('auth_return_url') || '/';
        sessionStorage.removeItem('auth_return_url');

        // Navigate to return URL
        navigate(returnUrl, { replace: true });
      } catch (err) {
        setError('Failed to complete authentication');
        api.setAccessToken(null);
      }
    };

    handleCallback();
  }, [searchParams, navigate, refreshUser]);

  if (error) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: 2,
        }}
      >
        <Alert severity="error" sx={{ maxWidth: 400 }}>
          {error}
        </Alert>
        <Typography variant="body2" color="text.secondary">
          <a href="/login">Return to login</a>
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: 2,
      }}
    >
      <CircularProgress />
      <Typography>Completing authentication...</Typography>
    </Box>
  );
}
```

### 6. Permission-Based Components

Create `apps/web/src/components/common/RequirePermission.tsx`:

```tsx
import { ReactNode } from 'react';
import { usePermissions } from '../../hooks/usePermissions';

interface RequirePermissionProps {
  permission?: string;
  permissions?: string[];
  requireAll?: boolean;
  role?: string;
  roles?: string[];
  children: ReactNode;
  fallback?: ReactNode;
}

export function RequirePermission({
  permission,
  permissions,
  requireAll = false,
  role,
  roles,
  children,
  fallback = null,
}: RequirePermissionProps) {
  const {
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    hasRole,
    hasAnyRole,
  } = usePermissions();

  // Check single permission
  if (permission && !hasPermission(permission)) {
    return <>{fallback}</>;
  }

  // Check multiple permissions
  if (permissions && permissions.length > 0) {
    const hasPerms = requireAll
      ? hasAllPermissions(...permissions)
      : hasAnyPermission(...permissions);
    if (!hasPerms) {
      return <>{fallback}</>;
    }
  }

  // Check single role
  if (role && !hasRole(role)) {
    return <>{fallback}</>;
  }

  // Check multiple roles
  if (roles && roles.length > 0 && !hasAnyRole(...roles)) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
```

Create `apps/web/src/components/common/AdminOnly.tsx`:

```tsx
import { ReactNode } from 'react';
import { usePermissions } from '../../hooks/usePermissions';

interface AdminOnlyProps {
  children: ReactNode;
  fallback?: ReactNode;
}

export function AdminOnly({ children, fallback = null }: AdminOnlyProps) {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
```

---

## Usage Examples

### Using Auth Context

```tsx
import { useAuth } from '../contexts/AuthContext';

function MyComponent() {
  const { user, isLoading, logout, providers } = useAuth();

  if (isLoading) return <LoadingSpinner />;

  if (!user) {
    return (
      <div>
        {providers.map((p) => (
          <Button key={p.name} onClick={() => login(p.name)}>
            Login with {p.name}
          </Button>
        ))}
      </div>
    );
  }

  return (
    <div>
      <p>Welcome, {user.displayName}</p>
      <Button onClick={logout}>Logout</Button>
    </div>
  );
}
```

### Using Theme Context

```tsx
import { useThemeContext } from '../contexts/ThemeContext';

function ThemeToggle() {
  const { mode, setMode, isDarkMode, toggleMode } = useThemeContext();

  return (
    <div>
      <Select value={mode} onChange={(e) => setMode(e.target.value)}>
        <MenuItem value="light">Light</MenuItem>
        <MenuItem value="dark">Dark</MenuItem>
        <MenuItem value="system">System</MenuItem>
      </Select>

      <IconButton onClick={toggleMode}>
        {isDarkMode ? <LightModeIcon /> : <DarkModeIcon />}
      </IconButton>
    </div>
  );
}
```

### Using Permissions

```tsx
import { usePermissions } from '../hooks/usePermissions';
import { RequirePermission, AdminOnly } from '../components/common';

function SettingsPage() {
  const { hasPermission, isAdmin } = usePermissions();

  return (
    <div>
      <h1>Settings</h1>

      {/* Inline check */}
      {hasPermission('user_settings:write') && (
        <Button>Edit Settings</Button>
      )}

      {/* Component-based check */}
      <RequirePermission permission="system_settings:read">
        <SystemSettingsViewer />
      </RequirePermission>

      {/* Admin-only content */}
      <AdminOnly>
        <AdminPanel />
      </AdminOnly>
    </div>
  );
}
```

---

## Acceptance Criteria

- [ ] AuthProvider initializes and checks for existing session
- [ ] Token refresh works automatically on 401
- [ ] Login redirects to OAuth provider
- [ ] Auth callback handles token and redirects to original URL
- [ ] Logout clears tokens and redirects to login
- [ ] Theme context persists preference to localStorage
- [ ] System theme preference detected correctly
- [ ] Theme toggle works instantly
- [ ] usePermissions hook provides all permission checks
- [ ] RequirePermission component hides unauthorized content
- [ ] AdminOnly component works correctly
- [ ] All hooks throw errors when used outside providers

---

## Notes

- Access token stored in memory (more secure than localStorage)
- Refresh token handled via httpOnly cookie
- Theme preference persisted to localStorage for immediate load
- Permission checks are client-side (UI only) - API enforces actual security
- Auth callback preserves original navigation intent
