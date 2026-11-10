import { CssBaseline } from '@mui/material';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { act, render } from '@testing-library/react';
import type { RenderOptions, RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import { MemoriahubWebHostProvider } from '../../src/core/headless/host.js';
import type { MemoriahubWebHost } from '../../src/core/headless/host.js';
import type { MemoriahubCircle, MemoriahubCircleRole, MemoriahubOwnerScopeValue } from '../../src/core/headless/owner-scope.js';
import { createFakeMemoriahubWebHost } from '../../src/core/testing/fake-host.js';

/** The user the wrapper signs in. */
export interface MockUser {
  id: string;
  email: string;
  displayName: string | null;
  roles: { name: string }[];
  permissions: string[];
  timezone: string | null;
}

export const mockUser: MockUser = {
  id: 'test-user-id',
  email: 'test@example.com',
  displayName: 'Test User',
  roles: [{ name: 'viewer' }],
  permissions: ['user_settings:read', 'user_settings:write'],
  timezone: null,
};

export const mockAdminUser: MockUser = {
  id: 'admin-user-id',
  email: 'admin@example.com',
  displayName: 'Admin User',
  roles: [{ name: 'admin' }],
  permissions: ['user_settings:read', 'user_settings:write', 'system_settings:read', 'system_settings:write', 'users:read', 'users:write', 'rbac:manage'],
  timezone: null,
};

const defaultCircle: MemoriahubCircle = {
  id: 'circle-1',
  name: "Test User's Library",
  description: null,
  ownerId: 'test-user-id',
  isPersonal: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/** Options of the wrapper. */
export interface WrapperOptions {
  route?: string;
  authenticated?: boolean;
  user?: MockUser | null;
  isLoading?: boolean;
  activeCircle?: MemoriahubCircle | null;
  activeCircleRole?: MemoriahubCircleRole | null;
  /** Fields of the owner scope to override (a test that needs a group scope). */
  ownerScope?: Partial<MemoriahubOwnerScopeValue>;
  /** Components for the host's slots. */
  slots?: MemoriahubWebHost['slots'];
  /** Feature flags. */
  features?: Partial<MemoriahubWebHost['features']>;
  /** The host's search surface. */
  search?: MemoriahubWebHost['search'];
}

let hostDefaults: WrapperOptions = {};

/** Sets options every following render uses until `resetTestHostDefaults` (a test that stubs a slot for all its renders). */
export function setTestHostDefaults(options: WrapperOptions): void {
  hostDefaults = options;
}

/** Clears {@link setTestHostDefaults}. */
export function resetTestHostDefaults(): void {
  hostDefaults = {};
}

/** Builds the host the wrapper provides. */
export function buildTestHost(rawOptions: WrapperOptions = {}): MemoriahubWebHost {
  const options = { ...hostDefaults, ...rawOptions };
  const {
    authenticated = true,
    user = mockUser,
    isLoading = false,
    activeCircle = defaultCircle,
    activeCircleRole = 'circle_admin',
  } = options;
  const ownerRole = activeCircleRole === 'circle_admin' ? 'admin' : activeCircleRole === 'collaborator' ? 'editor' : activeCircleRole;
  const scope = activeCircle
    ? {
        id: activeCircle.id,
        kind: activeCircle.isPersonal ? ('me' as const) : ('group' as const),
        name: activeCircle.name,
        description: activeCircle.description ?? null,
        role: ownerRole ?? null,
      }
    : null;
  const { host } = createFakeMemoriahubWebHost({
    principal: authenticated && user ? { id: user.id, permissions: user.permissions, roles: user.roles.map((r) => r.name), displayName: user.displayName, timeZone: user.timezone } : null,
    features: options.features,
    slots: options.slots,
    ownerScope: {
      scopes: scope ? [scope] : [],
      activeScope: scope?.kind === 'group' ? { kind: 'group', groupId: scope.id } : { kind: 'me' },
      activeOption: scope,
      activeRole: scope?.role ?? null,
      personalLibraryId: scope?.kind === 'me' ? scope.id : null,
      setActiveScope: vi.fn().mockResolvedValue(undefined),
      refreshScopes: vi.fn().mockResolvedValue(undefined),
      circles: activeCircle ? [activeCircle] : [],
      activeCircle,
      activeCircleId: activeCircle?.id ?? null,
      activeCircleRole,
      loading: false,
      setActiveCircle: vi.fn().mockResolvedValue(undefined),
      refreshCircles: vi.fn().mockResolvedValue(undefined),
      ...options.ownerScope,
    },
  });
  return { ...host, authLoading: isLoading, search: options.search };
}

function createWrapper(options: WrapperOptions = {}) {
  const { route = '/' } = options;
  const host = buildTestHost(options);
  const theme = createTheme();
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[route]}>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <MemoriahubWebHostProvider host={host}>{children}</MemoriahubWebHostProvider>
        </ThemeProvider>
      </MemoryRouter>
    );
  };
}

interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  wrapperOptions?: WrapperOptions;
}

/** Renders `ui` inside a router, an MUI theme and a fake host. */
export function renderWithProviders(ui: ReactElement, options: CustomRenderOptions = {}): RenderResult {
  const { wrapperOptions, ...renderOptions } = options;
  return render(ui, { wrapper: createWrapper(wrapperOptions), ...renderOptions });
}

/** Flushes queued promise continuations before the caller unmounts. */
export async function flushPendingAsyncWork(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export * from '@testing-library/react';
export { renderWithProviders as render };
