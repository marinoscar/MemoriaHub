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

vi.mock('../../hooks/useStorageProviders', () => ({
  useStorageProviders: vi.fn(),
}));

vi.mock('../../hooks/useStorageMigration', () => ({
  useStorageMigration: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import StorageProvidersPage from '../../pages/Admin/StorageProvidersPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useStorageProviders } from '../../hooks/useStorageProviders';
import { useStorageMigration } from '../../hooks/useStorageMigration';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseStorageProviders = vi.mocked(useStorageProviders);
const mockUseStorageMigration = vi.mocked(useStorageMigration);

// ---------------------------------------------------------------------------
// Default mock factories
// ---------------------------------------------------------------------------

function defaultPermissionsMock(overrides: Record<string, unknown> = {}) {
  return {
    isAdmin: true,
    permissions: new Set(['system_settings:read', 'system_settings:write']),
    roles: new Set(['admin']),
    hasPermission: vi.fn().mockReturnValue(true),
    hasAnyPermission: vi.fn().mockReturnValue(true),
    hasAllPermissions: vi.fn().mockReturnValue(true),
    hasRole: vi.fn().mockReturnValue(true),
    hasAnyRole: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

function makeProviderRow(overrides: Record<string, unknown> = {}) {
  return {
    provider: 's3',
    label: 'AWS S3',
    configured: true,
    enabled: true,
    requiresCredentials: true,
    accessKeyId: 'AKID1234',
    region: 'us-east-1',
    bucket: 'my-bucket',
    endpoint: null,
    last4: 'wxyz',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function defaultSettings() {
  return {
    providers: [
      makeProviderRow({ provider: 's3', label: 'AWS S3', last4: 'wxyz' }),
      makeProviderRow({ provider: 'r2', label: 'Cloudflare R2', last4: 'abcd', configured: true }),
      makeProviderRow({
        provider: 'local',
        label: 'Local Disk',
        requiresCredentials: false,
        last4: null,
        configured: true,
        accessKeyId: null,
        region: null,
        bucket: null,
      }),
    ],
    knownProviders: [],
    activeProvider: 's3',
  };
}

function defaultStorageProvidersMock() {
  return {
    settings: defaultSettings(),
    loading: false,
    error: null,
    testResults: {},
    testLoading: {},
    fetchSettings: vi.fn().mockResolvedValue(undefined),
    saveCredentials: vi.fn().mockResolvedValue(makeProviderRow()),
    removeCredentials: vi.fn().mockResolvedValue(undefined),
    testProvider: vi.fn().mockResolvedValue({ ok: true, bucket: 'my-bucket' }),
    setActive: vi.fn().mockResolvedValue({ activeProvider: 's3' }),
  };
}

function defaultMigrationMock() {
  return {
    runs: [],
    runsLoading: false,
    runsError: null,
    activeRun: null,
    starting: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    startMigration: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------

describe('StorageProvidersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(defaultPermissionsMock() as any);
    mockUseStorageProviders.mockReturnValue(defaultStorageProvidersMock() as any);
    mockUseStorageMigration.mockReturnValue(defaultMigrationMock() as any);
  });

  // -------------------------------------------------------------------------
  describe('Authorization', () => {
    it('redirects non-admin users (page heading not shown)', () => {
      mockUsePermissions.mockReturnValue({
        ...defaultPermissionsMock(),
        isAdmin: false,
      } as any);

      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByRole('heading', { name: /storage providers/i })).not.toBeInTheDocument();
    });

    it('renders the page heading for admin users', () => {
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('heading', { name: /storage providers/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Loading state', () => {
    it('shows a circular progress spinner when loading with no settings yet', () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        loading: true,
        settings: null,
      } as any);

      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /storage providers/i })).not.toBeInTheDocument();
    });

    it('still shows the page when loading is true but settings are already present', () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        loading: true,
        // settings is NOT null — previous load succeeded
      } as any);

      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('heading', { name: /storage providers/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Error state', () => {
    it('shows an alert with the error message when error and no settings', () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        loading: false,
        settings: null,
        error: 'Failed to load storage settings',
      } as any);

      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert.textContent).toContain('Failed to load storage settings');
    });
  });

  // -------------------------------------------------------------------------
  describe('Provider cards', () => {
    it('renders a card for each provider — AWS S3, Cloudflare R2, Local Disk', () => {
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      // Each provider name appears at least once (in card heading + possibly radio label)
      expect(screen.getAllByText('AWS S3').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Cloudflare R2').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Local Disk').length).toBeGreaterThan(0);
    });

    it('shows "Active" chip on the currently active provider', () => {
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      const activeChips = screen.getAllByText('Active');
      expect(activeChips.length).toBeGreaterThan(0);
    });

    it('shows Enabled chip for enabled providers', () => {
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      const enabledChips = screen.getAllByText('Enabled');
      expect(enabledChips.length).toBeGreaterThan(0);
    });

    it('shows Configured chip for configured providers', () => {
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      const configuredChips = screen.getAllByText('Configured');
      expect(configuredChips.length).toBeGreaterThan(0);
    });

    it('shows masked secret key for configured S3 provider with last4', () => {
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      // The masked field renders "••••••••wxyz"
      expect(screen.getByDisplayValue(/••••.*wxyz/)).toBeInTheDocument();
    });

    it('shows no-credentials alert for the Local Disk provider', () => {
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/no credentials required/i)).toBeInTheDocument();
    });

    it('shows Test connection buttons', () => {
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      const testButtons = screen.getAllByRole('button', { name: /test connection/i });
      expect(testButtons.length).toBeGreaterThan(0);
    });

    it('shows Save button for credentialed providers', () => {
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      const saveButtons = screen.getAllByRole('button', { name: /^save$/i });
      expect(saveButtons.length).toBeGreaterThan(0);
    });

    it('shows Remove button for configured credentialed providers', () => {
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      // Both S3 and R2 are configured
      const removeButtons = screen.getAllByRole('button', { name: /^remove$/i });
      expect(removeButtons.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('Test connection per card', () => {
    it('calls testProvider and shows success indicator on ok:true', async () => {
      const mockTestProvider = vi.fn().mockResolvedValue({ ok: true, bucket: 'my-bucket' });

      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        testProvider: mockTestProvider,
        // Pre-populate the test result so the result indicator renders
        testResults: { s3: { ok: true, bucket: 'my-bucket' } },
        testLoading: { s3: false },
      } as any);

      const user = userEvent.setup();
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      // Find the first "Test connection" button (belongs to S3 card)
      const testButtons = screen.getAllByRole('button', { name: /test connection/i });
      await user.click(testButtons[0]);

      await waitFor(() => {
        expect(mockTestProvider).toHaveBeenCalled();
      });
    });

    it('shows success text when testResult is ok:true', () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        testResults: { s3: { ok: true, bucket: 'my-bucket' } },
        testLoading: {},
      } as any);

      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      // The page renders "Connected — bucket: my-bucket" for S3
      expect(screen.getByText(/connected/i)).toBeInTheDocument();
    });

    it('shows error text when testResult is ok:false', () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        testResults: { s3: { ok: false, error: 'Invalid credentials' } },
        testLoading: {},
      } as any);

      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/invalid credentials/i)).toBeInTheDocument();
    });

    it('shows a spinner on the test button while loading', () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        testResults: {},
        testLoading: { s3: true },
      } as any);

      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      // The button's startIcon switches to CircularProgress when testLoading[provider] is true
      // The button itself becomes disabled; check it is disabled
      const testButtons = screen.getAllByRole('button', { name: /test connection/i });
      // The s3 button (first credentialed card) should be disabled while loading
      expect(testButtons[0]).toBeDisabled();
    });

    it('shows "Accessible" for Local Disk when test ok:true', () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        testResults: { local: { ok: true } },
        testLoading: {},
      } as any);

      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/accessible/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Active provider selector', () => {
    it('renders a radio group with each provider', () => {
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      const radios = screen.getAllByRole('radio');
      // 3 providers → 3 radios
      expect(radios.length).toBe(3);
    });

    it('has the current active provider pre-selected', () => {
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      // defaultSettings has activeProvider = 's3'
      const radios = screen.getAllByRole('radio');
      // The s3 radio corresponds to the first radio (provider order: s3, r2, local)
      expect(radios[0]).toBeChecked();
    });

    it('calls setActive when Save Active Provider is clicked after changing selection', async () => {
      const mockSetActive = vi.fn().mockResolvedValue({ activeProvider: 'r2' });
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        setActive: mockSetActive,
        fetchSettings: vi.fn().mockResolvedValue(undefined),
      } as any);

      const user = userEvent.setup();
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      // Select r2 radio
      const radios = screen.getAllByRole('radio');
      await user.click(radios[1]); // r2 is the second radio

      const saveActiveBtn = screen.getByRole('button', { name: /save active provider/i });
      await user.click(saveActiveBtn);

      await waitFor(() => {
        expect(mockSetActive).toHaveBeenCalledWith('r2');
      });
    });

    it('disables Save Active Provider button when selection matches current active provider', () => {
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      // Active is 's3', first radio is pre-selected → Save button disabled
      const saveActiveBtn = screen.getByRole('button', { name: /save active provider/i });
      expect(saveActiveBtn).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  describe('Migration panel', () => {
    it('renders Source and Target provider selects', () => {
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      // MUI Select renders the label in a <label> and also in a <span> inside the fieldset —
      // use getAllByText to tolerate either occurrence.
      expect(screen.getAllByText(/source provider/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/target provider/i).length).toBeGreaterThan(0);
    });

    it('Start Migration button is disabled until source and target are different', () => {
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      const startBtn = screen.getByRole('button', { name: /start migration/i });
      expect(startBtn).toBeDisabled();
    });

    it('opens confirmation dialog when Start Migration is clicked with valid source and target', async () => {
      const user = userEvent.setup();
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      // Open source select and pick 's3'
      const comboboxes = screen.getAllByRole('combobox');
      // First combobox = source, second = target
      await user.click(comboboxes[0]);
      const s3Option = await screen.findByRole('option', { name: /aws s3/i });
      await user.click(s3Option);

      // Open target select and pick 'r2'
      await user.click(comboboxes[1]);
      const r2Option = await screen.findByRole('option', { name: /cloudflare r2/i });
      await user.click(r2Option);

      const startBtn = screen.getByRole('button', { name: /start migration/i });
      await user.click(startBtn);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      expect(screen.getByText(/start migration\?/i)).toBeInTheDocument();
    });

    it('calls startMigration when dialog is confirmed', async () => {
      const mockStartMigration = vi.fn().mockResolvedValue(undefined);
      mockUseStorageMigration.mockReturnValue({
        ...defaultMigrationMock(),
        startMigration: mockStartMigration,
      } as any);

      const user = userEvent.setup();
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      // Select source and target
      const comboboxes = screen.getAllByRole('combobox');
      await user.click(comboboxes[0]);
      const s3Option = await screen.findByRole('option', { name: /aws s3/i });
      await user.click(s3Option);

      await user.click(comboboxes[1]);
      const r2Option = await screen.findByRole('option', { name: /cloudflare r2/i });
      await user.click(r2Option);

      await user.click(screen.getByRole('button', { name: /start migration/i }));

      // Confirm in dialog
      const confirmBtn = await screen.findByRole('button', { name: /^start migration$/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(mockStartMigration).toHaveBeenCalledWith('s3', 'r2');
      });
    });

    it('closes dialog without calling startMigration when Cancel is clicked', async () => {
      const mockStartMigration = vi.fn().mockResolvedValue(undefined);
      mockUseStorageMigration.mockReturnValue({
        ...defaultMigrationMock(),
        startMigration: mockStartMigration,
      } as any);

      const user = userEvent.setup();
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      const comboboxes = screen.getAllByRole('combobox');
      await user.click(comboboxes[0]);
      await user.click(await screen.findByRole('option', { name: /aws s3/i }));
      await user.click(comboboxes[1]);
      await user.click(await screen.findByRole('option', { name: /cloudflare r2/i }));
      await user.click(screen.getByRole('button', { name: /start migration/i }));

      // Click Cancel in dialog (first button is "Cancel")
      const dialogCancelBtn = await screen.findByRole('button', { name: /^cancel$/i });
      await user.click(dialogCancelBtn);

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });

      expect(mockStartMigration).not.toHaveBeenCalled();
    });

    it('shows migration progress when activeRun is in-flight', () => {
      const activeRun = {
        id: 'run-1',
        sourceProvider: 's3',
        targetProvider: 'r2',
        status: 'running',
        totalCount: 100,
        migratedCount: 45,
        failedCount: 0,
        skippedCount: 0,
        startedAt: '2024-01-01T00:00:00Z',
        finishedAt: null,
        lastError: null,
      };

      mockUseStorageMigration.mockReturnValue({
        ...defaultMigrationMock(),
        activeRun,
      } as any);

      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/migration in progress/i)).toBeInTheDocument();
      // Progress counters: "Copied: 45 / 100"
      expect(screen.getByText(/copied:/i)).toBeInTheDocument();
      expect(screen.getByText(/45 \/ 100/)).toBeInTheDocument();
      // LinearProgress should be rendered
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows Cancel Migration button while migration is running', () => {
      mockUseStorageMigration.mockReturnValue({
        ...defaultMigrationMock(),
        activeRun: {
          id: 'run-1',
          sourceProvider: 's3',
          targetProvider: 'r2',
          status: 'running',
          totalCount: 100,
          migratedCount: 10,
          failedCount: 0,
          skippedCount: 0,
          startedAt: '2024-01-01T00:00:00Z',
          finishedAt: null,
          lastError: null,
        },
      } as any);

      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('button', { name: /cancel migration/i })).toBeInTheDocument();
    });

    it('calls cancel() when Cancel Migration is clicked', async () => {
      const mockCancel = vi.fn().mockResolvedValue(undefined);

      mockUseStorageMigration.mockReturnValue({
        ...defaultMigrationMock(),
        activeRun: {
          id: 'run-1',
          sourceProvider: 's3',
          targetProvider: 'r2',
          status: 'running',
          totalCount: 100,
          migratedCount: 10,
          failedCount: 0,
          skippedCount: 0,
          startedAt: '2024-01-01T00:00:00Z',
          finishedAt: null,
          lastError: null,
        },
        cancel: mockCancel,
      } as any);

      const user = userEvent.setup();
      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      const cancelBtn = screen.getByRole('button', { name: /cancel migration/i });
      await user.click(cancelBtn);

      await waitFor(() => {
        expect(mockCancel).toHaveBeenCalledTimes(1);
      });
    });

    it('hides Start Migration form while migration is in progress', () => {
      mockUseStorageMigration.mockReturnValue({
        ...defaultMigrationMock(),
        activeRun: {
          id: 'run-1',
          sourceProvider: 's3',
          targetProvider: 'r2',
          status: 'pending',
          totalCount: 0,
          migratedCount: 0,
          failedCount: 0,
          skippedCount: 0,
          startedAt: null,
          finishedAt: null,
          lastError: null,
        },
      } as any);

      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByRole('button', { name: /^start migration$/i })).not.toBeInTheDocument();
    });

    it('shows run history table when there are past runs', () => {
      mockUseStorageMigration.mockReturnValue({
        ...defaultMigrationMock(),
        runs: [
          {
            id: 'run-old',
            sourceProvider: 'local',
            targetProvider: 's3',
            status: 'completed',
            totalCount: 50,
            migratedCount: 50,
            failedCount: 0,
            skippedCount: 0,
            startedAt: '2024-01-01T00:00:00Z',
            finishedAt: '2024-01-01T01:00:00Z',
            lastError: null,
          },
        ],
      } as any);

      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/recent migration runs/i)).toBeInTheDocument();
      // The table renders the route as a monospace Typography: "Local Disk → AWS S3"
      // Provider names also appear in card headings/radios, so use getAllByText.
      expect(screen.getAllByText(/local disk/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/aws s3/i).length).toBeGreaterThan(0);
      // The route cell has text "Local Disk → AWS S3" — assert the arrow character exists
      expect(screen.getByText(/local disk.*→.*aws s3/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Empty providers state', () => {
    it('renders without crashing when providers and knownProviders are both empty', () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        settings: {
          providers: [],
          knownProviders: [],
          activeProvider: '',
        },
      } as any);

      render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('heading', { name: /storage providers/i })).toBeInTheDocument();
    });
  });
});
