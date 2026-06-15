import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — must be declared BEFORE the imports they affect
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useAiSettings', () => ({
  useAiSettings: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import AiSettingsPage from '../../pages/Admin/AiSettingsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useAiSettings } from '../../hooks/useAiSettings';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseAiSettings = vi.mocked(useAiSettings);

// ---------------------------------------------------------------------------
// Default mock values
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

describe('AiSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(defaultPermissionsMock() as any);
    mockUseAiSettings.mockReturnValue(defaultSettingsMock() as any);
  });

  // -------------------------------------------------------------------------
  describe('Authorization', () => {
    it('redirects non-admin users (page content not shown)', () => {
      mockUsePermissions.mockReturnValue({
        ...defaultPermissionsMock(),
        isAdmin: false,
      } as any);

      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Navigate to "/" — page heading should not appear
      expect(screen.queryByRole('heading', { name: /ai settings/i })).not.toBeInTheDocument();
    });

    it('renders the page heading for admin users', () => {
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('heading', { name: /ai settings/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Loading state', () => {
    it('shows a circular progress spinner when loading with no settings yet', () => {
      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        loading: true,
        settings: null,
      } as any);

      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /ai settings/i })).not.toBeInTheDocument();
    });

    it('still shows the page when loading is true but settings are already present', () => {
      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        loading: true,
        // settings is NOT null — previous load succeeded
      } as any);

      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // The loading guard only fires when settings === null
      expect(screen.getByRole('heading', { name: /ai settings/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Error state', () => {
    it('shows an alert with the error message when error and no settings', () => {
      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        loading: false,
        settings: null,
        error: 'Failed to load AI settings',
      } as any);

      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert.textContent).toContain('Failed to load AI settings');
    });

    it('does not show the AI Settings heading when there is an error and no settings', () => {
      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        loading: false,
        settings: null,
        error: 'Something went wrong',
      } as any);

      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByRole('heading', { name: /ai settings/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Configured provider display', () => {
    it('renders the masked API key (••••abcd) for a configured provider', () => {
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // The masked field value is ••••••••abcd (8 bullets + last4)
      expect(screen.getByDisplayValue(/••••.*abcd/)).toBeInTheDocument();
    });

    it('shows the provider name in uppercase', () => {
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('OPENAI')).toBeInTheDocument();
    });

    it('shows Enabled chip for enabled provider', () => {
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // MUI Chip renders the label text in a span; may appear in multiple elements
      // (e.g. the chip itself and an ARIA label). getAllByText is safe here.
      const enabledElements = screen.getAllByText('Enabled');
      expect(enabledElements.length).toBeGreaterThan(0);
    });

    it('shows Configured chip for configured provider', () => {
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Configured')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Search Feature section', () => {
    it('renders the Search Feature section heading', () => {
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/search feature/i)).toBeInTheDocument();
    });

    it('renders the Test button', async () => {
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Wait for models to load (useEffect fires on mount)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /test/i })).toBeInTheDocument();
      });
    });

    it('calls testProvider and shows Connection successful on click', async () => {
      const mockTestProvider = vi.fn().mockResolvedValue({ ok: true });
      const mockGetModels = vi.fn().mockResolvedValue(['gpt-4o', 'gpt-4']);

      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        testProvider: mockTestProvider,
        getModels: mockGetModels,
      } as any);

      const user = userEvent.setup();
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Wait for models to be loaded so the Select is populated and searchModel is set
      await waitFor(() => {
        expect(mockGetModels).toHaveBeenCalled();
      });

      // The settings have features.search.model = 'gpt-4o' — pre-populated
      // The Test button should be enabled after model is available
      const testButton = await screen.findByRole('button', { name: /test/i });

      await user.click(testButton);

      await waitFor(() => {
        expect(mockTestProvider).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(screen.getByText(/connection successful/i)).toBeInTheDocument();
      });
    });

    it('shows failure message when testProvider returns ok:false', async () => {
      const mockTestProvider = vi.fn().mockResolvedValue({ ok: false, error: 'Unauthorized' });
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
        expect(screen.getByText(/unauthorized/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('Conversation Retention section', () => {
    it('shows the archive and delete retention days from settings', () => {
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/archive after:/i)).toBeInTheDocument();
      // "30 days" appears twice (archive + delete), getAllByText is safe
      const dayMatches = screen.getAllByText(/30 days/i);
      expect(dayMatches.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('Save credentials', () => {
    it('renders a Save button for each configured provider', () => {
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // There should be at least one Save button (for openai) in the provider section
      const saveButtons = screen.getAllByRole('button', { name: /save/i });
      expect(saveButtons.length).toBeGreaterThan(0);
    });

    it('renders a Remove button for configured providers', () => {
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Empty/no-providers state', () => {
    it('renders without crashing when providers array is empty', () => {
      mockUseAiSettings.mockReturnValue({
        ...defaultSettingsMock(),
        settings: {
          providers: [],
          knownProviders: [{ provider: 'openai', configured: false, enabled: false, last4: null, baseUrl: null }],
          features: { search: { provider: null, model: null } },
          conversations: { archiveAfterDays: 30, deleteAfterArchiveDays: 30 },
        },
      } as any);

      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('heading', { name: /ai settings/i })).toBeInTheDocument();
    });
  });
});
