/**
 * PersonalAccessTokens — post-#260 (the identity-and-access DataTable
 * migration).
 *
 * Scope note, per docs/specs/datatable.md §17.8 / §18.5: table MECHANICS belong
 * to the shared component and are covered by `runDataTableConformanceSuite`;
 * none of them is re-tested here.
 *
 * What IS here is what this migration could break, plus the two rules issue
 * #260 puts on this surface specifically:
 *
 *   - **reveal-once stays reveal-once**: the raw token appears only in the
 *     creation dialog, never in the table, and the `tokenPrefix` column is
 *     `exportable: false` so no CSV can carry token material;
 *   - **revoking confirms, and the confirmation names the token** — a card's
 *     overflow menu puts Revoke one tap from a thumb, and there is no undo.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser } from '../../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../../components/datatable/__tests__/testUtils/layoutStubs';

vi.mock('../../../hooks/usePersonalAccessTokens', () => ({
  usePersonalAccessTokens: vi.fn(),
}));

import { PersonalAccessTokens } from '../../../components/settings/PersonalAccessTokens';
import { buildPatColumns, getTokenStatus } from '../../../components/settings/patTable';
import { usePersonalAccessTokens } from '../../../hooks/usePersonalAccessTokens';
import { api } from '../../../services/api';
import { exportColumns } from '../../../components/datatable';
import type { PersonalAccessToken, PatCreatedResponse } from '../../../types';

const mockUsePersonalAccessTokens = vi.mocked(usePersonalAccessTokens);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const activeToken: PersonalAccessToken = {
  id: 'pat-id-1',
  name: 'CI deploy',
  tokenPrefix: 'pat_ab12',
  durationValue: 30,
  durationUnit: 'days',
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  lastUsedAt: null,
  createdAt: new Date().toISOString(),
  revokedAt: null,
};

const expiredToken: PersonalAccessToken = {
  id: 'pat-id-2',
  name: 'Old Token',
  tokenPrefix: 'pat_cd34',
  durationValue: 7,
  durationUnit: 'days',
  expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  lastUsedAt: null,
  createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  revokedAt: null,
};

const revokedToken: PersonalAccessToken = {
  id: 'pat-id-3',
  name: 'Revoked Token',
  tokenPrefix: 'pat_ef56',
  durationValue: 90,
  durationUnit: 'days',
  expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
  lastUsedAt: null,
  createdAt: new Date().toISOString(),
  revokedAt: new Date(Date.now() - 3600000).toISOString(),
};

const mockCreatedResponse: PatCreatedResponse = {
  token: 'pat_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  id: 'pat-id-new',
  name: 'New Token',
  tokenPrefix: 'pat_abcd',
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  createdAt: new Date().toISOString(),
};

const mockFetchTokens = vi.fn();
const mockCreateToken = vi.fn();
const mockRevokeToken = vi.fn();

function hookResult(
  overrides: Partial<ReturnType<typeof usePersonalAccessTokens>> = {},
) {
  return {
    tokens: [] as PersonalAccessToken[],
    isLoading: false,
    error: null as string | null,
    fetchTokens: mockFetchTokens,
    createToken: mockCreateToken,
    revokeToken: mockRevokeToken,
    ...overrides,
  } as ReturnType<typeof usePersonalAccessTokens>;
}

function renderTokens() {
  return render(<PersonalAccessTokens />, { wrapperOptions: { user: mockUser } });
}

/**
 * Revoke is this table's only row action, so the grid renders it as a bare icon
 * button named "{label} for {row}" (docs/specs/datatable.md §5.5).
 */
function revokeControlName(tokenName: string) {
  return `Revoke for ${tokenName}`;
}

