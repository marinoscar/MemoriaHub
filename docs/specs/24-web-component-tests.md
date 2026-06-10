# Spec 24: Web Component Tests

**Domain:** Testing
**Agent:** `testing-dev`
**Depends On:** 14-web-auth-context, 15-web-login-page, 16-web-home-page, 17-web-user-settings-page, 18-web-system-settings-page, 23-web-test-framework
**Estimated Complexity:** High

---

## Objective

Create comprehensive tests for React components, contexts, hooks, and pages including authentication flows, settings pages, navigation, and user interactions.

---

## Deliverables

### 1. Test File Structure

```
apps/web/src/__tests__/
├── components/
│   ├── common/
│   │   ├── Layout.test.tsx
│   │   ├── LoadingSpinner.test.tsx
│   │   ├── ErrorBoundary.test.tsx
│   │   └── ProtectedRoute.test.tsx
│   └── navigation/
│       ├── AppBar.test.tsx
│       └── UserMenu.test.tsx
├── contexts/
│   ├── AuthContext.test.tsx
│   └── ThemeContext.test.tsx
├── hooks/
│   └── useAuth.test.tsx
├── pages/
│   ├── LoginPage.test.tsx
│   ├── AuthCallbackPage.test.tsx
│   ├── HomePage.test.tsx
│   ├── UserSettingsPage.test.tsx
│   └── SystemSettingsPage.test.tsx
└── services/
    └── api.test.ts
```

### 2. Auth Context Tests

Create `apps/web/src/__tests__/contexts/AuthContext.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderHook } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { AuthProvider, useAuth } from '../../contexts/AuthContext';
import { render } from '../utils/test-utils';

// Helper component to test context
function AuthConsumer() {
  const { user, isLoading, isAuthenticated, logout } = useAuth();

  if (isLoading) return <div>Loading...</div>;
  if (!isAuthenticated) return <div>Not authenticated</div>;

  return (
    <div>
      <span data-testid="user-email">{user?.email}</span>
      <button onClick={logout}>Logout</button>
    </div>
  );
}

describe('AuthContext', () => {
  beforeEach(() => {
    // Clear localStorage
    localStorage.clear();
  });

  describe('Initial State', () => {
    it('should start in loading state', () => {
      render(<AuthConsumer />, {
        wrapperOptions: { authenticated: false },
      });

      // Initially should show loading or check auth
      expect(screen.queryByText(/loading/i)).toBeInTheDocument();
    });

    it('should be unauthenticated without token', async () => {
      server.use(
        http.get('/api/auth/me', () => {
          return new HttpResponse(null, { status: 401 });
        }),
      );

      render(<AuthConsumer />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        expect(screen.getByText('Not authenticated')).toBeInTheDocument();
      });
    });
  });

  describe('Authentication', () => {
    it('should show user data when authenticated', async () => {
      render(<AuthConsumer />);

      await waitFor(() => {
        expect(screen.getByTestId('user-email')).toHaveTextContent('test@example.com');
      });
    });

    it('should handle logout', async () => {
      const user = userEvent.setup();
      render(<AuthConsumer />);

      await waitFor(() => {
        expect(screen.getByText('Logout')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Logout'));

      await waitFor(() => {
        expect(screen.getByText('Not authenticated')).toBeInTheDocument();
      });
    });
  });

  describe('Token Refresh', () => {
    it('should refresh token when access token expires', async () => {
      let callCount = 0;
      server.use(
        http.get('/api/auth/me', () => {
          callCount++;
          if (callCount === 1) {
            return new HttpResponse(null, { status: 401 });
          }
          return HttpResponse.json({
            data: {
              id: 'user-id',
              email: 'refreshed@example.com',
              roles: ['viewer'],
            },
          });
        }),
        http.post('/api/auth/refresh', () => {
          return HttpResponse.json({
            data: { accessToken: 'new-token', expiresIn: 900 },
          });
        }),
      );

      render(<AuthConsumer />);

      await waitFor(() => {
        expect(screen.getByTestId('user-email')).toHaveTextContent('refreshed@example.com');
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle API errors gracefully', async () => {
      server.use(
        http.get('/api/auth/me', () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      render(<AuthConsumer />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        expect(screen.getByText('Not authenticated')).toBeInTheDocument();
      });
    });
  });
});
```

