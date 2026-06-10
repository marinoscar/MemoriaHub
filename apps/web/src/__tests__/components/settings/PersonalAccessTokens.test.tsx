import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser } from '../../utils/test-utils';
import { PersonalAccessTokens } from '../../../components/settings/PersonalAccessTokens';
import type { PersonalAccessToken, PatCreatedResponse } from '../../../types';

// Mock the hook
vi.mock('../../../hooks/usePersonalAccessTokens', () => ({
  usePersonalAccessTokens: vi.fn(),
}));

import { usePersonalAccessTokens } from '../../../hooks/usePersonalAccessTokens';

const mockUsePersonalAccessTokens = vi.mocked(usePersonalAccessTokens);

// Mock data
const activeToken: PersonalAccessToken = {
  id: 'pat-id-1',
  name: 'CI Pipeline',
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
  expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // yesterday
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
  revokedAt: new Date(Date.now() - 3600000).toISOString(), // revoked 1 hour ago
};

const mockCreatedResponse: PatCreatedResponse = {
  token: 'pat_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  id: 'pat-id-new',
  name: 'New Token',
  tokenPrefix: 'pat_abcd',
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  createdAt: new Date().toISOString(),
};

describe('PersonalAccessTokens', () => {
  const mockFetchTokens = vi.fn();
  const mockCreateToken = vi.fn();
  const mockRevokeToken = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementation
    mockUsePersonalAccessTokens.mockReturnValue({
      tokens: [],
      isLoading: false,
      error: null,
      fetchTokens: mockFetchTokens,
      createToken: mockCreateToken.mockResolvedValue(mockCreatedResponse),
      revokeToken: mockRevokeToken.mockResolvedValue(undefined),
    });
  });

  // ============================================================================
  // Rendering
  // ============================================================================

  describe('Rendering', () => {
    it('should render the section heading', () => {
      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      expect(screen.getByText('Personal Access Tokens')).toBeInTheDocument();
    });

    it('should render the description text', () => {
      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      expect(
        screen.getByText(/Create tokens to authenticate API requests without OAuth/i),
      ).toBeInTheDocument();
    });

    it('should render a "Create Token" button', () => {
      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      expect(
        screen.getByRole('button', { name: /create token/i }),
      ).toBeInTheDocument();
    });

    it('should render token list when tokens exist', async () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [activeToken, expiredToken],
        isLoading: false,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      await waitFor(() => {
        expect(screen.getByText('CI Pipeline')).toBeInTheDocument();
        expect(screen.getByText('Old Token')).toBeInTheDocument();
      });
    });

    it('should render token prefixes with ellipsis', async () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [activeToken],
        isLoading: false,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      await waitFor(() => {
        expect(screen.getByText('pat_ab12...')).toBeInTheDocument();
      });
    });

    it('should display "Never" for lastUsedAt when null', async () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [activeToken],
        isLoading: false,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Never')).toBeInTheDocument();
      });
    });
  });

  // ============================================================================
  // Empty state
  // ============================================================================

  describe('Empty State', () => {
    it('should show empty state message when no tokens', async () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [],
        isLoading: false,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      await waitFor(() => {
        expect(
          screen.getByText(/No personal access tokens yet/i),
        ).toBeInTheDocument();
      });
    });

    it('should not show table when no tokens', () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [],
        isLoading: false,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });
  });

  // ============================================================================
  // Loading state
  // ============================================================================

  describe('Loading State', () => {
    it('should show loading spinner while loading', () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [],
        isLoading: true,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('should not show table when loading', () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [],
        isLoading: true,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });
  });

  // ============================================================================
  // Error state
  // ============================================================================

  describe('Error State', () => {
    it('should show error alert when error exists', async () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [],
        isLoading: false,
        error: 'Failed to load tokens',
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Failed to load tokens')).toBeInTheDocument();
      });
    });

    it('should not show error alert when error is null', () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [],
        isLoading: false,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  // ============================================================================
  // Token status chips
  // ============================================================================

  describe('Token Status', () => {
    it('should show "Active" chip for active tokens', async () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [activeToken],
        isLoading: false,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Active')).toBeInTheDocument();
      });
    });

    it('should show "Expired" chip for expired tokens', async () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [expiredToken],
        isLoading: false,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Expired')).toBeInTheDocument();
      });
    });

    it('should show "Revoked" chip for revoked tokens', async () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [revokedToken],
        isLoading: false,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Revoked')).toBeInTheDocument();
      });
    });
  });

  // ============================================================================
  // Create Token dialog
  // ============================================================================

  describe('Create Token Dialog', () => {
    it('should open create dialog when "Create Token" button is clicked', async () => {
      const user = userEvent.setup();

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      const createButton = screen.getByRole('button', { name: /create token/i });
      await user.click(createButton);

      await waitFor(() => {
        expect(
          screen.getByRole('dialog', { name: /create personal access token/i }),
        ).toBeInTheDocument();
      });
    });

    it('should close create dialog when cancel is clicked', async () => {
      const user = userEvent.setup();

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      const createButton = screen.getByRole('button', { name: /create token/i });
      await user.click(createButton);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      await user.click(cancelButton);

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('should call createToken when form is submitted in dialog', async () => {
      const user = userEvent.setup();

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      // Click top-level "Create Token" button (the second one if dialog is open)
      const createButtons = screen.getAllByRole('button', { name: /create token/i });
      await user.click(createButtons[0]);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      // Fill in the name field
      const nameInput = screen.getByLabelText(/token name/i);
      await user.clear(nameInput);
      await user.type(nameInput, 'My New Token');

      // Submit form - click the submit button inside the dialog
      const allCreateButtons = screen.getAllByRole('button', { name: /create token/i });
      // The last button is the submit button inside the dialog
      await user.click(allCreateButtons[allCreateButtons.length - 1]);

      await waitFor(() => {
        expect(mockCreateToken).toHaveBeenCalled();
      });
    });

    it('should open token reveal dialog after successful creation', async () => {
      const user = userEvent.setup();

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      const createButton = screen.getByRole('button', { name: /create token/i });
      await user.click(createButton);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      // Fill in the name field
      const nameInput = screen.getByLabelText(/token name/i);
      await user.clear(nameInput);
      await user.type(nameInput, 'My Token');

      // Submit
      const buttons = screen.getAllByRole('button', { name: /create token/i });
      await user.click(buttons[buttons.length - 1]);

      await waitFor(() => {
        expect(screen.getByText(/Personal Access Token Created/i)).toBeInTheDocument();
      });
    });
  });

  // ============================================================================
  // Revoke button
  // ============================================================================

  describe('Revoke Button', () => {
    it('should render revoke button for each token', async () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [activeToken, expiredToken],
        isLoading: false,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      await waitFor(() => {
        const revokeButtons = screen.getAllByRole('button', { name: /revoke/i });
        expect(revokeButtons).toHaveLength(2);
      });
    });

    it('should call revokeToken when Revoke button is clicked for active token', async () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [activeToken],
        isLoading: false,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      const user = userEvent.setup();

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      await waitFor(() => {
        expect(screen.getByText('CI Pipeline')).toBeInTheDocument();
      });

      const revokeButton = screen.getByRole('button', { name: /revoke/i });
      await user.click(revokeButton);

      await waitFor(() => {
        expect(mockRevokeToken).toHaveBeenCalledWith('pat-id-1');
      });
    });

    it('should disable revoke button for revoked tokens', async () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [revokedToken],
        isLoading: false,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Revoked Token')).toBeInTheDocument();
      });

      const revokeButton = screen.getByRole('button', { name: /revoke/i });
      expect(revokeButton).toBeDisabled();
    });

    it('should disable revoke button for expired tokens', async () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [expiredToken],
        isLoading: false,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Old Token')).toBeInTheDocument();
      });

      const revokeButton = screen.getByRole('button', { name: /revoke/i });
      expect(revokeButton).toBeDisabled();
    });

    it('should show "Revoking..." while revoke is in progress', async () => {
      let resolveRevoke!: () => void;
      const revokePromise = new Promise<void>((r) => { resolveRevoke = r; });
      mockRevokeToken.mockReturnValue(revokePromise);

      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [activeToken],
        isLoading: false,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      const user = userEvent.setup();

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      await waitFor(() => {
        expect(screen.getByText('CI Pipeline')).toBeInTheDocument();
      });

      const revokeButton = screen.getByRole('button', { name: /revoke/i });
      await user.click(revokeButton);

      expect(screen.getByText('Revoking...')).toBeInTheDocument();

      // Resolve and cleanup
      resolveRevoke();
      await revokePromise;
    });
  });

  // ============================================================================
  // Table columns
  // ============================================================================

  describe('Table Columns', () => {
    it('should render table header columns', async () => {
      mockUsePersonalAccessTokens.mockReturnValue({
        tokens: [activeToken],
        isLoading: false,
        error: null,
        fetchTokens: mockFetchTokens,
        createToken: mockCreateToken,
        revokeToken: mockRevokeToken,
      });

      render(<PersonalAccessTokens />, {
        wrapperOptions: { user: mockUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Name')).toBeInTheDocument();
        expect(screen.getByText('Token Prefix')).toBeInTheDocument();
        expect(screen.getByText('Created')).toBeInTheDocument();
        expect(screen.getByText('Expires')).toBeInTheDocument();
        expect(screen.getByText('Last Used')).toBeInTheDocument();
        expect(screen.getByText('Status')).toBeInTheDocument();
        expect(screen.getByText('Actions')).toBeInTheDocument();
      });
    });
  });
});
