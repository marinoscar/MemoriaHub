# Web Frontend Test Checklist

This is an actionable checklist of all tests to implement, organized by file.

## P0 - Critical Tests

### 1. `apps/web/src/contexts/AuthContext.test.ts`

```typescript
describe('useAuthStore', () => {
  describe('login', () => {
    it('stores access token in session storage');
    it('stores refresh token in local storage');
    it('fetches user info after storing tokens');
    it('sets isAuthenticated to true on success');
    it('sets user state from API response');
    it('sets error state on API failure');
    it('clears tokens on API failure');
  });

  describe('logout', () => {
    it('calls logout API endpoint');
    it('clears access token from session storage');
    it('clears refresh token from local storage');
    it('sets user to null');
    it('sets isAuthenticated to false');
    it('handles API error gracefully (still clears local state)');
  });

  describe('checkAuth', () => {
    it('returns early if no tokens exist');
    it('sets isLoading to true while checking');
    it('fetches user if access token exists');
    it('sets isAuthenticated true if user fetch succeeds');
    it('attempts refresh if user fetch returns 401');
    it('logs out if refresh fails');
    it('sets isLoading to false when complete');
  });

  describe('refreshToken', () => {
    it('calls refresh API with refresh token');
    it('stores new access token on success');
    it('stores new refresh token on success');
    it('returns true on success');
    it('clears tokens on failure');
    it('returns false on failure');
  });

  describe('initial state', () => {
    it('starts with user as null');
    it('starts with isAuthenticated as false');
    it('starts with isLoading as true');
    it('starts with error as null');
  });
});
```

**Test count: 27 tests**

---

### 2. `apps/web/src/services/api/client.test.ts`

```typescript
describe('apiClient', () => {
  describe('request interceptor', () => {
    it('adds Authorization header when access token exists');
    it('does not add Authorization header when no token');
    it('uses Bearer scheme for token');
  });

  describe('response interceptor - success', () => {
    it('passes through successful responses unchanged');
  });

  describe('response interceptor - 401 handling', () => {
    it('attempts token refresh on 401 response');
    it('retries original request after successful refresh');
    it('includes new token in retried request');
    it('redirects to login on refresh failure');
    it('clears tokens on refresh failure');
  });

  describe('response interceptor - concurrent 401s', () => {
    it('queues requests while refresh is in progress');
    it('only calls refresh API once for multiple 401s');
    it('retries all queued requests after refresh');
    it('rejects all queued requests if refresh fails');
  });

  describe('response interceptor - other errors', () => {
    it('passes through 400 errors unchanged');
    it('passes through 403 errors unchanged');
    it('passes through 500 errors unchanged');
    it('passes through network errors unchanged');
  });

  describe('configuration', () => {
    it('uses correct base URL from environment');
    it('sets appropriate timeout');
    it('includes credentials for cookies');
  });
});
```

**Test count: 19 tests**

---

### 3. `apps/web/src/components/auth/OAuthCallback.test.tsx`

```typescript
describe('OAuthCallback', () => {
  describe('token extraction', () => {
    it('extracts access_token from URL search params');
    it('extracts refresh_token from URL search params');
    it('handles URL-encoded tokens');
  });

  describe('successful login', () => {
    it('calls login with extracted tokens');
    it('navigates to home page on success');
    it('clears URL params after login');
  });

  describe('error handling', () => {
    it('displays error when error param in URL');
    it('displays error description from URL');
    it('displays error when access_token missing');
    it('displays error when refresh_token missing');
    it('displays error when login fails');
    it('shows login link on error');
  });

  describe('loading state', () => {
    it('shows loading spinner initially');
    it('hides spinner after login attempt');
  });
});
```

**Test count: 14 tests**

---

### 4. `apps/web/src/components/auth/ProtectedRoute.test.tsx`

