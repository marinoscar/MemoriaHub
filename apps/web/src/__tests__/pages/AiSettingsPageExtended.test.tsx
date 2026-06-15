/**
 * Extended coverage for AiSettingsPage — covers handlers and branches not
 * exercised in the primary AiSettingsPage.test.tsx:
 *
 *   handleSaveCredentials — save credentials, success message, error fallback
 *   handleRemoveCredentials — confirm dialog flow, success/error paths
 *   handleSaveSearchFeature — save search feature settings
 *   handleTestProvider — error path (throws)
 *   provider form controls — key change, base URL, enabled toggle
 *   search provider/model selects
 *   knownProviders (unconfigured provider display)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useAiSettings', () => ({
  useAiSettings: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import AiSettingsPage from '../../pages/Admin/AiSettingsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useAiSettings } from '../../hooks/useAiSettings';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseAiSettings = vi.mocked(useAiSettings);

// ---------------------------------------------------------------------------
// Default mock factories
// ---------------------------------------------------------------------------

function defaultPermissionsMock() {
  return {
    isAdmin: true,
    permissions: new Set(['ai_settings:read', 'ai_settings:write']),
    roles: new Set(['admin']),
    hasPermission: vi.fn().mockReturnValue(true),
    hasAnyPermission: vi.fn().mockReturnValue(true),
    hasAllPermissions: vi.fn().mockReturnValue(true),
    hasRole: vi.fn().mockReturnValue(true),
    hasAnyRole: vi.fn().mockReturnValue(true),
  };
}

function defaultSettingsMock() {
  return {
    settings: {
      providers: [
        {
          provider: 'openai',
          configured: true,
          enabled: true,
          last4: 'abcd',
          baseUrl: null,
        },
      ],
      knownProviders: [],
      features: {
        search: { provider: 'openai', model: 'gpt-4o' },
      },
      conversations: {
        archiveAfterDays: 30,
        deleteAfterArchiveDays: 30,
      },
    },
    loading: false,
    error: null,
    fetchSettings: vi.fn().mockResolvedValue(undefined),
    saveCredentials: vi.fn().mockResolvedValue(undefined),
    removeCredentials: vi.fn().mockResolvedValue(undefined),
    testProvider: vi.fn().mockResolvedValue({ ok: true }),
    getModels: vi.fn().mockResolvedValue(['gpt-4o', 'gpt-4']),
    saveSearchFeature: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------

describe('AiSettingsPage — extended coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(defaultPermissionsMock() as any);
    mockUseAiSettings.mockReturnValue(defaultSettingsMock() as any);
    // Ensure window.confirm is available (jsdom provides it but we want control)
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  // -------------------------------------------------------------------------
  describe('handleSaveCredentials', () => {
    it('calls saveCredentials with the provider name when Save is clicked', async () => {
      const mockSaveCredentials = vi.fn().mockResolvedValue(undefined);
      const mockFetchSettings = vi.fn().mockResolvedValue(undefined);

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        saveCredentials: mockSaveCredentials,
        fetchSettings: mockFetchSettings,
      } as any);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // There is a Save button for the openai provider
      const saveButtons = screen.getAllByRole('button', { name: /save/i });
      // Click the first Save button (provider save, not search feature save)
      await user.click(saveButtons[0]);

      await waitFor(() => {
        expect(mockSaveCredentials).toHaveBeenCalledWith(
          'openai',
          expect.objectContaining({ enabled: true }),
        );
      });
    });

    it('shows success message after saving credentials', async () => {
      const mockSaveCredentials = vi.fn().mockResolvedValue(undefined);

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        saveCredentials: mockSaveCredentials,
      } as any);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const saveButtons = screen.getAllByRole('button', { name: /save/i });
      await user.click(saveButtons[0]);

      await waitFor(() => {
        // MUI Snackbar renders the message text
        expect(screen.getByText(/credentials saved/i)).toBeInTheDocument();
      });
    });

    it('shows error snackbar when saveCredentials throws', async () => {
      const mockSaveCredentials = vi.fn().mockRejectedValue(new Error('Network error'));

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        saveCredentials: mockSaveCredentials,
      } as any);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const saveButtons = screen.getAllByRole('button', { name: /save/i });
      await user.click(saveButtons[0]);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText(/network error/i)).toBeInTheDocument();
      });
    });

    it('shows fallback error message when error is not an Error instance', async () => {
      const mockSaveCredentials = vi.fn().mockRejectedValue('plain string');

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        saveCredentials: mockSaveCredentials,
      } as any);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const saveButtons = screen.getAllByRole('button', { name: /save/i });
      await user.click(saveButtons[0]);

      await waitFor(() => {
        expect(screen.getByText(/failed to save credentials/i)).toBeInTheDocument();
      });
    });

    it('refreshes settings after successful save', async () => {
      const mockSaveCredentials = vi.fn().mockResolvedValue(undefined);
      const mockFetchSettings = vi.fn().mockResolvedValue(undefined);

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        saveCredentials: mockSaveCredentials,
        fetchSettings: mockFetchSettings,
      } as any);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const saveButtons = screen.getAllByRole('button', { name: /save/i });
      await user.click(saveButtons[0]);

      await waitFor(() => {
        // fetchSettings called once on mount + once after save
        expect(mockFetchSettings).toHaveBeenCalledTimes(2);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('handleRemoveCredentials', () => {
    it('calls removeCredentials when user confirms', async () => {
      const mockRemoveCredentials = vi.fn().mockResolvedValue(undefined);
      const mockFetchSettings = vi.fn().mockResolvedValue(undefined);

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        removeCredentials: mockRemoveCredentials,
        fetchSettings: mockFetchSettings,
      } as any);

      vi.spyOn(window, 'confirm').mockReturnValue(true);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const removeButton = screen.getByRole('button', { name: /remove/i });
      await user.click(removeButton);

      await waitFor(() => {
        expect(mockRemoveCredentials).toHaveBeenCalledWith('openai');
      });
    });

    it('does NOT call removeCredentials when user cancels the confirm dialog', async () => {
      const mockRemoveCredentials = vi.fn().mockResolvedValue(undefined);

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        removeCredentials: mockRemoveCredentials,
      } as any);

      vi.spyOn(window, 'confirm').mockReturnValue(false);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const removeButton = screen.getByRole('button', { name: /remove/i });
      await user.click(removeButton);

      expect(mockRemoveCredentials).not.toHaveBeenCalled();
    });

    it('shows success message after removing credentials', async () => {
      const mockRemoveCredentials = vi.fn().mockResolvedValue(undefined);

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        removeCredentials: mockRemoveCredentials,
      } as any);

      vi.spyOn(window, 'confirm').mockReturnValue(true);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /remove/i }));

      await waitFor(() => {
        expect(screen.getByText(/credentials removed/i)).toBeInTheDocument();
      });
    });

    it('shows error snackbar when removeCredentials throws', async () => {
      const mockRemoveCredentials = vi.fn().mockRejectedValue(new Error('Delete failed'));

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        removeCredentials: mockRemoveCredentials,
      } as any);

      vi.spyOn(window, 'confirm').mockReturnValue(true);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /remove/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText(/delete failed/i)).toBeInTheDocument();
      });
    });

    it('shows fallback error message when remove error is not an Error instance', async () => {
      const mockRemoveCredentials = vi.fn().mockRejectedValue('plain string');

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        removeCredentials: mockRemoveCredentials,
      } as any);

      vi.spyOn(window, 'confirm').mockReturnValue(true);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /remove/i }));

      await waitFor(() => {
        expect(screen.getByText(/failed to remove credentials/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('handleSaveSearchFeature', () => {
    it('calls saveSearchFeature with pre-populated provider and model when Save is clicked', async () => {
      const mockSaveSearchFeature = vi.fn().mockResolvedValue(undefined);
      const mockGetModels = vi.fn().mockResolvedValue(['gpt-4o', 'gpt-4']);

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        saveSearchFeature: mockSaveSearchFeature,
        getModels: mockGetModels,
      } as any);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Wait for models to be loaded (useEffect fires on mount)
      await waitFor(() => expect(mockGetModels).toHaveBeenCalled());

      // The Search Feature Save button (second Save button after provider Save)
      const saveButtons = await screen.findAllByRole('button', { name: /^save$/i });
      // Last save button is the one in the Search Feature section
      const searchFeatureSave = saveButtons[saveButtons.length - 1];
      await user.click(searchFeatureSave);

      await waitFor(() => {
        expect(mockSaveSearchFeature).toHaveBeenCalledWith('openai', 'gpt-4o');
      });
    });

    it('shows success message after saving search feature', async () => {
      const mockSaveSearchFeature = vi.fn().mockResolvedValue(undefined);
      const mockGetModels = vi.fn().mockResolvedValue(['gpt-4o']);

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        saveSearchFeature: mockSaveSearchFeature,
        getModels: mockGetModels,
      } as any);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => expect(mockGetModels).toHaveBeenCalled());

      const saveButtons = await screen.findAllByRole('button', { name: /^save$/i });
      await user.click(saveButtons[saveButtons.length - 1]);

      await waitFor(() => {
        expect(screen.getByText(/search feature settings saved/i)).toBeInTheDocument();
      });
    });

    it('shows error snackbar when saveSearchFeature throws', async () => {
      const mockSaveSearchFeature = vi.fn().mockRejectedValue(new Error('Feature save error'));
      const mockGetModels = vi.fn().mockResolvedValue(['gpt-4o']);

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        saveSearchFeature: mockSaveSearchFeature,
        getModels: mockGetModels,
      } as any);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => expect(mockGetModels).toHaveBeenCalled());

      const saveButtons = await screen.findAllByRole('button', { name: /^save$/i });
      await user.click(saveButtons[saveButtons.length - 1]);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText(/feature save error/i)).toBeInTheDocument();
      });
    });

    it('shows fallback error when saveSearchFeature throws non-Error', async () => {
      const mockSaveSearchFeature = vi.fn().mockRejectedValue('not an error');
      const mockGetModels = vi.fn().mockResolvedValue(['gpt-4o']);

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        saveSearchFeature: mockSaveSearchFeature,
        getModels: mockGetModels,
      } as any);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => expect(mockGetModels).toHaveBeenCalled());

      const saveButtons = await screen.findAllByRole('button', { name: /^save$/i });
      await user.click(saveButtons[saveButtons.length - 1]);

      await waitFor(() => {
        expect(screen.getByText(/failed to save search feature/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('handleTestProvider — error path', () => {
    it('shows error result when testProvider throws', async () => {
      const mockTestProvider = vi.fn().mockRejectedValue(new Error('Connection refused'));
      const mockGetModels = vi.fn().mockResolvedValue(['gpt-4o']);

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        testProvider: mockTestProvider,
        getModels: mockGetModels,
      } as any);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => expect(mockGetModels).toHaveBeenCalled());

      const testButton = await screen.findByRole('button', { name: /test/i });
      await user.click(testButton);

      await waitFor(() => {
        expect(screen.getByText(/connection refused/i)).toBeInTheDocument();
      });
    });

    it('shows fallback error when testProvider throws non-Error', async () => {
      const mockTestProvider = vi.fn().mockRejectedValue('unknown');
      const mockGetModels = vi.fn().mockResolvedValue(['gpt-4o']);

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        testProvider: mockTestProvider,
        getModels: mockGetModels,
      } as any);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => expect(mockGetModels).toHaveBeenCalled());

      const testButton = await screen.findByRole('button', { name: /test/i });
      await user.click(testButton);

      await waitFor(() => {
        expect(screen.getByText(/test failed/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('Provider form controls', () => {
    it('renders the New API Key input for each configured provider', () => {
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // "New API Key" label should exist
      expect(screen.getByLabelText(/new api key/i)).toBeInTheDocument();
    });

    it('renders the Base URL input for openai provider', () => {
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByLabelText(/base url/i)).toBeInTheDocument();
    });

    it('allows typing in the New API Key field', async () => {
      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const newKeyInput = screen.getByLabelText(/new api key/i);
      await user.type(newKeyInput, 'sk-new-key');

      expect((newKeyInput as HTMLInputElement).value).toBe('sk-new-key');
    });

    it('does NOT render Base URL input for anthropic provider', () => {
      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        settings: {
          providers: [
            { provider: 'anthropic', configured: true, enabled: true, last4: 'efgh', baseUrl: null },
          ],
          knownProviders: [],
          features: { search: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' } },
          conversations: { archiveAfterDays: 30, deleteAfterArchiveDays: 30 },
        },
      } as any);

      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Base URL field only appears for openai
      expect(screen.queryByLabelText(/base url/i)).not.toBeInTheDocument();
    });

    it('shows knownProviders (unconfigured) alongside configured ones', () => {
      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        settings: {
          providers: [
            { provider: 'openai', configured: true, enabled: true, last4: 'abcd', baseUrl: null },
          ],
          knownProviders: [
            { provider: 'anthropic', configured: false, enabled: false, last4: null, baseUrl: null },
          ],
          features: { search: { provider: 'openai', model: 'gpt-4o' } },
          conversations: { archiveAfterDays: 30, deleteAfterArchiveDays: 30 },
        },
      } as any);

      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('OPENAI')).toBeInTheDocument();
      expect(screen.getByText('ANTHROPIC')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('getModels — error path', () => {
    it('handles getModels failure gracefully (empty models list)', async () => {
      const mockGetModels = vi.fn().mockRejectedValue(new Error('Models unavailable'));

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        getModels: mockGetModels,
      } as any);

      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Should still render without crashing even if models fail to load
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /ai settings/i })).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('Features section with null search config', () => {
    it('handles features.search being null gracefully', () => {
      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        settings: {
          providers: [{ provider: 'openai', configured: true, enabled: true, last4: 'abcd', baseUrl: null }],
          knownProviders: [],
          features: { search: null },
          conversations: { archiveAfterDays: 7, deleteAfterArchiveDays: 14 },
        },
      } as any);

      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Should render without crashing even when search feature is null
      expect(screen.getByRole('heading', { name: /ai settings/i })).toBeInTheDocument();
      expect(screen.getByText(/search feature/i)).toBeInTheDocument();
    });
  });
});