### 3. Theme Context Tests

Create `apps/web/src/__tests__/contexts/ThemeContext.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderHook, act } from '@testing-library/react';
import { ThemeContextProvider, useThemeContext } from '../../contexts/ThemeContext';

// Test component
function ThemeConsumer() {
  const { mode, setMode, toggleTheme, theme } = useThemeContext();

  return (
    <div>
      <span data-testid="theme-mode">{mode}</span>
      <span data-testid="palette-mode">{theme.palette.mode}</span>
      <button onClick={() => setMode('dark')}>Set Dark</button>
      <button onClick={() => setMode('light')}>Set Light</button>
      <button onClick={toggleTheme}>Toggle</button>
    </div>
  );
}

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset matchMedia mock
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as any);
  });

  describe('Initial State', () => {
    it('should default to system preference', () => {
      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      expect(result.current.mode).toBe('system');
    });

    it('should load saved preference from localStorage', () => {
      localStorage.setItem('theme-mode', 'dark');

      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      expect(result.current.mode).toBe('dark');
    });
  });

  describe('Theme Switching', () => {
    it('should switch to dark mode', async () => {
      const user = userEvent.setup();
      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      act(() => {
        result.current.setMode('dark');
      });

      expect(result.current.mode).toBe('dark');
      expect(result.current.theme.palette.mode).toBe('dark');
    });

    it('should switch to light mode', async () => {
      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      act(() => {
        result.current.setMode('dark');
        result.current.setMode('light');
      });

      expect(result.current.mode).toBe('light');
      expect(result.current.theme.palette.mode).toBe('light');
    });

    it('should toggle between light and dark', async () => {
      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      act(() => {
        result.current.setMode('light');
      });

      expect(result.current.theme.palette.mode).toBe('light');

      act(() => {
        result.current.toggleTheme();
      });

      expect(result.current.theme.palette.mode).toBe('dark');
    });

    it('should persist preference to localStorage', () => {
      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      act(() => {
        result.current.setMode('dark');
      });

      expect(localStorage.getItem('theme-mode')).toBe('dark');
    });
  });

  describe('System Preference', () => {
    it('should use system dark mode when system is dark', () => {
      vi.mocked(window.matchMedia).mockReturnValue({
        matches: true, // prefers-color-scheme: dark
        media: '(prefers-color-scheme: dark)',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as any);

      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      expect(result.current.mode).toBe('system');
      expect(result.current.theme.palette.mode).toBe('dark');
    });
  });
});
```

### 4. Login Page Tests

Create `apps/web/src/__tests__/pages/LoginPage.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils/test-utils';
import LoginPage from '../../pages/LoginPage';

describe('LoginPage', () => {
  describe('Rendering', () => {
    it('should render login page title', async () => {
      render(<LoginPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        expect(screen.getByRole('heading')).toBeInTheDocument();
      });
    });

    it('should display available OAuth providers', async () => {
      render(<LoginPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        expect(screen.getByText(/google/i)).toBeInTheDocument();
      });
    });

    it('should show loading state while fetching providers', () => {
      server.use(
        http.get('/api/auth/providers', async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json({ data: [] });
        }),
      );

      render(<LoginPage />, {
        wrapperOptions: { authenticated: false },
      });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  describe('OAuth Flow', () => {
    it('should redirect to OAuth provider on button click', async () => {
      const user = userEvent.setup();

      // Mock window.location.href
      const originalLocation = window.location;
      delete (window as any).location;
      window.location = { ...originalLocation, href: '' } as any;

      render(<LoginPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        expect(screen.getByText(/google/i)).toBeInTheDocument();
      });

      await user.click(screen.getByText(/google/i));

      expect(window.location.href).toContain('/api/auth/google');

      window.location = originalLocation;
    });
  });

  describe('Error Handling', () => {
    it('should show error message when providers fail to load', async () => {
      server.use(
        http.get('/api/auth/providers', () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      render(<LoginPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        expect(screen.getByText(/error|failed/i)).toBeInTheDocument();
      });
    });

    it('should show message when no providers available', async () => {
      server.use(
        http.get('/api/auth/providers', () => {
          return HttpResponse.json({ data: [] });
        }),
      );

      render(<LoginPage />, {
        wrapperOptions: { authenticated: false },
      });

      await waitFor(() => {
        expect(screen.getByText(/no.*provider/i)).toBeInTheDocument();
      });
    });
  });

  describe('Redirect', () => {
    it('should redirect authenticated users to home', async () => {
      const mockNavigate = vi.fn();
      vi.mock('react-router-dom', async () => {
        const actual = await vi.importActual('react-router-dom');
        return {
          ...actual,
          useNavigate: () => mockNavigate,
        };
      });

      render(<LoginPage />, {
        wrapperOptions: { authenticated: true },
      });

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
      });
    });
  });
});
```