```typescript
describe('ProtectedRoute', () => {
  describe('loading state', () => {
    it('shows LoadingSpinner when isLoading is true');
    it('does not render children when loading');
  });

  describe('unauthenticated user', () => {
    it('redirects to /login when not authenticated');
    it('does not render children');
    it('preserves intended destination in state');
  });

  describe('authenticated user', () => {
    it('renders children when authenticated');
    it('does not redirect');
  });

  describe('login page redirect', () => {
    it('redirects authenticated user from /login to /');
    it('allows unauthenticated user to view /login');
  });
});
```

**Test count: 9 tests**

---

## P1 - High Priority Tests

### 5. `apps/web/src/pages/SettingsPage.test.tsx`

```typescript
describe('SettingsPage', () => {
  describe('initial load', () => {
    it('shows loading state initially');
    it('fetches preferences on mount');
    it('displays preferences after loading');
    it('shows error state if fetch fails');
  });

  describe('theme sync', () => {
    it('syncs theme context with server preference');
    it('handles system theme preference');
    it('handles dark theme preference');
    it('handles light theme preference');
  });

  describe('appearance settings', () => {
    it('renders theme selector with current value');
    it('updates theme when changed');
    it('renders grid size selector');
    it('updates grid size when changed');
    it('renders show metadata toggle');
    it('updates show metadata when toggled');
  });

  describe('notification settings', () => {
    it('renders email notifications toggle');
    it('updates email notifications when toggled');
    it('renders digest frequency selector');
    it('updates digest frequency when changed');
    it('disables frequency when email notifications off');
    it('renders push notifications toggle');
    it('updates push notifications when toggled');
  });

  describe('privacy settings', () => {
    it('renders default visibility selector');
    it('updates default visibility when changed');
    it('renders allow tagging toggle');
    it('updates allow tagging when toggled');
  });

  describe('preference updates', () => {
    it('calls API with correct nested path for theme');
    it('calls API with correct nested path for notifications.email.enabled');
    it('shows saving indicator during update');
    it('shows success snackbar after update');
    it('shows error state if update fails');
  });

  describe('reset to defaults', () => {
    it('calls reset API when clicked');
    it('reloads preferences after reset');
    it('shows success message after reset');
  });
});
```

**Test count: 32 tests**

---

### 6. `apps/web/src/theme/ThemeContext.test.tsx`

```typescript
describe('ThemeProvider', () => {
  describe('initial state', () => {
    it('defaults to dark mode');
    it('loads saved theme from localStorage');
    it('handles missing localStorage value');
    it('handles invalid localStorage value');
  });

  describe('toggleTheme', () => {
    it('switches from dark to light');
    it('switches from light to dark');
    it('persists new theme to localStorage');
  });

  describe('setTheme', () => {
    it('sets theme to dark');
    it('sets theme to light');
    it('persists specified theme to localStorage');
  });

  describe('MUI theme creation', () => {
    it('creates valid dark theme object');
    it('creates valid light theme object');
    it('applies correct palette for dark mode');
    it('applies correct palette for light mode');
    it('includes component overrides');
  });
});

describe('useThemeContext', () => {
  it('returns theme context values');
  it('throws error when used outside provider');
});
```

**Test count: 18 tests**

---

### 7. `apps/web/src/components/layout/UserMenu.test.tsx`

```typescript
describe('UserMenu', () => {
  describe('avatar display', () => {
    it('shows user avatar image when avatarUrl exists');
    it('shows initials when no avatarUrl');
    it('calculates initials from "John Doe" as "JD"');
    it('calculates initials from "John" as "J"');
    it('calculates initials from "john doe" as "JD" (case handling)');
    it('shows fallback for empty display name');
    it('shows fallback for undefined user');
  });

  describe('menu interaction', () => {
    it('opens menu on avatar click');
    it('closes menu on backdrop click');
    it('closes menu on menu item click');
    it('closes menu on escape key');
  });

  describe('user info display', () => {
    it('shows user display name in header');
    it('shows user email in header');
  });

  describe('menu items', () => {
    it('renders Profile menu item');
    it('navigates to /profile on Profile click');
    it('renders Settings menu item');
    it('navigates to /settings on Settings click');
    it('renders theme toggle item');
    it('renders Logout menu item');
  });

  describe('theme toggle', () => {
    it('shows DarkMode icon when in light mode');
    it('shows LightMode icon when in dark mode');
    it('calls toggleTheme on click');
    it('does not close menu on theme toggle');
  });

  describe('logout', () => {
    it('calls logout function on click');
    it('closes menu after logout');
  });
});
```

