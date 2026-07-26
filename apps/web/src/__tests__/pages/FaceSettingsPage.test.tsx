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

vi.mock('../../hooks/useSystemSettings', () => ({
  useSystemSettings: vi.fn(),
}));

vi.mock('../../services/adminBackfill', () => ({
  runGlobalFaceBackfill: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import FaceSettingsPage from '../../pages/Admin/FaceSettingsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useFaceSettings } from '../../hooks/useFaceSettings';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { runGlobalFaceBackfill } from '../../services/adminBackfill';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseFaceSettings = vi.mocked(useFaceSettings);
const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockRunGlobalFaceBackfill = vi.mocked(runGlobalFaceBackfill);

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

function defaultSystemSettingsMock(faceRecognition = false) {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  return {
    settings: {
      features: {
        faceRecognition,
        autoTagging: false,
        burstDetection: false,
      },
    },
    isSaving: false,
    error: null,
    updateSettings,
    fetchSettings: vi.fn().mockResolvedValue(undefined),
  };
}

function defaultFaceSettingsMock() {
  return {
    settings: {
      providers: [
        {
          provider: 'compreface',
          configured: true,
          enabled: true,
          requiresCredentials: false,
          last4: null,
          baseUrl: 'http://compreface-core:3000',
          region: null,
          capabilities: { detect: true, embed: true },
        },
      ],
      // CompreFace is now the only face provider (issue #113 removed Human +
      // AWS Rekognition), so there are no other "known but unconfigured"
      // providers left to surface here.
      knownProviders: [],
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
    mockUseFaceSettings.mockReturnValue(defaultFaceSettingsMock() as any);
    mockUseSystemSettings.mockReturnValue(defaultSystemSettingsMock() as any);
    mockRunGlobalFaceBackfill.mockResolvedValue({ enqueued: 0, circles: 0 });
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
        ...defaultFaceSettingsMock(),
        loading: true,
        settings: null,
      } as any);

      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /face settings/i })).not.toBeInTheDocument();
    });

    it('still shows the page when loading is true but settings are already present', () => {
      mockUseFaceSettings.mockReturnValue({
        ...defaultFaceSettingsMock(),
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
        ...defaultFaceSettingsMock(),
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
        ...defaultFaceSettingsMock(),
        loading: false,
        settings: null,
        error: 'Something went wrong',
      } as any);

      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByRole('heading', { name: /face settings/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Global face recognition toggle', () => {
    it('renders the global face recognition switch', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/enable face recognition globally/i)).toBeInTheDocument();
    });

    it('switch reflects false when faceRecognition is disabled in sysSettings', () => {
      mockUseSystemSettings.mockReturnValue(defaultSystemSettingsMock(false) as any);

      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // The global toggle switch should be unchecked
      const switches = screen.getAllByRole('switch');
      const globalSwitch = switches.find((s) =>
        s.closest('label')?.textContent?.match(/enable face recognition globally/i),
      ) as HTMLInputElement | undefined;
      expect(globalSwitch).toBeDefined();
      expect(globalSwitch?.checked).toBe(false);
    });

    it('switch reflects true when faceRecognition is enabled in sysSettings', () => {
      mockUseSystemSettings.mockReturnValue(defaultSystemSettingsMock(true) as any);

      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const switches = screen.getAllByRole('switch');
      const globalSwitch = switches.find((s) =>
        s.closest('label')?.textContent?.match(/enable face recognition globally/i),
      ) as HTMLInputElement | undefined;
      expect(globalSwitch).toBeDefined();
      expect(globalSwitch?.checked).toBe(true);
    });

    it('calls updateSettings with faceRecognition:true when switch is toggled on', async () => {
      const mockUpdateSettings = vi.fn().mockResolvedValue(undefined);
      mockUseSystemSettings.mockReturnValue({
        ...defaultSystemSettingsMock(false),
        updateSettings: mockUpdateSettings,
      } as any);

      const user = userEvent.setup();
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Find and click the global face recognition switch
      const globalToggleLabel = screen.getByText(/enable face recognition globally/i);
      await user.click(globalToggleLabel);

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            features: expect.objectContaining({ faceRecognition: true }),
          }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('Global backfill button', () => {
    it('renders the Run Global Backfill button', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /run global backfill/i })).toBeInTheDocument();
    });

    it('disables Run Global Backfill button when faceRecognition is globally off', () => {
      mockUseSystemSettings.mockReturnValue(defaultSystemSettingsMock(false) as any);

      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /run global backfill/i })).toBeDisabled();
    });

    it('enables Run Global Backfill button when faceRecognition is globally on', () => {
      mockUseSystemSettings.mockReturnValue(defaultSystemSettingsMock(true) as any);

      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /run global backfill/i })).not.toBeDisabled();
    });

    it('calls runGlobalFaceBackfill when button clicked', async () => {
      mockUseSystemSettings.mockReturnValue(defaultSystemSettingsMock(true) as any);
      mockRunGlobalFaceBackfill.mockResolvedValue({ enqueued: 12, circles: 3 });

      const user = userEvent.setup();
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const btn = screen.getByRole('button', { name: /run global backfill/i });
      await user.click(btn);

      await waitFor(() => {
        expect(mockRunGlobalFaceBackfill).toHaveBeenCalledTimes(1);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('Configured provider display', () => {
    it('shows "CompreFace" provider name', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // CompreFace appears as the provider heading and in the detection feature Select
      const elements = screen.getAllByText('CompreFace');
      expect(elements.length).toBeGreaterThan(0);
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
      // Use exact name to avoid matching "Test connection" on provider cards
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^test$/i })).toBeInTheDocument();
      });
    });

    it('calls testProvider and shows Connection successful on click', async () => {
      const mockTestProvider = vi.fn().mockResolvedValue({ ok: true });
      const mockGetModels = vi.fn().mockResolvedValue(['arcface-r100-v1']);

      mockUseFaceSettings.mockReturnValue({
        ...defaultFaceSettingsMock(),
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
      // Use exact name to avoid matching "Test connection" on provider cards
      const testButton = await screen.findByRole('button', { name: /^test$/i });

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
        ...defaultFaceSettingsMock(),
        testProvider: mockTestProvider,
        getModels: mockGetModels,
      } as any);

      const user = userEvent.setup();
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => expect(mockGetModels).toHaveBeenCalled());

      // Use exact name to avoid matching "Test connection" on provider cards
      const testButton = await screen.findByRole('button', { name: /^test$/i });
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

    it('renders a Remove button for configured credentialed providers', () => {
      // CompreFace itself is keyless (requiresCredentials: false), so this
      // uses a synthetic credentialed provider purely to exercise the
      // generic "Remove" button code path for any provider that requires
      // credentials — it does not assert anything CompreFace/Rekognition
      // specific.
      mockUseFaceSettings.mockReturnValue({
        ...defaultFaceSettingsMock(),
        settings: {
          ...defaultFaceSettingsMock().settings,
          providers: [
            {
              provider: 'testprovider',
              configured: true,
              enabled: true,
              requiresCredentials: true,
              last4: 'zxcv',
              baseUrl: null,
              region: null,
              capabilities: { detect: true, embed: false },
            },
          ],
          knownProviders: [],
        },
      } as any);

      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
    });

    it('shows Service URL field for the compreface keyless provider', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByLabelText(/service url/i)).toBeInTheDocument();
    });

    it('shows Test connection button on the compreface card', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const testConnectionButtons = screen.getAllByRole('button', { name: /test connection/i });
      expect(testConnectionButtons.length).toBeGreaterThan(0);
    });

    it('shows "no API key required" text and no API key input for the keyless compreface provider', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/no api key required/i)).toBeInTheDocument();
      // The "New API Key" text field is only rendered for credentialed
      // providers — CompreFace is keyless and should never show it.
      expect(screen.queryByLabelText(/new api key/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Empty/no-providers state', () => {
    it('renders without crashing when providers array is empty', () => {
      mockUseFaceSettings.mockReturnValue({
        ...defaultFaceSettingsMock(),
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
              capabilities: { detect: true, embed: true },
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
