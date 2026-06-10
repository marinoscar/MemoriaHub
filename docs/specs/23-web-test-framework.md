# Spec 23: Web Test Framework Setup

**Domain:** Testing
**Agent:** `testing-dev`
**Depends On:** 13-web-project-setup
**Estimated Complexity:** Medium

---

## Objective

Set up a comprehensive testing framework for the React frontend including Vitest configuration, React Testing Library setup, mock providers, and reusable test utilities for testing components, hooks, and contexts.

---

## Deliverables

### 1. Test Directory Structure

```
apps/web/
├── src/
│   └── __tests__/
│       ├── setup.ts
│       ├── utils/
│       │   ├── test-utils.tsx
│       │   ├── mock-providers.tsx
│       │   └── mock-api.ts
│       ├── mocks/
│       │   ├── handlers.ts
│       │   ├── server.ts
│       │   └── data.ts
│       └── components/
│           └── ... (component tests)
├── vitest.config.ts
└── package.json
```

### 2. Vitest Configuration

Update `apps/web/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules',
        'src/__tests__',
        '**/*.d.ts',
        '**/*.config.*',
        'src/main.tsx',
      ],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 70,
        statements: 70,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
```

### 3. Test Setup

Create `apps/web/src/__tests__/setup.ts`:

```typescript
import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, afterAll, vi } from 'vitest';
import { server } from './mocks/server';

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock window.scrollTo
Object.defineProperty(window, 'scrollTo', {
  writable: true,
  value: vi.fn(),
});

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Setup MSW server
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
```

### 4. Test Utilities

Create `apps/web/src/__tests__/utils/test-utils.tsx`:

```typescript
import React, { ReactElement, ReactNode } from 'react';
import { render, RenderOptions, RenderResult } from '@testing-library/react';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import { CssBaseline } from '@mui/material';
import { lightTheme, darkTheme } from '../../theme';
import { AuthProvider } from '../../contexts/AuthContext';
import { ThemeContextProvider } from '../../contexts/ThemeContext';

interface WrapperOptions {
  route?: string;
  theme?: 'light' | 'dark';
  authenticated?: boolean;
  user?: MockUser | null;
}

export interface MockUser {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  isActive: boolean;
}

export const mockUser: MockUser = {
  id: 'test-user-id',
  email: 'test@example.com',
  displayName: 'Test User',
  roles: ['viewer'],
  permissions: ['user_settings:read', 'user_settings:write'],
  isActive: true,
};

export const mockAdminUser: MockUser = {
  id: 'admin-user-id',
  email: 'admin@example.com',
  displayName: 'Admin User',
  roles: ['admin'],
  permissions: [
    'user_settings:read',
    'user_settings:write',
    'system_settings:read',
    'system_settings:write',
    'users:read',
    'users:write',
    'rbac:manage',
  ],
  isActive: true,
};

function createWrapper(options: WrapperOptions = {}) {
  const {
    route = '/',
    theme = 'light',
    authenticated = true,
    user = mockUser,
  } = options;

  return function Wrapper({ children }: { children: ReactNode }) {
    const selectedTheme = theme === 'light' ? lightTheme : darkTheme;

    return (
      <MemoryRouter initialEntries={[route]}>
        <ThemeProvider theme={selectedTheme}>
          <CssBaseline />
          <MockAuthProvider authenticated={authenticated} user={user}>
            {children}
          </MockAuthProvider>
        </ThemeProvider>
      </MemoryRouter>
    );
  };
}

// Mock Auth Provider for testing
interface MockAuthProviderProps {
  children: ReactNode;
  authenticated?: boolean;
  user?: MockUser | null;
}

function MockAuthProvider({
  children,
  authenticated = true,
  user = mockUser,
}: MockAuthProviderProps) {
  const contextValue = {
    user: authenticated ? user : null,
    isLoading: false,
    isAuthenticated: authenticated,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  };

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
}

// Import the actual context for proper typing
import { AuthContext } from '../../contexts/AuthContext';
import { vi } from 'vitest';

interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  wrapperOptions?: WrapperOptions;
}

export function renderWithProviders(
  ui: ReactElement,
  options: CustomRenderOptions = {},
): RenderResult {
  const { wrapperOptions, ...renderOptions } = options;

  return render(ui, {
    wrapper: createWrapper(wrapperOptions),
    ...renderOptions,
  });
}

// Re-export everything from testing library
export * from '@testing-library/react';
export { renderWithProviders as render };
```