**Test count: 26 tests**

---

### 8. `apps/web/src/components/layout/SideNav.test.tsx`

```typescript
describe('SideNav', () => {
  describe('navigation items', () => {
    it('renders Home nav item');
    it('renders Libraries nav item (disabled)');
    it('renders Search nav item (disabled)');
    it('renders People nav item (disabled)');
    it('renders Tags nav item (disabled)');
    it('renders Settings nav item');
  });

  describe('active route highlighting', () => {
    it('highlights Home when on / route');
    it('highlights Settings when on /settings route');
    it('does not highlight disabled items');
  });

  describe('navigation behavior', () => {
    it('navigates to / on Home click');
    it('navigates to /settings on Settings click');
    it('does not navigate on disabled item click');
  });

  describe('disabled state', () => {
    it('shows disabled styling on Libraries');
    it('prevents click events on disabled items');
    it('shows cursor not-allowed on disabled items');
  });

  describe('mobile drawer', () => {
    it('renders temporary drawer on mobile');
    it('calls onClose when backdrop clicked');
    it('closes after navigation');
  });

  describe('desktop drawer', () => {
    it('renders permanent drawer on desktop');
    it('does not render close button');
    it('maintains open state');
  });

  describe('icons', () => {
    it('renders correct icon for each nav item');
  });
});
```

**Test count: 22 tests**

---

## P2 - Medium Priority Tests

### 9. `apps/web/src/components/common/ErrorBoundary.test.tsx`

```typescript
describe('ErrorBoundary', () => {
  describe('normal rendering', () => {
    it('renders children when no error');
  });

  describe('error catching', () => {
    it('catches errors from child components');
    it('displays error UI when error caught');
    it('shows error message');
    it('logs error to console');
  });

  describe('error recovery', () => {
    it('renders reset button');
    it('navigates to home on reset click');
    it('clears error state after reset');
  });
});
```

**Test count: 8 tests**

---

### 10. `apps/web/src/services/api/auth.api.test.ts`

```typescript
describe('authApi', () => {
  describe('getProviders', () => {
    it('calls GET /auth/providers');
    it('returns array of provider objects');
  });

  describe('getMe', () => {
    it('calls GET /auth/me');
    it('returns user object');
  });

  describe('refresh', () => {
    it('calls POST /auth/refresh with refresh token');
    it('returns new token pair');
  });

  describe('logout', () => {
    it('calls POST /auth/logout');
  });

  describe('getOAuthUrl', () => {
    it('builds correct URL for google provider');
    it('includes redirect URI');
    it('encodes parameters correctly');
  });
});
```

**Test count: 10 tests**

---

### 11. `apps/web/src/services/api/settings.api.test.ts`

```typescript
describe('settingsApi', () => {
  describe('getPreferences', () => {
    it('calls GET /users/preferences');
    it('returns preferences object');
  });

  describe('updatePreferences', () => {
    it('calls PATCH /users/preferences');
    it('sends partial update in body');
    it('returns updated preferences');
  });

  describe('resetPreferences', () => {
    it('calls POST /users/preferences/reset');
    it('returns default preferences');
  });

  describe('getFeatureFlags', () => {
    it('calls GET /settings/features');
    it('returns feature flags object');
  });

  describe('getTheme', () => {
    it('calls GET /users/preferences/theme');
    it('returns theme string');
  });
});
```

**Test count: 11 tests**

---

### 12. `apps/web/src/services/storage/token.storage.test.ts`