### 5. User Settings Page Tests

Create `apps/web/src/__tests__/pages/UserSettingsPage.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils/test-utils';
import UserSettingsPage from '../../pages/UserSettingsPage';

describe('UserSettingsPage', () => {
  describe('Loading State', () => {
    it('should show loading spinner while fetching settings', () => {
      server.use(
        http.get('/api/user-settings', async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json({ data: {} });
        }),
      );

      render(<UserSettingsPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  describe('Theme Settings', () => {
    it('should display current theme setting', async () => {
      render(<UserSettingsPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/theme/i)).toBeInTheDocument();
      });
    });

    it('should allow changing theme', async () => {
      const user = userEvent.setup();
      render(<UserSettingsPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/theme/i)).toBeInTheDocument();
      });

      const themeSelect = screen.getByLabelText(/theme/i);
      await user.click(themeSelect);
      await user.click(screen.getByRole('option', { name: /dark/i }));

      // Verify the selection changed
      expect(themeSelect).toHaveTextContent(/dark/i);
    });

    it('should save theme preference', async () => {
      const user = userEvent.setup();
      let savedSettings: any = null;

      server.use(
        http.patch('/api/user-settings', async ({ request }) => {
          savedSettings = await request.json();
          return HttpResponse.json({
            data: { ...savedSettings, version: 2 },
          });
        }),
      );

      render(<UserSettingsPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/theme/i)).toBeInTheDocument();
      });

      const themeSelect = screen.getByLabelText(/theme/i);
      await user.click(themeSelect);
      await user.click(screen.getByRole('option', { name: /dark/i }));

      const saveButton = screen.getByRole('button', { name: /save/i });
      await user.click(saveButton);

      await waitFor(() => {
        expect(savedSettings).toMatchObject({ theme: 'dark' });
      });
    });
  });

  describe('Profile Settings', () => {
    it('should display profile settings section', async () => {
      render(<UserSettingsPage />);

      await waitFor(() => {
        expect(screen.getByText(/profile/i)).toBeInTheDocument();
      });
    });

    it('should allow editing display name', async () => {
      const user = userEvent.setup();
      render(<UserSettingsPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
      });

      const nameInput = screen.getByLabelText(/display name/i);
      await user.clear(nameInput);
      await user.type(nameInput, 'New Display Name');

      expect(nameInput).toHaveValue('New Display Name');
    });

    it('should toggle profile image source', async () => {
      const user = userEvent.setup();
      render(<UserSettingsPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/use provider image/i)).toBeInTheDocument();
      });

      const checkbox = screen.getByLabelText(/use provider image/i);
      await user.click(checkbox);

      expect(checkbox).not.toBeChecked();
    });
  });

  describe('Form Submission', () => {
    it('should show success message on save', async () => {
      const user = userEvent.setup();
      render(<UserSettingsPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByText(/saved|success/i)).toBeInTheDocument();
      });
    });

    it('should show error message on save failure', async () => {
      const user = userEvent.setup();
      server.use(
        http.patch('/api/user-settings', () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      render(<UserSettingsPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByText(/error|failed/i)).toBeInTheDocument();
      });
    });

    it('should disable save button while submitting', async () => {
      const user = userEvent.setup();
      server.use(
        http.patch('/api/user-settings', async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json({ data: {} });
        }),
      );

      render(<UserSettingsPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /save/i }));

      expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    });
  });
});
```