### 5. Mock Providers

Create `apps/web/src/__tests__/utils/mock-providers.tsx`:

```typescript
import React, { ReactNode } from 'react';
import { vi } from 'vitest';
import { ThemeProvider } from '@mui/material/styles';
import { lightTheme, darkTheme } from '../../theme';

// Theme Context Mock
export const mockThemeContext = {
  mode: 'light' as const,
  theme: lightTheme,
  setMode: vi.fn(),
  toggleTheme: vi.fn(),
};

export function MockThemeProvider({
  children,
  mode = 'light',
}: {
  children: ReactNode;
  mode?: 'light' | 'dark';
}) {
  const theme = mode === 'light' ? lightTheme : darkTheme;
  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
}

// Auth Context Mock
export interface MockAuthContextValue {
  user: any | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: () => void;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

export const createMockAuthContext = (
  overrides: Partial<MockAuthContextValue> = {},
): MockAuthContextValue => ({
  user: null,
  isLoading: false,
  isAuthenticated: false,
  login: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
  refreshUser: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

// Snackbar/Notification Mock
export const mockSnackbar = {
  enqueueSnackbar: vi.fn(),
  closeSnackbar: vi.fn(),
};

// Router Mock Utilities
export const mockNavigate = vi.fn();
export const mockLocation = {
  pathname: '/',
  search: '',
  hash: '',
  state: null,
  key: 'default',
};

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => mockLocation,
  };
});
```

### 6. Mock API with MSW

Create `apps/web/src/__tests__/mocks/handlers.ts`:

