import { ReactElement, ReactNode } from 'react';
import { act, render, RenderOptions, RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CssBaseline } from '@mui/material';
import { vi } from 'vitest';

// Import AuthContext and ThemeContextProvider
import { AuthContext } from '../../contexts/AuthContext';
import { CircleContext } from '../../contexts/CircleContext';
import { ThemeContextProvider } from '../../contexts/ThemeContext';
import type { AuthProvider as AuthProviderType } from '../../types';
import type { Circle, CircleRole } from '../../types/circles';

interface WrapperOptions {
  route?: string;
  theme?: 'light' | 'dark';
  authenticated?: boolean;
  user?: MockUser | null;
  isLoading?: boolean;
  providers?: AuthProviderType[];
  activeCircle?: Circle | null;
  activeCircleRole?: CircleRole | null;
}

export interface MockUser {
  id: string;
  email: string;
  displayName: string | null;
  profileImageUrl: string | null;
  roles: { name: string }[];
  permissions: string[];
  isActive: boolean;
  createdAt: string;
  /** RAW stored IANA zone; `null` = never set (issue #444). */
  timezone: string | null;
}

export const mockUser: MockUser = {
  id: 'test-user-id',
  email: 'test@example.com',
  displayName: 'Test User',
  profileImageUrl: null,
  roles: [{ name: 'viewer' }],
  permissions: ['user_settings:read', 'user_settings:write'],
  isActive: true,
  createdAt: new Date().toISOString(),
  timezone: null,
};

export const mockAdminUser: MockUser = {
  id: 'admin-user-id',
  email: 'admin@example.com',
  displayName: 'Admin User',
  profileImageUrl: null,
  roles: [{ name: 'admin' }],
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
  createdAt: new Date().toISOString(),
  timezone: null,
};

// Default mock providers
const defaultMockProviders: AuthProviderType[] = [
  { name: 'google', authUrl: '/api/auth/google' },
];

const defaultMockCircle: Circle = {
  id: 'circle-1',
  name: "Test User's Library",
  description: null,
  ownerId: 'test-user-id',
  isPersonal: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// Mock Circle Provider for testing
interface MockCircleProviderProps {
  children: ReactNode;
  activeCircle?: Circle | null;
  activeCircleRole?: CircleRole | null;
}

function MockCircleProvider({
  children,
  activeCircle = defaultMockCircle,
  activeCircleRole = 'circle_admin',
}: MockCircleProviderProps) {
  const contextValue = {
    circles: activeCircle ? [activeCircle] : [],
    activeCircle,
    activeCircleId: activeCircle?.id ?? null,
    activeCircleRole,
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
  };

  return (
    <CircleContext.Provider value={contextValue}>
      {children}
    </CircleContext.Provider>
  );
}

// Mock Auth Provider for testing
interface MockAuthProviderProps {
  children: ReactNode;
  authenticated?: boolean;
  user?: MockUser | null;
  isLoading?: boolean;
  providers?: AuthProviderType[];
}

function MockAuthProvider({
  children,
  authenticated = true,
  user = mockUser,
  isLoading = false,
  providers = defaultMockProviders,
}: MockAuthProviderProps) {
  const contextValue = {
    user: authenticated ? user : null,
    isLoading,
    isAuthenticated: authenticated,
    providers,
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    refreshUser: vi.fn().mockResolvedValue(undefined),
    timezoneMismatch: null,
    applyDetectedTimezone: vi.fn().mockResolvedValue(undefined),
    dismissTimezoneMismatch: vi.fn(),
  };

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
}

function createWrapper(options: WrapperOptions = {}) {
  const {
    route = '/',
    authenticated = true,
    user = mockUser,
    isLoading = false,
    providers = defaultMockProviders,
    activeCircle = defaultMockCircle,
    activeCircleRole = 'circle_admin',
  } = options;

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[route]}>
        <ThemeContextProvider>
          <CssBaseline />
          <MockAuthProvider
            authenticated={authenticated}
            user={user}
            isLoading={isLoading}
            providers={providers}
          >
            <MockCircleProvider activeCircle={activeCircle} activeCircleRole={activeCircleRole}>
              {children}
            </MockCircleProvider>
          </MockAuthProvider>
        </ThemeContextProvider>
      </MemoryRouter>
    );
  };
}

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

/**
 * Flushes queued promise continuations (e.g. mocked service calls resolved
 * via `vi.fn().mockResolvedValue(...)`) before the caller unmounts, or before
 * Vitest's automatic `afterEach(cleanup)` (registered in `src/__tests__/setup.ts`)
 * tears down the rendered tree.
 *
 * Several component specs (the MediaDetailDrawer family in particular) render
 * a component whose hooks kick off fetches on mount and never await them
 * before the test body returns. If a fetch's `.then`/`finally` continuation
 * is still queued when the test FILE finishes, it fires later — potentially
 * during an unrelated, later test file sharing the same Vitest worker, after
 * that file's jsdom `window` has already been torn down. That's the exact
 * mechanism behind issue #196 (a stray continuation touching a torn-down
 * `window` inside `dispatchSetState`). The hook-level fix (`useIsMounted`)
 * stops that continuation from crashing, but the continuation itself would
 * still be dangling into the next file without this.
 *
 * Call this from a local `afterEach` in specs that render such components —
 * local `afterEach` hooks run before global ones registered via `setupFiles`
 * (Vitest/Jest run `afterEach` in LIFO order), so this settles pending work
 * while the component is still mounted, before the global `cleanup()` runs.
 */
export async function flushPendingAsyncWork(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// Re-export everything from testing library
export * from '@testing-library/react';
export { renderWithProviders as render };
