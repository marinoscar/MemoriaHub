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

vi.mock('../../hooks/useFaceSettings', () => ({
  useFaceSettings: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import FaceSettingsPage from '../../pages/Admin/FaceSettingsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useFaceSettings } from '../../hooks/useFaceSettings';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseFaceSettings = vi.mocked(useFaceSettings);

// ---------------------------------------------------------------------------
// Default mock values
// ---------------------------------------------------------------------------

function defaultPermissionsMock() {
  return {
    isAdmin: true,
    permissions: new Set(['face_settings:read', 'face_settings:write']),
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
          provider: 'compreface',
          configured: true,
          enabled: true,
          last4: 'abcd',
          baseUrl: 'http://cf:8000',
          region: null,
          capabilities: { detect: true, embed: true, delegatedRecognize: false },
        },
      ],
      knownProviders: [
        {
          provider: 'rekognition',
          configured: false,
          enabled: false,
          last4: null,
          baseUrl: null,
          region: null,
          capabilities: { detect: true, embed: false, delegatedRecognize: true },
        },
      ],
      features: {
        detection: { provider: 'compreface', model: 'arcface-r100-v1' },
      },
    },
    loading: false,
    error: null,
    fetchSettings: vi.fn().mockResolvedValue(undefined),
    saveCredentials: vi.fn().mockResolvedValue(undefined),
    removeCredentials: vi.fn().mockResolvedValue(undefined),
    testProvider: vi.fn().mockResolvedValue({ ok: true }),
    getModels: vi.fn().mockResolvedValue(['arcface-r100-v1']),
    saveDetectionFeature: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------

describe('FaceSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(defaultPermissionsMock() as any);
    mockUseFaceSettings.mockReturnValue(defaultSettingsMock() as any);
  });

  // -------------------------------------------------------------------------
  describe('Authorization', () => {
    it('redirects non-admin users (page content not shown)', () => {
      mockUsePermissions.mockReturnValue({
        ...defaultPermissionsMock(),
        isAdmin: false,
      } as any);

      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Navigate to "/" — page heading should not appear
      expect(screen.queryByRole('heading', { name: /face settings/i })).not.toBeInTheDocument();
    });

    it('renders the page heading for admin users', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('heading', { name: /face settings/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Loading state', () => {
    it('shows a circular progress spinner when loading with no settings yet', () => {
      mockUseFaceSettings.mockReturnValue({
        ...defaultSettingsMock(),
        loading: true,
        settings: null,
      } as any);

      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /face settings/i })).not.toBeInTheDocument();
    });

    it('still shows the page when loading is true but settings are already present', () => {
      mockUseFaceSettings.mockReturnValue({
        ...defaultSettingsMock(),
        loading: true,
        // settings is NOT null — previous load succeeded
      } as any);

      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // The loading guard only fires when settings === null
      expect(screen.getByRole('heading', { name: /face settings/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Error state', () => {
    it('shows an alert with the error message when error and no settings', () => {
      mockUseFaceSettings.mockReturnValue({
        ...defaultSettingsMock(),
        loading: false,
        settings: null,
        error: 'Failed to load face settings',
      } as any);

      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert.textContent).toContain('Failed to load face settings');
    });

    it('does not show the Face Settings heading when there is an error and no settings', () => {
      mockUseFaceSettings.mockReturnValue({
        ...defaultSettingsMock(),
        loading: false,
        settings: null,
        error: 'Something went wrong',
      } as any);

      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByRole('heading', { name: /face settings/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Configured provider display', () => {
    it('renders the masked API key (••••••••abcd) for a configured provider', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // The masked field value is ••••••••abcd (8 bullets + last4)
      expect(screen.getByDisplayValue(/••••.*abcd/)).toBeInTheDocument();
    });

    it('shows "CompreFace" provider name', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // CompreFace appears as the provider heading and in the detection feature Select
      const elements = screen.getAllByText('CompreFace');
      expect(elements.length).toBeGreaterThan(0);
    });

    it('shows "AWS Rekognition" for rekognition provider', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('AWS Rekognition')).toBeInTheDocument();
    });

    it('shows Enabled chip for enabled provider', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const enabledElements = screen.getAllByText('Enabled');
      expect(enabledElements.length).toBeGreaterThan(0);
    });

    it('shows Configured chip for configured provider', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Configured')).toBeInTheDocument();
    });

    it('shows Detect capability chip', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const detectChips = screen.getAllByText('Detect');
      expect(detectChips.length).toBeGreaterThan(0);
    });

    it('shows Embed capability chip for compreface (embed:true)', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Embed')).toBeInTheDocument();
    });

    it('shows Delegated Recognize capability chip for rekognition', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText('Delegated Recognize')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Detection Feature section', () => {
    it('renders the Detection Feature section heading', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/detection feature/i)).toBeInTheDocument();
    });

    it('renders the Test button', async () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Wait for models to load (useEffect fires on mount)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /test/i })).toBeInTheDocument();
      });
    });

    it('calls testProvider and shows Connection successful on click', async () => {
      const mockTestProvider = vi.fn().mockResolvedValue({ ok: true });
      const mockGetModels = vi.fn().mockResolvedValue(['arcface-r100-v1']);

      mockUseFaceSettings.mockReturnValue({
        ...defaultSettingsMock(),
        testProvider: mockTestProvider,
        getModels: mockGetModels,
      } as any);

      const user = userEvent.setup();
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Wait for models to be loaded so the Select is populated and detectionModel is set
      await waitFor(() => {
        expect(mockGetModels).toHaveBeenCalled();
      });

      // The settings have features.detection.model = 'arcface-r100-v1' — pre-populated
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
      const mockGetModels = vi.fn().mockResolvedValue(['arcface-r100-v1']);

      mockUseFaceSettings.mockReturnValue({
        ...defaultSettingsMock(),
        testProvider: mockTestProvider,
        getModels: mockGetModels,
      } as any);

      const user = userEvent.setup();
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => expect(mockGetModels).toHaveBeenCalled());

      const testButton = await screen.findByRole('button', { name: /test/i });
      await user.click(testButton);

      await waitFor(() => {
        expect(screen.getByText(/unauthorized/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('Save credentials', () => {
    it('renders a Save button for each provider section', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const saveButtons = screen.getAllByRole('button', { name: /save/i });
      expect(saveButtons.length).toBeGreaterThan(0);
    });

    it('renders a Remove button for configured providers', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Empty/no-providers state', () => {
    it('renders without crashing when providers array is empty', () => {
      mockUseFaceSettings.mockReturnValue({
        ...defaultSettingsMock(),
        settings: {
          providers: [],
          knownProviders: [
            {
              provider: 'compreface',
              configured: false,
              enabled: false,
              last4: null,
              baseUrl: null,
              region: null,
              capabilities: { detect: true, embed: true, delegatedRecognize: false },
            },
          ],
          features: { detection: { provider: null, model: null } },
        },
      } as any);

      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('heading', { name: /face settings/i })).toBeInTheDocument();
    });
  });
});