describe('PersonalAccessTokens', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    mockCreateToken.mockResolvedValue(mockCreatedResponse);
    mockRevokeToken.mockResolvedValue(undefined);
    mockUsePersonalAccessTokens.mockReturnValue(hookResult());
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  // =========================================================================
  // Rendering
  // =========================================================================

  describe('Rendering', () => {
    it('renders the section heading, description and Create Token button', () => {
      renderTokens();

      expect(screen.getByText('Personal Access Tokens')).toBeInTheDocument();
      expect(
        screen.getByText(/Create tokens to authenticate API requests without OAuth/i),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /create token/i })).toBeInTheDocument();
    });

    it('renders a row per token with its name, masked prefix and status', async () => {
      mockUsePersonalAccessTokens.mockReturnValue(
        hookResult({ tokens: [activeToken, expiredToken] }),
      );

      renderTokens();

      const grid = await screen.findByRole('grid', { name: /personal access tokens/i });
      await waitFor(() => {
        expect(within(grid).getByText('CI deploy')).toBeInTheDocument();
      });
      expect(within(grid).getByText('Old Token')).toBeInTheDocument();
      expect(within(grid).getByText('pat_ab12...')).toBeInTheDocument();
      expect(within(grid).getByText('Active')).toBeInTheDocument();
      expect(within(grid).getByText('Expired')).toBeInTheDocument();
    });

    it('renders the Revoked status chip', async () => {
      mockUsePersonalAccessTokens.mockReturnValue(hookResult({ tokens: [revokedToken] }));

      renderTokens();

      await waitFor(() => {
        expect(screen.getByText('Revoked')).toBeInTheDocument();
      });
    });

    it('shows the empty state when there are no tokens', async () => {
      renderTokens();

      await waitFor(() => {
        expect(screen.getByText(/No personal access tokens yet/i)).toBeInTheDocument();
      });
    });

    it('shows the error alert', async () => {
      mockUsePersonalAccessTokens.mockReturnValue(
        hookResult({ error: 'Failed to load tokens' }),
      );

      renderTokens();

      await waitFor(() => {
        expect(screen.getByText('Failed to load tokens')).toBeInTheDocument();
      });
    });

    it('does not unmount the table while a refetch is in flight', async () => {
      mockUsePersonalAccessTokens.mockReturnValue(
        hookResult({ tokens: [activeToken], isLoading: true }),
      );

      renderTokens();

      await waitFor(() => {
        expect(screen.getByText('CI deploy')).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Status derivation (pure)
  // =========================================================================

  describe('Status derivation (pure)', () => {
    it('ranks revoked over expired over active', () => {
      expect(getTokenStatus(activeToken)).toBe('active');
      expect(getTokenStatus(expiredToken)).toBe('expired');
      expect(getTokenStatus(revokedToken)).toBe('revoked');
      // A token that is BOTH revoked and expired reads as revoked.
      expect(getTokenStatus({ ...expiredToken, revokedAt: new Date().toISOString() })).toBe(
        'revoked',
      );
    });
  });

  // =========================================================================
  // SECURITY: token material never reaches an export
  // =========================================================================

  describe('Token material is not exportable', () => {
    it('declares the token-prefix column `exportable: false`', () => {
      const prefixColumn = buildPatColumns().find(
        (column) => column.id === 'tokenPrefix',
      );
      expect(prefixColumn).toBeDefined();
      expect(prefixColumn?.exportable).toBe(false);
    });

    it('excludes it from the CSV column set the exporter actually writes', () => {
      const columns = buildPatColumns();
      // The exporter's own selection, not a re-derivation of the rule.
      const exported = exportColumns(columns);
      expect(exported.map((column) => column.id)).not.toContain('tokenPrefix');
      // …and the rest of the table still exports, so this is a narrowing rule
      // rather than a disabled export.
      expect(exported.map((column) => column.id)).toEqual(
        expect.arrayContaining(['name', 'status', 'expiresAt']),
      );
    });

    it('is the only column withheld — nothing else here is secret material', () => {
      const withheld = buildPatColumns()
        .filter((column) => column.exportable === false)
        .map((column) => column.id);
      expect(withheld).toEqual(['tokenPrefix']);
    });
  });

  // =========================================================================
  // Reveal-once
  // =========================================================================

  describe('Reveal-once', () => {
    it('shows the raw token only in the creation dialog, never in the table', async () => {
      const user = userEvent.setup();
      renderTokens();

      await user.click(screen.getByRole('button', { name: /create token/i }));
      const nameInput = await screen.findByLabelText(/token name/i);
      await user.clear(nameInput);
      await user.type(nameInput, 'My Token');

      const createButtons = screen.getAllByRole('button', { name: /create token/i });
      await user.click(createButtons[createButtons.length - 1]);

      await waitFor(() => {
        expect(screen.getByText(/Personal Access Token Created/i)).toBeInTheDocument();
      });

      // The table itself has never been handed the raw value: the hook returns
      // only prefixes, and the reveal dialog is the sole surface that sees it.
      const grid = screen.queryByRole('grid', { name: /personal access tokens/i });
      if (grid) {
        expect(within(grid).queryByText(mockCreatedResponse.token)).not.toBeInTheDocument();
      }
    });
  });

  // =========================================================================
  // Destructive confirmation
  // =========================================================================

  describe('Revoking', () => {
    it('disables Revoke for an already-revoked or expired token', async () => {
      mockUsePersonalAccessTokens.mockReturnValue(hookResult({ tokens: [revokedToken] }));

      const { unmount } = renderTokens();
      expect(
        await screen.findByRole('button', { name: revokeControlName('Revoked Token') }),
      ).toBeDisabled();
      unmount();

      mockUsePersonalAccessTokens.mockReturnValue(hookResult({ tokens: [expiredToken] }));
      renderTokens();
      expect(
        await screen.findByRole('button', { name: revokeControlName('Old Token') }),
      ).toBeDisabled();
    });

    it('confirms, and the confirmation NAMES the token', async () => {
      mockUsePersonalAccessTokens.mockReturnValue(hookResult({ tokens: [activeToken] }));
      const user = userEvent.setup();

      renderTokens();
      await user.click(
        await screen.findByRole('button', { name: revokeControlName('CI deploy') }),
      );

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/revoke token\?/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/"CI deploy"/)).toBeInTheDocument();
      expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    });

    it('does nothing when the confirmation is cancelled', async () => {
      mockUsePersonalAccessTokens.mockReturnValue(hookResult({ tokens: [activeToken] }));
      const user = userEvent.setup();

      renderTokens();
      await user.click(
        await screen.findByRole('button', { name: revokeControlName('CI deploy') }),
      );

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

      expect(mockRevokeToken).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('revokes once the confirmation is accepted', async () => {
      mockUsePersonalAccessTokens.mockReturnValue(hookResult({ tokens: [activeToken] }));
      const user = userEvent.setup();

      renderTokens();
      await user.click(
        await screen.findByRole('button', { name: revokeControlName('CI deploy') }),
      );

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^revoke$/i }));

      await waitFor(() => {
        expect(mockRevokeToken).toHaveBeenCalledWith('pat-id-1');
      });
    });
  });

  // =========================================================================
  // Create dialog
  // =========================================================================

  describe('Create Token dialog', () => {
    it('opens and closes', async () => {
      const user = userEvent.setup();
      renderTokens();

      await user.click(screen.getByRole('button', { name: /create token/i }));
      expect(
        await screen.findByRole('dialog', { name: /create personal access token/i }),
      ).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /cancel/i }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('calls createToken on submit', async () => {
      const user = userEvent.setup();
      renderTokens();

      await user.click(screen.getByRole('button', { name: /create token/i }));
      const nameInput = await screen.findByLabelText(/token name/i);
      await user.clear(nameInput);
      await user.type(nameInput, 'My New Token');

      const createButtons = screen.getAllByRole('button', { name: /create token/i });
      await user.click(createButtons[createButtons.length - 1]);

      await waitFor(() => {
        expect(mockCreateToken).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Phone
  // =========================================================================

  describe('Phone layout (360px)', () => {
    it('keeps Revoke reachable from a card, still behind a naming confirmation', async () => {
      setInitialContainerWidth(360);
      mockUsePersonalAccessTokens.mockReturnValue(hookResult({ tokens: [activeToken] }));
      const user = userEvent.setup();

      renderTokens();

      const table = await screen.findByTestId('datatable');
      expect(table).toHaveAttribute('data-layout', 'mobile');

      await user.click(
        await screen.findByRole('button', { name: 'Row actions for CI deploy' }),
      );
      await user.click(await screen.findByRole('menuitem', { name: 'Revoke' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/"CI deploy"/)).toBeInTheDocument();
    });

    it('contains its own width — nothing forces the document sideways', async () => {
      setInitialContainerWidth(360);
      mockUsePersonalAccessTokens.mockReturnValue(hookResult({ tokens: [activeToken] }));

      renderTokens();

      const table = await screen.findByTestId('datatable');
      const styles = window.getComputedStyle(table);
      expect(styles.maxWidth).toBe('100%');
      expect(styles.minWidth).toBe('0px');
    });
  });
});
