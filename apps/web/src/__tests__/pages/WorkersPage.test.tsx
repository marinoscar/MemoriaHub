/**
 * Unit tests for WorkersPage — Node credentials section.
 *
 * Tests: the credentials table renders rows (name, prefix, owner, status);
 * "Never"/"—" placeholders; the create flow calls createCredential and reveals
 * the raw token exactly once (with the MEMORIAHUB_TOKEN warning), clearing it on
 * close; the revoke flow confirms then calls revokeCredential; non-admins are
 * redirected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';

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
import { usePermissions } from '../../hooks/usePermissions';
import { useWorkers } from '../../hooks/useWorkers';
import type { UseWorkersResult } from '../../hooks/useWorkers';
import { useNodeCredentials } from '../../hooks/useNodeCredentials';
import type { UseNodeCredentialsResult } from '../../hooks/useNodeCredentials';
import type {
  AdminNodeCredentialDto,
  CreatedNodeCredentialDto,
} from '../../services/workers';

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

// ---------------------------------------------------------------------------

describe('WorkersPage — Node credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(makePermissions(true));
    mockUseWorkers.mockReturnValue(makeWorkersHook());
    mockUseNodeCredentials.mockReturnValue(makeCredentialsHook());
  });

  // =========================================================================
  // Authorization
  // =========================================================================

  it('redirects non-admin users — page content not shown', () => {
    mockUsePermissions.mockReturnValue(makePermissions(false));

    render(<WorkersPage />, { wrapperOptions: { user: mockAdminUser } });

    expect(screen.queryByText(/node credentials/i)).not.toBeInTheDocument();
  });

  it('renders the Node credentials section heading for admins', async () => {
    render(<WorkersPage />, { wrapperOptions: { user: mockAdminUser } });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /node credentials/i })).toBeInTheDocument();
    });
  });

  // =========================================================================
  // List rendering
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

    render(<WorkersPage />, { wrapperOptions: { user: mockAdminUser } });

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

    render(<WorkersPage />, { wrapperOptions: { user: mockAdminUser } });

    await waitFor(() => {
      expect(screen.getByText('Never')).toBeInTheDocument();
    });
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows an empty-state message when there are no credentials', async () => {
    mockUseNodeCredentials.mockReturnValue(makeCredentialsHook({ credentials: [] }));

    render(<WorkersPage />, { wrapperOptions: { user: mockAdminUser } });

    await waitFor(() => {
      expect(screen.getByText(/no node credentials/i)).toBeInTheDocument();
    });
  });

  it('renders the credentials error alert when the list fails to load', async () => {
    mockUseNodeCredentials.mockReturnValue(
      makeCredentialsHook({ error: 'Credential load failed' }),
    );

    render(<WorkersPage />, { wrapperOptions: { user: mockAdminUser } });

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

    render(<WorkersPage />, { wrapperOptions: { user: mockAdminUser } });

    // Open the create dialog
    const createBtn = await screen.findByRole('button', { name: /create credential/i });
    await user.click(createBtn);

    // Fill in the name (expiry defaults to "Never expires")
    const nameField = await screen.findByLabelText(/name/i);
    await user.type(nameField, 'New worker');

    // Submit
    const submitBtn = await screen.findByRole('button', { name: /^create$/i });
    await user.click(submitBtn);

    // Hook mutation called with expiresAt null (never expires default) — this is
    // what invalidates/refreshes the list inside the real hook.
    await waitFor(() => {
      expect(createCredential).toHaveBeenCalledWith({ name: 'New worker', expiresAt: null });
    });

    // The reveal dialog shows the raw token + the MEMORIAHUB_TOKEN warning.
    await waitFor(() => {
      expect(screen.getByDisplayValue('nod_ab12_super_secret_raw_token')).toBeInTheDocument();
    });
    // Scope MEMORIAHUB_TOKEN to the reveal dialog — it also appears in the
    // section caption above the table.
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

    render(<WorkersPage />, { wrapperOptions: { user: mockAdminUser } });

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

    render(<WorkersPage />, { wrapperOptions: { user: mockAdminUser } });

    // Click the per-row revoke icon button
    const revokeIcon = await screen.findByRole('button', { name: /revoke credential/i });
    await user.click(revokeIcon);

    // Confirm dialog appears
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText(/revoke credential\?/i)).toBeInTheDocument();
    });

    // Confirm
    const confirmBtn = await screen.findByRole('button', { name: /^revoke$/i });
    await user.click(confirmBtn);

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

    render(<WorkersPage />, { wrapperOptions: { user: mockAdminUser } });

    const revokeIcon = await screen.findByRole('button', { name: /revoke credential/i });
    await user.click(revokeIcon);

    const cancelBtn = await screen.findByRole('button', { name: /cancel/i });
    await user.click(cancelBtn);

    expect(revokeCredential).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('hides the revoke action for an already-revoked credential', async () => {
    mockUseNodeCredentials.mockReturnValue(
      makeCredentialsHook({
        credentials: [makeCredential({ id: 'cred-revoked', revokedAt: '2026-07-10T00:00:00Z' })],
      }),
    );

    render(<WorkersPage />, { wrapperOptions: { user: mockAdminUser } });

    await waitFor(() => {
      expect(screen.getByText('Revoked')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /revoke credential/i })).not.toBeInTheDocument();
  });
});