```typescript
import { http, HttpResponse } from 'msw';

const API_BASE = '/api';

// Mock data
const mockUser = {
  id: 'test-user-id',
  email: 'test@example.com',
  displayName: 'Test User',
  profileImageUrl: null,
  roles: ['viewer'],
  permissions: ['user_settings:read', 'user_settings:write'],
  isActive: true,
  createdAt: new Date().toISOString(),
};

const mockUserSettings = {
  theme: 'system',
  profile: {
    displayName: null,
    useProviderImage: true,
    customImageUrl: null,
  },
  updatedAt: new Date().toISOString(),
  version: 1,
};

const mockSystemSettings = {
  ui: {
    allowUserThemeOverride: true,
  },
  security: {
    jwtAccessTtlMinutes: 15,
    refreshTtlDays: 14,
  },
  features: {},
  updatedAt: new Date().toISOString(),
  updatedBy: null,
  version: 1,
};

const mockProviders = [
  { name: 'google', authUrl: '/api/auth/google' },
];

export const handlers = [
  // Auth endpoints
  http.get(`${API_BASE}/auth/providers`, () => {
    return HttpResponse.json({ data: mockProviders });
  }),

  http.get(`${API_BASE}/auth/me`, () => {
    return HttpResponse.json({ data: mockUser });
  }),

  http.post(`${API_BASE}/auth/logout`, () => {
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${API_BASE}/auth/refresh`, () => {
    return HttpResponse.json({
      data: {
        accessToken: 'new-mock-token',
        expiresIn: 900,
      },
    });
  }),

  // User settings endpoints
  http.get(`${API_BASE}/user-settings`, () => {
    return HttpResponse.json({ data: mockUserSettings });
  }),

  http.put(`${API_BASE}/user-settings`, async ({ request }) => {
    const body = await request.json();
    return HttpResponse.json({
      data: {
        ...mockUserSettings,
        ...body,
        version: mockUserSettings.version + 1,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
    const body = await request.json();
    return HttpResponse.json({
      data: {
        ...mockUserSettings,
        ...body,
        version: mockUserSettings.version + 1,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  // System settings endpoints
  http.get(`${API_BASE}/system-settings`, () => {
    return HttpResponse.json({ data: mockSystemSettings });
  }),

  http.patch(`${API_BASE}/system-settings`, async ({ request }) => {
    const body = await request.json();
    return HttpResponse.json({
      data: {
        ...mockSystemSettings,
        ...body,
        version: mockSystemSettings.version + 1,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  // Users endpoints
  http.get(`${API_BASE}/users`, () => {
    return HttpResponse.json({
      data: [mockUser],
      meta: {
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      },
    });
  }),

  http.get(`${API_BASE}/users/:id`, ({ params }) => {
    if (params.id === mockUser.id) {
      return HttpResponse.json({ data: mockUser });
    }
    return new HttpResponse(null, { status: 404 });
  }),

  // Health endpoints
  http.get(`${API_BASE}/health/live`, () => {
    return HttpResponse.json({
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
      },
    });
  }),

  http.get(`${API_BASE}/health/ready`, () => {
    return HttpResponse.json({
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
        checks: {
          database: 'ok',
        },
      },
    });
  }),
];
```

### 7. MSW Server Setup

Create `apps/web/src/__tests__/mocks/server.ts`:

```typescript
import { setupServer } from 'msw/node';
import { handlers } from './handlers';

export const server = setupServer(...handlers);
```

### 8. Mock Data

Create `apps/web/src/__tests__/mocks/data.ts`:

```typescript
import { User, UserSettings, SystemSettings, AuthProvider } from '../../types';

export const mockUsers: User[] = [
  {
    id: 'user-1',
    email: 'viewer@example.com',
    displayName: 'Viewer User',
    profileImageUrl: null,
    roles: ['viewer'],
    permissions: ['user_settings:read'],
    isActive: true,
    createdAt: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'user-2',
    email: 'contributor@example.com',
    displayName: 'Contributor User',
    profileImageUrl: 'https://example.com/photo.jpg',
    roles: ['contributor'],
    permissions: ['user_settings:read', 'user_settings:write'],
    isActive: true,
    createdAt: '2024-01-02T00:00:00.000Z',
  },
  {
    id: 'user-3',
    email: 'admin@example.com',
    displayName: 'Admin User',
    profileImageUrl: null,
    roles: ['admin'],
    permissions: [
      'user_settings:read',
      'user_settings:write',
      'system_settings:read',
      'system_settings:write',
      'users:read',
      'users:write',
      'rbac:manage',
    ],
    isActive: true,
    createdAt: '2024-01-03T00:00:00.000Z',
  },
  {
    id: 'user-4',
    email: 'inactive@example.com',
    displayName: 'Inactive User',
    profileImageUrl: null,
    roles: ['viewer'],
    permissions: [],
    isActive: false,
    createdAt: '2024-01-04T00:00:00.000Z',
  },
];

export const mockUserSettings: UserSettings = {
  theme: 'system',
  profile: {
    displayName: undefined,
    useProviderImage: true,
    customImageUrl: null,
  },
  updatedAt: '2024-01-01T00:00:00.000Z',
  version: 1,
};

export const mockSystemSettings: SystemSettings = {
  ui: {
    allowUserThemeOverride: true,
  },
  security: {
    jwtAccessTtlMinutes: 15,
    refreshTtlDays: 14,
  },
  features: {},
  updatedAt: '2024-01-01T00:00:00.000Z',
  updatedBy: null,
  version: 1,
};

export const mockAuthProviders: AuthProvider[] = [
  {
    name: 'google',
    authUrl: '/api/auth/google',
  },
];

// Helper to create variations
export function createMockUser(overrides: Partial<User> = {}): User {
  return {
    id: `user-${Date.now()}`,
    email: `user-${Date.now()}@example.com`,
    displayName: 'Mock User',
    profileImageUrl: null,
    roles: ['viewer'],
    permissions: ['user_settings:read'],
    isActive: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createMockUserSettings(
  overrides: Partial<UserSettings> = {},
): UserSettings {
  return {
    ...mockUserSettings,
    ...overrides,
  };
}
```

### 9. Custom Hook Testing Utilities

Create `apps/web/src/__tests__/utils/hook-utils.ts`:

```typescript
import { renderHook, RenderHookOptions, RenderHookResult } from '@testing-library/react';
import React, { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import { lightTheme } from '../../theme';

interface HookWrapperOptions {
  route?: string;
}

export function createHookWrapper(options: HookWrapperOptions = {}) {
  const { route = '/' } = options;

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[route]}>
        <ThemeProvider theme={lightTheme}>
          {children}
        </ThemeProvider>
      </MemoryRouter>
    );
  };
}

export function renderHookWithProviders<TResult, TProps>(
  hook: (props: TProps) => TResult,
  options: RenderHookOptions<TProps> & { wrapperOptions?: HookWrapperOptions } = {},
): RenderHookResult<TResult, TProps> {
  const { wrapperOptions, ...renderOptions } = options;

  return renderHook(hook, {
    wrapper: createHookWrapper(wrapperOptions),
    ...renderOptions,
  });
}
```

### 10. Package.json Test Scripts

Update `apps/web/package.json` scripts:

```json
{
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run",
    "test:watch": "vitest watch",
    "test:coverage": "vitest run --coverage",
    "test:ui": "vitest --ui",
    "test:ci": "vitest run --coverage --reporter=junit --outputFile=junit.xml"
  }
}
```

### 11. Additional Dependencies

Add to `apps/web/package.json` devDependencies:

```json
{
  "devDependencies": {
    "@testing-library/jest-dom": "^6.x",
    "@testing-library/react": "^14.x",
    "@testing-library/user-event": "^14.x",
    "@vitest/coverage-v8": "^1.x",
    "@vitest/ui": "^1.x",
    "jsdom": "^24.x",
    "msw": "^2.x",
    "vitest": "^1.x"
  }
}
```

### 12. TypeScript Configuration for Tests

Add to `apps/web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  }
}
```

Or create `apps/web/src/__tests__/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["**/*.ts", "**/*.tsx"]
}
```

---

## Usage Examples

### Testing a Component

```typescript
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils/test-utils';
import { UserMenu } from '../../components/navigation/UserMenu';

describe('UserMenu', () => {
  it('should display user name', () => {
    render(<UserMenu />);
    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  it('should show logout option', async () => {
    const { user } = render(<UserMenu />);
    await user.click(screen.getByRole('button'));
    expect(screen.getByText('Logout')).toBeInTheDocument();
  });
});
```

### Testing a Hook

```typescript
import { describe, it, expect } from 'vitest';
import { renderHookWithProviders } from '../utils/hook-utils';
import { useAuth } from '../../hooks/useAuth';

describe('useAuth', () => {
  it('should return user when authenticated', () => {
    const { result } = renderHookWithProviders(() => useAuth());
    expect(result.current.user).toBeDefined();
    expect(result.current.isAuthenticated).toBe(true);
  });
});
```

### Testing with Custom API Response

```typescript
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils/test-utils';
import { UserSettingsPage } from '../../pages/UserSettingsPage';

describe('UserSettingsPage', () => {
  it('should show error on API failure', async () => {
    server.use(
      http.get('/api/user-settings', () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    render(<UserSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText(/error/i)).toBeInTheDocument();
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

# Run with UI
cd apps/web && npm run test:ui

# Run specific test file
cd apps/web && npm test -- UserMenu.test.tsx
```

---

## Acceptance Criteria

- [ ] Vitest configured with jsdom environment
- [ ] React Testing Library setup complete
- [ ] MSW server mocks all API endpoints
- [ ] Custom render function includes all providers
- [ ] Mock user/admin available for auth testing
- [ ] Hook testing utilities work correctly
- [ ] Coverage reporting configured
- [ ] All global mocks working (matchMedia, ResizeObserver, etc.)
- [ ] TypeScript types resolve correctly in tests
- [ ] `npm test` runs without errors

---

## Notes

- Use MSW for API mocking instead of jest.mock
- Keep mock data consistent with API response types
- Use renderWithProviders for component tests
- Reset handlers between tests for isolation
- Consider using @vitest/ui for debugging