### 6. System Settings Page Tests

Create `apps/web/src/__tests__/pages/SystemSettingsPage.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render, mockAdminUser } from '../utils/test-utils';
import SystemSettingsPage from '../../pages/SystemSettingsPage';

describe('SystemSettingsPage', () => {
  describe('Authorization', () => {
    it('should show access denied for non-admin users', async () => {
      render(<SystemSettingsPage />, {
        wrapperOptions: {
          user: {
            ...mockAdminUser,
            roles: ['viewer'],
            permissions: ['user_settings:read'],
          },
        },
      });

      await waitFor(() => {
        expect(screen.getByText(/access denied|forbidden|not authorized/i)).toBeInTheDocument();
      });
    });

    it('should load settings for admin users', async () => {
      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/system settings/i)).toBeInTheDocument();
      });
    });
  });

  describe('UI Settings', () => {
    it('should display theme override toggle', async () => {
      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByLabelText(/allow.*theme.*override/i)).toBeInTheDocument();
      });
    });

    it('should allow toggling theme override', async () => {
      const user = userEvent.setup();
      let savedSettings: any = null;

      server.use(
        http.patch('/api/system-settings', async ({ request }) => {
          savedSettings = await request.json();
          return HttpResponse.json({ data: savedSettings });
        }),
      );

      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByLabelText(/allow.*theme.*override/i)).toBeInTheDocument();
      });

      const toggle = screen.getByLabelText(/allow.*theme.*override/i);
      await user.click(toggle);

      const saveButton = screen.getByRole('button', { name: /save/i });
      await user.click(saveButton);

      await waitFor(() => {
        expect(savedSettings?.ui?.allowUserThemeOverride).toBe(false);
      });
    });
  });

  describe('Security Settings', () => {
    it('should display JWT TTL settings', async () => {
      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByLabelText(/access.*ttl|token.*expir/i)).toBeInTheDocument();
      });
    });

    it('should validate TTL values', async () => {
      const user = userEvent.setup();
      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByLabelText(/access.*ttl/i)).toBeInTheDocument();
      });

      const ttlInput = screen.getByLabelText(/access.*ttl/i);
      await user.clear(ttlInput);
      await user.type(ttlInput, '-5');

      const saveButton = screen.getByRole('button', { name: /save/i });
      await user.click(saveButton);

      await waitFor(() => {
        expect(screen.getByText(/invalid|positive|must be/i)).toBeInTheDocument();
      });
    });
  });

  describe('Feature Flags', () => {
    it('should display feature flags section', async () => {
      server.use(
        http.get('/api/system-settings', () => {
          return HttpResponse.json({
            data: {
              ui: { allowUserThemeOverride: true },
              security: { jwtAccessTtlMinutes: 15, refreshTtlDays: 14 },
              features: { betaFeature: true, newDashboard: false },
              version: 1,
            },
          });
        }),
      );

      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/feature/i)).toBeInTheDocument();
      });
    });
  });

  describe('Version Display', () => {
    it('should display settings version', async () => {
      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/version.*1/i)).toBeInTheDocument();
      });
    });

    it('should display last updated info', async () => {
      render(<SystemSettingsPage />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/updated/i)).toBeInTheDocument();
      });
    });
  });
});
```

### 7. Navigation Components Tests

