/**
 * Unit tests for WorkersPage — post-#259 (the shared-DataTable migration).
 *
 * Scope note, per docs/specs/datatable.md §18.5: table MECHANICS live in
 * `runDataTableConformanceSuite`, not here. This file covers the two column
 * sets this page declares (`./workersTable.tsx`) and its own behaviour: the
 * fleet table's deregister flow, the credentials table's create/reveal/revoke
 * flow, permission gating, and the phone layout reaching both destructive
 * actions that used to sit in an off-screen last column.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../components/datatable/__tests__/testUtils/layoutStubs';

// ---------------------------------------------------------------------------
// Module mocks — must be declared BEFORE imports they affect
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useWorkers', () => ({
  useWorkers: vi.fn(),
}));

vi.mock('../../hooks/useNodeCredentials', () => ({
  useNodeCredentials: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import WorkersPage from '../../pages/Admin/WorkersPage';
import {
  buildNodeCredentialColumns,
  buildWorkerNodeColumns,
  credentialState,
} from '../../pages/Admin/workersTable';
import { usePermissions } from '../../hooks/usePermissions';
import { useWorkers } from '../../hooks/useWorkers';
import type { UseWorkersResult } from '../../hooks/useWorkers';
import { useNodeCredentials } from '../../hooks/useNodeCredentials';
import type { UseNodeCredentialsResult } from '../../hooks/useNodeCredentials';
import type {
  AdminNodeCredentialDto,
  CreatedNodeCredentialDto,
  WorkerNodeDto,
} from '../../services/workers';
import { api } from '../../services/api';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseWorkers = vi.mocked(useWorkers);
const mockUseNodeCredentials = vi.mocked(useNodeCredentials);

// ---------------------------------------------------------------------------
// Default mock factories
// ---------------------------------------------------------------------------

function makePermissions(isAdmin: boolean) {
  return {
    permissions: new Set<string>(),
    roles: new Set<string>(isAdmin ? ['admin'] : ['viewer']),
    hasPermission: vi.fn().mockReturnValue(isAdmin),
    hasAnyPermission: vi.fn().mockReturnValue(isAdmin),
    hasAllPermissions: vi.fn().mockReturnValue(isAdmin),
    hasRole: vi.fn().mockReturnValue(isAdmin),
    hasAnyRole: vi.fn().mockReturnValue(isAdmin),
    isAdmin,
  };
}

function makeWorkersHook(overrides: Partial<UseWorkersResult> = {}): UseWorkersResult {
  return {
    nodes: [],
    loading: false,
    error: null,
    autoRefresh: true,
    setAutoRefresh: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    deleteWorker: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeNode(overrides: Partial<WorkerNodeDto> = {}): WorkerNodeDto {
  return {
    id: 'node-uuid-1',
    name: 'gpu-box-1',
    hostname: 'gpu1.local',
    platform: 'linux-x64',
    cliVersion: '1.4.2',
    eligibleTypes: ['face_detection', 'auto_tagging'],
    concurrency: 2,
    status: 'online',
    capabilities: null,
    registeredAt: '2026-07-01T10:00:00Z',
    lastHeartbeatAt: '2026-07-16T10:00:00Z',
    createdById: 'user-uuid-1',
    health: 'healthy',
    jobCounts: { running: 1, succeeded: 42, failed: 0 },
    ...overrides,
  };
}

function makeCredentialsHook(
  overrides: Partial<UseNodeCredentialsResult> = {},
): UseNodeCredentialsResult {
  return {
    credentials: [],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    createCredential: vi.fn().mockResolvedValue(makeCreatedCredential()),
    revokeCredential: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeCredential(overrides: Partial<AdminNodeCredentialDto> = {}): AdminNodeCredentialDto {
  return {
    id: 'cred-uuid-1',
    name: 'GPU box 1',
    tokenPrefix: 'nod_ab12',
    expiresAt: null,
    lastUsedAt: null,
    createdAt: '2026-07-01T10:00:00Z',
    revokedAt: null,
    userId: 'user-uuid-1',
    ownerEmail: 'oscar@marin.cr',
    ownerDisplayName: 'Oscar',
    ...overrides,
  };
}

function makeCreatedCredential(
  overrides: Partial<CreatedNodeCredentialDto> = {},
): CreatedNodeCredentialDto {
  return {
    token: 'nod_ab12_super_secret_raw_token',
    id: 'cred-uuid-new',
    name: 'New worker',
    tokenPrefix: 'nod_ab12',
    expiresAt: null,
    createdAt: '2026-07-16T10:00:00Z',
    ...overrides,
  };
}

function renderPage() {
  return render(<WorkersPage />, { wrapperOptions: { user: mockAdminUser } });
}

// ---------------------------------------------------------------------------

describe('WorkersPage', () => {
  beforeAll(() => {
    // jsdom performs no layout; the shared stub recipe is what makes MUI X
    // render rows at all (docs/specs/datatable.md §12).
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    mockUsePermissions.mockReturnValue(makePermissions(true));
    mockUseWorkers.mockReturnValue(makeWorkersHook());
    mockUseNodeCredentials.mockReturnValue(makeCredentialsHook());
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  // =========================================================================
  // Authorization
  // =========================================================================

  it('redirects non-admin users — page content not shown', () => {
    mockUsePermissions.mockReturnValue(makePermissions(false));

    renderPage();

    expect(screen.queryByText(/node credentials/i)).not.toBeInTheDocument();
  });

  it('renders the Node credentials section heading for admins', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /node credentials/i })).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Column definitions
  // =========================================================================

  describe('Column definitions', () => {
    it('leads the fleet card with Node then Status (issue #259: status is primary)', () => {
      const primaries = buildWorkerNodeColumns()
        .filter((column) => column.priority === 'primary')
        .map((column) => column.id);
      expect(primaries).toEqual(['name', 'status']);
    });

    it('leads the credential card with Name then Status', () => {
      const primaries = buildNodeCredentialColumns()
        .filter((column) => column.priority === 'primary')
        .map((column) => column.id);
      expect(primaries).toEqual(['name', 'state']);
    });

    it('derives the credential state from revokedAt, then expiresAt', () => {
      expect(credentialState(makeCredential())).toBe('Active');
      expect(credentialState(makeCredential({ expiresAt: '2000-01-01T00:00:00Z' }))).toBe(
        'Expired',
      );
      expect(
        credentialState(
          makeCredential({ revokedAt: '2026-07-10T00:00:00Z', expiresAt: '2000-01-01T00:00:00Z' }),
        ),
      ).toBe('Revoked');
    });
  });

  // =========================================================================
  // Fleet table
  // =========================================================================

  describe('Worker node fleet', () => {
    it('renders a row per node with its name, hostname and status', async () => {
      mockUseWorkers.mockReturnValue(
        makeWorkersHook({
          nodes: [
            makeNode({ id: 'n1', name: 'gpu-box-1', status: 'online' }),
            makeNode({ id: 'n2', name: 'vps-2', hostname: 'vps2.local', status: 'offline' }),
          ],
        }),
      );

      renderPage();

      const grid = await screen.findByRole('grid', { name: /worker nodes/i });
      await waitFor(() => {
        expect(within(grid).getByText('gpu-box-1')).toBeInTheDocument();
      });
      expect(within(grid).getByText('vps2.local')).toBeInTheDocument();
      expect(within(grid).getByText('online')).toBeInTheDocument();
      expect(within(grid).getByText('offline')).toBeInTheDocument();
    });

    it('shows an empty-state message when no nodes are registered', async () => {
      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/no worker nodes registered/i)).toBeInTheDocument();
      });
    });

    it('surfaces the fleet error without blanking the rows underneath it', async () => {
      mockUseWorkers.mockReturnValue(
        makeWorkersHook({ nodes: [makeNode()], error: 'Fleet load failed' }),
      );

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/fleet load failed/i)).toBeInTheDocument();
      });
      expect(screen.getByText('gpu-box-1')).toBeInTheDocument();
    });

    it('deregisters a node after confirming', async () => {
      const deleteWorker = vi.fn().mockResolvedValue(undefined);
      mockUseWorkers.mockReturnValue(
        makeWorkersHook({ nodes: [makeNode({ id: 'node-doomed' })], deleteWorker }),
      );
      const user = userEvent.setup();

      renderPage();
      await user.click(
        await screen.findByRole('button', { name: /deregister node for gpu-box-1/i }),
      );

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/deregister worker node\?/i)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: /^deregister$/i }));

      await waitFor(() => {
        expect(deleteWorker).toHaveBeenCalledWith('node-doomed');
      });
      await waitFor(() => {
        expect(screen.getByText(/deregistered/i)).toBeInTheDocument();
      });
    });

    it('does not deregister when the confirmation is cancelled', async () => {
      const deleteWorker = vi.fn().mockResolvedValue(undefined);
      mockUseWorkers.mockReturnValue(
        makeWorkersHook({ nodes: [makeNode({ id: 'node-safe' })], deleteWorker }),
      );
      const user = userEvent.setup();

      renderPage();
      await user.click(
        await screen.findByRole('button', { name: /deregister node for gpu-box-1/i }),
      );

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

      expect(deleteWorker).not.toHaveBeenCalled();
    });

    it('keeps the auto-refresh toggle and reports it to the hook', async () => {
      const setAutoRefresh = vi.fn();
      mockUseWorkers.mockReturnValue(makeWorkersHook({ setAutoRefresh }));
      const user = userEvent.setup();

      renderPage();

      const toggle = await screen.findByRole('switch', { name: /auto-refresh/i });
      expect(toggle).toBeChecked();
      await user.click(toggle);
      expect(setAutoRefresh).toHaveBeenCalledWith(false);
    });
  });

  // =========================================================================
  // Credentials list rendering
  // =========================================================================

  it('renders a row for each credential with name, prefix, owner and status', async () => {
    mockUseNodeCredentials.mockReturnValue(
      makeCredentialsHook({
        credentials: [
          makeCredential({ id: 'c1', name: 'GPU box 1', tokenPrefix: 'nod_ab12', ownerEmail: 'a@example.com' }),
          makeCredential({ id: 'c2', name: 'GPU box 2', tokenPrefix: 'nod_cd34', ownerEmail: 'b@example.com', revokedAt: '2026-07-10T00:00:00Z' }),
        ],
      }),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('GPU box 1')).toBeInTheDocument();
      expect(screen.getByText('GPU box 2')).toBeInTheDocument();
    });

    expect(screen.getByText('nod_ab12…')).toBeInTheDocument();
    expect(screen.getByText('nod_cd34…')).toBeInTheDocument();
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
    expect(screen.getByText('b@example.com')).toBeInTheDocument();

    // Status chips: an active one and a revoked one
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
  });

  it('renders "Never" for a credential with no expiry and "—" for never-used', async () => {
    mockUseNodeCredentials.mockReturnValue(
      makeCredentialsHook({
        credentials: [makeCredential({ expiresAt: null, lastUsedAt: null })],
      }),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Never')).toBeInTheDocument();
    });
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows an empty-state message when there are no credentials', async () => {
    mockUseNodeCredentials.mockReturnValue(makeCredentialsHook({ credentials: [] }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/no node credentials/i)).toBeInTheDocument();
    });
  });

  it('renders the credentials error alert when the list fails to load', async () => {
    mockUseNodeCredentials.mockReturnValue(
      makeCredentialsHook({ error: 'Credential load failed' }),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/credential load failed/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Create flow
  // =========================================================================

  it('creates a credential and reveals the raw token exactly once', async () => {
    const created = makeCreatedCredential({ token: 'nod_ab12_super_secret_raw_token' });
    const createCredential = vi.fn().mockResolvedValue(created);
    mockUseNodeCredentials.mockReturnValue(makeCredentialsHook({ createCredential }));
    const user = userEvent.setup();

    renderPage();

    // Open the create dialog
    const createBtn = await screen.findByRole('button', { name: /create credential/i });
    await user.click(createBtn);

    // Fill in the name (expiry defaults to "Never expires")
    const nameField = await screen.findByLabelText(/name/i);
    await user.type(nameField, 'New worker');

    // Submit
    const submitBtn = await screen.findByRole('button', { name: /^create$/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(createCredential).toHaveBeenCalledWith({ name: 'New worker', expiresAt: null });
    });

    // The reveal dialog shows the raw token + the MEMORIAHUB_TOKEN warning.
    await waitFor(() => {
      expect(screen.getByDisplayValue('nod_ab12_super_secret_raw_token')).toBeInTheDocument();
    });
    const revealDialog = screen.getByRole('dialog');
    expect(within(revealDialog).getByText(/will not be shown again/i)).toBeInTheDocument();
    expect(within(revealDialog).getByText(/MEMORIAHUB_TOKEN/i)).toBeInTheDocument();

    // Closing the reveal dialog clears the token from the DOM (shown only once).
    const doneBtn = await screen.findByRole('button', { name: /done/i });
    await user.click(doneBtn);

    await waitFor(() => {
      expect(screen.queryByDisplayValue('nod_ab12_super_secret_raw_token')).not.toBeInTheDocument();
    });
  });

  it('disables the Create submit button until a name is entered', async () => {
    const user = userEvent.setup();

    renderPage();

    const createBtn = await screen.findByRole('button', { name: /create credential/i });
    await user.click(createBtn);

    const submitBtn = await screen.findByRole('button', { name: /^create$/i });
    expect(submitBtn).toBeDisabled();

    const nameField = await screen.findByLabelText(/name/i);
    await user.type(nameField, 'Some name');

    expect(submitBtn).toBeEnabled();
  });

  // =========================================================================
  // Revoke flow
  // =========================================================================

  it('revokes a credential after confirming in the dialog', async () => {
    const revokeCredential = vi.fn().mockResolvedValue(undefined);
    mockUseNodeCredentials.mockReturnValue(
      makeCredentialsHook({
        credentials: [makeCredential({ id: 'cred-to-revoke', name: 'Doomed', revokedAt: null })],
        revokeCredential,
      }),
    );
    const user = userEvent.setup();

    renderPage();

    // Per-row revoke control, now named after its row (§17.6)
    const revokeIcon = await screen.findByRole('button', { name: /revoke credential for doomed/i });
    await user.click(revokeIcon);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/revoke credential\?/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /^revoke$/i }));

    expect(revokeCredential).toHaveBeenCalledWith('cred-to-revoke');
  });

  it('does not call revokeCredential when the confirm dialog is cancelled', async () => {
    const revokeCredential = vi.fn().mockResolvedValue(undefined);
    mockUseNodeCredentials.mockReturnValue(
      makeCredentialsHook({
        credentials: [makeCredential({ id: 'cred-1', revokedAt: null })],
        revokeCredential,
      }),
    );
    const user = userEvent.setup();

    renderPage();

    const revokeIcon = await screen.findByRole('button', { name: /revoke credential/i });
    await user.click(revokeIcon);

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(revokeCredential).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('DISABLES (rather than hides) the revoke action for an already-revoked credential', async () => {
    mockUseNodeCredentials.mockReturnValue(
      makeCredentialsHook({
        credentials: [makeCredential({ id: 'cred-revoked', revokedAt: '2026-07-10T00:00:00Z' })],
      }),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Revoked')).toBeInTheDocument();
    });

    // The migration swapped "render nothing" for the contract's own per-row
    // `disabled`, which keeps the control (and its tooltip) discoverable
    // instead of silently vanishing.
    expect(screen.getByRole('button', { name: /revoke credential/i })).toBeDisabled();
  });

  // =========================================================================
  // Phone
  // =========================================================================

  describe('Phone layout (360px)', () => {
    it('reaches deregister and revoke from cards', async () => {
      setInitialContainerWidth(360);
      mockUseWorkers.mockReturnValue(makeWorkersHook({ nodes: [makeNode()] }));
      mockUseNodeCredentials.mockReturnValue(
        makeCredentialsHook({ credentials: [makeCredential({ name: 'Doomed' })] }),
      );
      const user = userEvent.setup();

      renderPage();

      const tables = await screen.findAllByTestId('datatable');
      tables.forEach((table) => expect(table).toHaveAttribute('data-layout', 'mobile'));

      // On a card, a single row action collapses into the overflow menu.
      await user.click(
        await screen.findByRole('button', { name: 'Row actions for gpu-box-1' }),
      );
      expect(await screen.findByRole('menuitem', { name: /deregister node/i })).toBeInTheDocument();
    });
  });
});