```typescript
describe('tokenStorage', () => {
  describe('access token', () => {
    it('getAccessToken reads from sessionStorage');
    it('setAccessToken writes to sessionStorage');
    it('removeAccessToken removes from sessionStorage');
  });

  describe('refresh token', () => {
    it('getRefreshToken reads from localStorage');
    it('setRefreshToken writes to localStorage');
    it('removeRefreshToken removes from localStorage');
  });

  describe('clear', () => {
    it('removes access token');
    it('removes refresh token');
  });

  describe('hasTokens', () => {
    it('returns true when both tokens exist');
    it('returns false when access token missing');
    it('returns false when refresh token missing');
    it('returns false when both tokens missing');
  });
});
```

**Test count: 12 tests**

---

## P3 - Low Priority Tests

### 13. `apps/web/src/pages/LoginPage.test.tsx`

```typescript
describe('LoginPage', () => {
  it('renders logo');
  it('renders welcome title');
  it('renders description text');
  it('renders Google login button');
  it('renders terms and privacy footer');
});
```

**Test count: 5 tests**

---

### 14. `apps/web/src/pages/HomePage.test.tsx`

```typescript
describe('HomePage', () => {
  it('renders personalized greeting with user name');
  it('renders greeting without name for anonymous');
  it('renders feature cards');
  it('shows disabled state on coming soon features');
  it('renders getting started section');
});
```

**Test count: 5 tests**

---

### 15. `apps/web/src/pages/ProfilePage.test.tsx`

```typescript
describe('ProfilePage', () => {
  it('renders user avatar');
  it('calculates initials correctly');
  it('renders user display name');
  it('renders user email');
  it('renders OAuth provider chip');
  it('maps provider name correctly (google → Google)');
  it('renders account ID');
  it('renders creation date formatted');
});
```

**Test count: 8 tests**

---

### 16. `apps/web/src/pages/NotFoundPage.test.tsx`

```typescript
describe('NotFoundPage', () => {
  it('renders 404 message');
  it('renders sad emoji icon');
  it('renders home button');
  it('navigates to home on button click');
});
```

**Test count: 4 tests**

---

### 17. `apps/web/src/components/layout/TopBar.test.tsx`

```typescript
describe('TopBar', () => {
  it('renders logo');
  it('renders app title');
  it('navigates to home on logo click');
  it('renders menu button on mobile');
  it('calls onMenuClick when menu button clicked');
  it('renders UserMenu when authenticated');
  it('renders login button when not authenticated');
});
```

**Test count: 7 tests**

---

### 18. `apps/web/src/components/layout/AppLayout.test.tsx`

```typescript
describe('AppLayout', () => {
  it('renders TopBar');
  it('renders SideNav');
  it('renders Outlet for nested routes');
  it('manages mobile drawer state');
  it('applies correct drawer width');
});
```

**Test count: 5 tests**

---

## Summary

| Priority | Files | Tests |
|----------|-------|-------|
| P0 | 4 | 69 |
| P1 | 4 | 98 |
| P2 | 4 | 41 |
| P3 | 6 | 34 |
| **Total** | **18** | **242** |

## Implementation Order

### Phase 1 (P0 - Critical)
1. `AuthContext.test.ts` - 27 tests
2. `client.test.ts` - 19 tests
3. `OAuthCallback.test.tsx` - 14 tests
4. `ProtectedRoute.test.tsx` - 9 tests

### Phase 2 (P1 - High)
5. `SettingsPage.test.tsx` - 32 tests
6. `ThemeContext.test.tsx` - 18 tests
7. `UserMenu.test.tsx` - 26 tests
8. `SideNav.test.tsx` - 22 tests

### Phase 3 (P2 - Medium)
9. `ErrorBoundary.test.tsx` - 8 tests
10. `auth.api.test.ts` - 10 tests
11. `settings.api.test.ts` - 11 tests
12. `token.storage.test.ts` - 12 tests

### Phase 4 (P3 - Low)
13. `LoginPage.test.tsx` - 5 tests
14. `HomePage.test.tsx` - 5 tests
15. `ProfilePage.test.tsx` - 8 tests
16. `NotFoundPage.test.tsx` - 4 tests
17. `TopBar.test.tsx` - 7 tests
18. `AppLayout.test.tsx` - 5 tests