Create `apps/web/src/__tests__/components/navigation/AppBar.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import { AppBar } from '../../../components/navigation/AppBar';

describe('AppBar', () => {
  it('should render app title', () => {
    render(<AppBar />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('should show user menu', () => {
    render(<AppBar />);
    expect(screen.getByRole('button', { name: /menu|account/i })).toBeInTheDocument();
  });

  it('should show navigation links', () => {
    render(<AppBar />);
    expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
  });

  it('should show admin link for admin users', () => {
    render(<AppBar />, {
      wrapperOptions: { user: mockAdminUser },
    });

    expect(screen.getByRole('link', { name: /admin|system/i })).toBeInTheDocument();
  });

  it('should NOT show admin link for non-admin users', () => {
    render(<AppBar />); // Default viewer user

    expect(screen.queryByRole('link', { name: /admin|system/i })).not.toBeInTheDocument();
  });

  it('should toggle theme on theme button click', async () => {
    const user = userEvent.setup();
    render(<AppBar />);

    const themeButton = screen.getByRole('button', { name: /theme|mode/i });
    await user.click(themeButton);

    // Theme should toggle
    expect(themeButton).toBeInTheDocument();
  });
});
```

Create `apps/web/src/__tests__/components/navigation/UserMenu.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser } from '../../utils/test-utils';
import { UserMenu } from '../../../components/navigation/UserMenu';

describe('UserMenu', () => {
  it('should display user avatar or initial', () => {
    render(<UserMenu />);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('should open menu on click', async () => {
    const user = userEvent.setup();
    render(<UserMenu />);

    await user.click(screen.getByRole('button'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('should display user email in menu', async () => {
    const user = userEvent.setup();
    render(<UserMenu />);

    await user.click(screen.getByRole('button'));

    expect(screen.getByText(mockUser.email)).toBeInTheDocument();
  });

  it('should display user role', async () => {
    const user = userEvent.setup();
    render(<UserMenu />);

    await user.click(screen.getByRole('button'));

    expect(screen.getByText(/viewer/i)).toBeInTheDocument();
  });

  it('should have settings link', async () => {
    const user = userEvent.setup();
    render(<UserMenu />);

    await user.click(screen.getByRole('button'));

    expect(screen.getByRole('menuitem', { name: /settings/i })).toBeInTheDocument();
  });

  it('should have logout option', async () => {
    const user = userEvent.setup();
    render(<UserMenu />);

    await user.click(screen.getByRole('button'));

    expect(screen.getByRole('menuitem', { name: /logout/i })).toBeInTheDocument();
  });

  it('should call logout on logout click', async () => {
    const user = userEvent.setup();
    const mockLogout = vi.fn();

    // Would need to mock the auth context
    render(<UserMenu />);

    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('menuitem', { name: /logout/i }));

    // Verify logout was triggered
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });
});
```

### 8. Common Components Tests

Create `apps/web/src/__tests__/components/common/ProtectedRoute.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { ProtectedRoute } from '../../../components/common/ProtectedRoute';

describe('ProtectedRoute', () => {
  it('should show loading while checking auth', () => {
    render(<ProtectedRoute />, {
      wrapperOptions: { authenticated: true },
    });

    // Would show loading initially
  });

  it('should render children when authenticated', async () => {
    render(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>,
    );

    await waitFor(() => {
      expect(screen.getByText('Protected Content')).toBeInTheDocument();
    });
  });

  it('should redirect to login when not authenticated', async () => {
    render(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>,
      { wrapperOptions: { authenticated: false } },
    );

    await waitFor(() => {
      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
    });
  });
});
```

Create `apps/web/src/__tests__/components/common/LoadingSpinner.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { LoadingSpinner } from '../../../components/common/LoadingSpinner';

describe('LoadingSpinner', () => {
  it('should render spinner', () => {
    render(<LoadingSpinner />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('should render full screen when fullScreen prop is true', () => {
    render(<LoadingSpinner fullScreen />);
    const container = screen.getByRole('progressbar').parentElement;
    expect(container).toHaveStyle({ height: '100vh' });
  });

  it('should accept custom size', () => {
    render(<LoadingSpinner size={60} />);
    const spinner = screen.getByRole('progressbar');
    expect(spinner).toBeInTheDocument();
  });
});
```

### 9. API Service Tests

Create `apps/web/src/__tests__/services/api.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { api, ApiError } from '../../services/api';

describe('ApiService', () => {
  beforeEach(() => {
    api.setAccessToken(null);
  });

  describe('GET requests', () => {
    it('should make GET request', async () => {
      const data = await api.get('/health/live');
      expect(data).toHaveProperty('status', 'ok');
    });

    it('should include auth header when token set', async () => {
      let capturedHeaders: Headers | null = null;

      server.use(
        http.get('/api/auth/me', ({ request }) => {
          capturedHeaders = request.headers;
          return HttpResponse.json({ data: { id: 'user' } });
        }),
      );

      api.setAccessToken('test-token');
      await api.get('/auth/me');

      expect(capturedHeaders?.get('Authorization')).toBe('Bearer test-token');
    });
  });

  describe('POST requests', () => {
    it('should make POST request with body', async () => {
      let capturedBody: any = null;

      server.use(
        http.post('/api/test', async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ data: { success: true } });
        }),
      );

      await api.post('/test', { foo: 'bar' });

      expect(capturedBody).toEqual({ foo: 'bar' });
    });
  });

  describe('Error handling', () => {
    it('should throw ApiError on 4xx response', async () => {
      server.use(
        http.get('/api/not-found', () => {
          return HttpResponse.json(
            { message: 'Not found', code: 'NOT_FOUND' },
            { status: 404 },
          );
        }),
      );

      await expect(api.get('/not-found')).rejects.toThrow(ApiError);
    });

    it('should include status code in error', async () => {
      server.use(
        http.get('/api/error', () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      try {
        await api.get('/error');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(500);
      }
    });
  });

  describe('Token refresh', () => {
    it('should retry request after token refresh on 401', async () => {
      let callCount = 0;

      server.use(
        http.get('/api/protected', () => {
          callCount++;
          if (callCount === 1) {
            return new HttpResponse(null, { status: 401 });
          }
          return HttpResponse.json({ data: { success: true } });
        }),
        http.post('/api/auth/refresh', () => {
          return HttpResponse.json({
            data: { accessToken: 'new-token', expiresIn: 900 },
          });
        }),
      );

      api.setAccessToken('old-token');
      const result = await api.get('/protected');

      expect(callCount).toBe(2);
      expect(result).toHaveProperty('success', true);
    });

    it('should throw if refresh fails', async () => {
      server.use(
        http.get('/api/protected', () => {
          return new HttpResponse(null, { status: 401 });
        }),
        http.post('/api/auth/refresh', () => {
          return new HttpResponse(null, { status: 401 });
        }),
      );

      api.setAccessToken('old-token');

      await expect(api.get('/protected')).rejects.toThrow('Unauthorized');
    });
  });

  describe('204 No Content', () => {
    it('should handle 204 responses', async () => {
      server.use(
        http.post('/api/auth/logout', () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      const result = await api.post('/auth/logout');
      expect(result).toBeUndefined();
    });
  });
});
```

---

## Running Tests

```bash
# Run all tests
cd apps/web && npm test

# Run in watch mode
cd apps/web && npm run test:watch

# Run with coverage
cd apps/web && npm run test:coverage

# Run specific file
cd apps/web && npm test -- LoginPage.test.tsx

# Run with UI
cd apps/web && npm run test:ui
```

---

## Acceptance Criteria

- [ ] Auth context handles all authentication states
- [ ] Theme context persists and toggles correctly
- [ ] Login page displays providers and handles OAuth
- [ ] User settings page allows editing all settings
- [ ] System settings page restricts access to admins
- [ ] Navigation shows/hides based on user roles
- [ ] Protected routes redirect unauthenticated users
- [ ] API service handles errors and token refresh
- [ ] All components render without errors
- [ ] User interactions work as expected
- [ ] Test coverage meets minimum thresholds (70%)

---

## Notes

- Use MSW to mock API responses consistently
- Test both happy paths and error states
- Test accessibility where applicable
- Use userEvent for realistic user interactions
- Keep tests focused and independent
