/**
 * Unit tests for StorageProvidersPage — post-#259 (the shared-DataTable
 * migration).
 *
 * Two surfaces changed and are covered here:
 *   - the provider CARDS became a table plus a per-row "Configure…" dialog, so
 *     every credential mutation (save / remove / test, and the pre-save secret
 *     guard) is now reached through the row menu;
 *   - the migration run history became a DataTable with `status` as a `primary`
 *     column.
 *
 * Table MECHANICS are the component's, covered by
 * `runDataTableConformanceSuite` (docs/specs/datatable.md §18.5) and not
 * re-tested here.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
} from '../../components/datatable/__tests__/testUtils/layoutStubs';

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
import {
  MIGRATION_RUN_COLUMNS,
  buildStorageProviderColumns,
  providerState,
} from '../../pages/Admin/storageProvidersTable';
import { usePermissions } from '../../hooks/usePermissions';
import { useStorageProviders } from '../../hooks/useStorageProviders';
import { useStorageMigration } from '../../hooks/useStorageMigration';
import { api } from '../../services/api';

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

function renderPage() {
  return render(<StorageProvidersPage />, { wrapperOptions: { user: mockAdminUser } });
}

/** Open a provider's credential dialog through its row menu. */
async function openConfigure(user: ReturnType<typeof userEvent.setup>, rowLabel: string) {
  await user.click(await screen.findByRole('button', { name: `Row actions for ${rowLabel}` }));
  await user.click(await screen.findByRole('menuitem', { name: /^configure$/i }));
  return screen.findByRole('dialog');
}

/** Open a provider's row menu without picking anything. */
async function openRowMenu(user: ReturnType<typeof userEvent.setup>, rowLabel: string) {
  await user.click(await screen.findByRole('button', { name: `Row actions for ${rowLabel}` }));
}

// ---------------------------------------------------------------------------

describe('StorageProvidersPage', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    mockUsePermissions.mockReturnValue(defaultPermissionsMock() as any);
    mockUseStorageProviders.mockReturnValue(defaultStorageProvidersMock() as any);
    mockUseStorageMigration.mockReturnValue(defaultMigrationMock() as any);
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  // -------------------------------------------------------------------------
  describe('Authorization', () => {
    it('redirects non-admin users (page heading not shown)', () => {
      mockUsePermissions.mockReturnValue({
        ...defaultPermissionsMock(),
        isAdmin: false,
      } as any);

      renderPage();

      expect(screen.queryByRole('heading', { name: /storage providers/i })).not.toBeInTheDocument();
    });

    it('renders the page heading for admin users', () => {
      renderPage();

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

      renderPage();

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /storage providers/i })).not.toBeInTheDocument();
    });

    it('still shows the page when loading is true but settings are already present', () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        loading: true,
      } as any);

      renderPage();

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

      renderPage();

      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert.textContent).toContain('Failed to load storage settings');
    });
  });

  // -------------------------------------------------------------------------
  describe('Column definitions', () => {
    it('leads the provider card with Provider then Status (issue #259)', () => {
      const primaries = buildStorageProviderColumns('s3')
        .filter((column) => column.priority === 'primary')
        .map((column) => column.id);
      expect(primaries).toEqual(['provider', 'state']);
    });

    it('leads the migration-run card with Route then Status', () => {
      const primaries = MIGRATION_RUN_COLUMNS.filter(
        (column) => column.priority === 'primary',
      ).map((column) => column.id);
      expect(primaries).toEqual(['route', 'status']);
    });

    it('keeps the masked secret out of a CSV export', () => {
      const secret = buildStorageProviderColumns('s3').find((column) => column.id === 'last4')!;
      expect(secret.exportable).toBe(false);
    });

    it('derives the four-way provider state', () => {
      expect(providerState(makeProviderRow() as any, 's3')).toBe('Active');
      expect(providerState(makeProviderRow({ provider: 'r2' }) as any, 's3')).toBe('Enabled');
      expect(
        providerState(makeProviderRow({ provider: 'r2', enabled: false }) as any, 's3'),
      ).toBe('Disabled');
      expect(
        providerState(makeProviderRow({ provider: 'r2', configured: false }) as any, 's3'),
      ).toBe('Not configured');
    });
  });

  // -------------------------------------------------------------------------
  describe('Provider table', () => {
    it('renders a row for each provider — AWS S3, Cloudflare R2, Local Disk', async () => {
      renderPage();

      const grid = await screen.findByRole('grid', { name: /storage providers/i });
      await waitFor(() => {
        expect(within(grid).getByText('AWS S3')).toBeInTheDocument();
      });
      expect(within(grid).getByText('Cloudflare R2')).toBeInTheDocument();
      expect(within(grid).getByText('Local Disk')).toBeInTheDocument();
    });

    it('shows the "Active" status on the currently active provider', async () => {
      renderPage();

      const grid = await screen.findByRole('grid', { name: /storage providers/i });
      await waitFor(() => {
        expect(within(grid).getByText('Active')).toBeInTheDocument();
      });
    });

    it('shows a Configured chip for configured providers', async () => {
      renderPage();

      const grid = await screen.findByRole('grid', { name: /storage providers/i });
      await waitFor(() => {
        expect(within(grid).getAllByText('Configured').length).toBeGreaterThan(0);
      });
    });

    it('shows the masked secret in the table, never the secret itself', async () => {
      renderPage();

      const grid = await screen.findByRole('grid', { name: /storage providers/i });
      await waitFor(() => {
        expect(within(grid).getByText(/••••.*wxyz/)).toBeInTheDocument();
      });
    });

    it('renders without crashing when providers and knownProviders are both empty', async () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        settings: { providers: [], knownProviders: [], activeProvider: '' },
      } as any);

      renderPage();

      expect(screen.getByRole('heading', { name: /storage providers/i })).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByText(/no storage providers available/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('Configure dialog', () => {
    it('shows the masked current secret and the credential fields', async () => {
      const user = userEvent.setup();
      renderPage();

      const dialog = await openConfigure(user, 'AWS S3');

      expect(within(dialog).getByDisplayValue(/••••.*wxyz/)).toBeInTheDocument();
      expect(within(dialog).getByLabelText(/access key id/i)).toBeInTheDocument();
      expect(within(dialog).getByLabelText(/new secret access key/i)).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: /^save$/i })).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: /test connection/i })).toBeInTheDocument();
    });

    it('shows the no-credentials alert for Local Disk, and no credential fields', async () => {
      const user = userEvent.setup();
      renderPage();

      const dialog = await openConfigure(user, 'Local Disk');

      expect(within(dialog).getByText(/no credentials required/i)).toBeInTheDocument();
      expect(within(dialog).queryByLabelText(/access key id/i)).not.toBeInTheDocument();
      expect(within(dialog).queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    });

    it('saves credentials with the typed values', async () => {
      const saveCredentials = vi.fn().mockResolvedValue(makeProviderRow());
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        saveCredentials,
      } as any);
      const user = userEvent.setup();
      renderPage();

      const dialog = await openConfigure(user, 'AWS S3');
      // `fireEvent.change` rather than `user.type`: every keystroke re-renders
      // the page (and its two DataGrids), which is a needless ~10s in CI.
      fireEvent.change(within(dialog).getByLabelText(/new secret access key/i), {
        target: { value: 'brand-new' },
      });
      await user.click(within(dialog).getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(saveCredentials).toHaveBeenCalledWith(
          's3',
          expect.objectContaining({ secretAccessKey: 'brand-new', bucket: 'my-bucket' }),
        );
      });
    });

    it('shows the helper text explaining a blank secret keeps the stored one', async () => {
      const user = userEvent.setup();
      renderPage();

      const dialog = await openConfigure(user, 'AWS S3');

      expect(
        within(dialog).getByText(/leave blank to use the saved secret when testing or saving/i),
      ).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Test connection', () => {
    it('calls testProvider from the row menu', async () => {
      const testProvider = vi.fn().mockResolvedValue({ ok: true, bucket: 'my-bucket' });
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        testProvider,
      } as any);
      const user = userEvent.setup();
      renderPage();

      await openRowMenu(user, 'AWS S3');
      await user.click(await screen.findByRole('menuitem', { name: /test connection/i }));

      await waitFor(() => {
        expect(testProvider).toHaveBeenCalledWith('s3', expect.any(Object));
      });
    });

    it('shows the ok result inside the dialog', async () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        testResults: { s3: { ok: true, bucket: 'my-bucket' } },
      } as any);
      const user = userEvent.setup();
      renderPage();

      const dialog = await openConfigure(user, 'AWS S3');

      expect(within(dialog).getByText(/connected/i)).toBeInTheDocument();
    });

    it('shows the failure reason inside the dialog', async () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        testResults: { s3: { ok: false, error: 'Invalid credentials' } },
      } as any);
      const user = userEvent.setup();
      renderPage();

      const dialog = await openConfigure(user, 'AWS S3');

      expect(within(dialog).getByText(/invalid credentials/i)).toBeInTheDocument();
    });

    it('shows "Accessible" for Local Disk when the test succeeded', async () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        testResults: { local: { ok: true } },
      } as any);
      const user = userEvent.setup();
      renderPage();

      const dialog = await openConfigure(user, 'Local Disk');

      expect(within(dialog).getByText(/accessible/i)).toBeInTheDocument();
    });

    it('disables the test control while a test is in flight', async () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        testLoading: { s3: true },
      } as any);
      const user = userEvent.setup();
      renderPage();

      await openRowMenu(user, 'AWS S3');

      expect(await screen.findByRole('menuitem', { name: /test connection/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('Test guard: unconfigured provider requiring credentials', () => {
    function unconfiguredR2Settings() {
      return {
        providers: [],
        knownProviders: [
          makeProviderRow({
            provider: 'r2',
            label: 'Cloudflare R2',
            configured: false,
            enabled: false,
            last4: null,
            accessKeyId: null,
            region: null,
            bucket: null,
          }),
        ],
        activeProvider: 's3',
      };
    }

    it('disables the test action and shows the caption while the secret is empty', async () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        settings: unconfiguredR2Settings(),
      } as any);
      const user = userEvent.setup();
      renderPage();

      await openRowMenu(user, 'Cloudflare R2');
      expect(await screen.findByRole('menuitem', { name: /test connection/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await user.keyboard('{Escape}');

      const dialog = await openConfigure(user, 'Cloudflare R2');
      expect(
        within(dialog).getByText(/enter the secret access key to test before saving/i),
      ).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: /test connection/i })).toBeDisabled();
    });

    it('enables the test button and hides the caption once a secret is typed', async () => {
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        settings: unconfiguredR2Settings(),
      } as any);
      const user = userEvent.setup();
      renderPage();

      const dialog = await openConfigure(user, 'Cloudflare R2');
      fireEvent.change(within(dialog).getByLabelText(/new secret access key/i), {
        target: { value: 'my-r2-secret' },
      });

      await waitFor(() => {
        expect(within(dialog).getByRole('button', { name: /test connection/i })).not.toBeDisabled();
      });
      expect(
        within(dialog).queryByText(/enter the secret access key to test before saving/i),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Remove credentials', () => {
    it('confirms, then calls removeCredentials', async () => {
      const removeCredentials = vi.fn().mockResolvedValue(undefined);
      mockUseStorageProviders.mockReturnValue({
        ...defaultStorageProvidersMock(),
        removeCredentials,
      } as any);
      const user = userEvent.setup();
      renderPage();

      await openRowMenu(user, 'Cloudflare R2');
      await user.click(await screen.findByRole('menuitem', { name: /^remove$/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/remove credentials\?/i)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: /^remove$/i }));

      await waitFor(() => {
        expect(removeCredentials).toHaveBeenCalledWith('r2');
      });
    });

    it('is disabled for the local provider, which has no credentials to remove', async () => {
      const user = userEvent.setup();
      renderPage();

      await openRowMenu(user, 'Local Disk');

      expect(await screen.findByRole('menuitem', { name: /^remove$/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('Active provider selector', () => {
    it('renders a radio group with each provider', () => {
      renderPage();

      const radios = screen.getAllByRole('radio');
      // 3 providers → 3 radios
      expect(radios.length).toBe(3);
    });

    it('has the current active provider pre-selected', () => {
      renderPage();

      // defaultSettings has activeProvider = 's3'
      const radios = screen.getAllByRole('radio');
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
      renderPage();

      const radios = screen.getAllByRole('radio');
      await user.click(radios[1]); // r2 is the second radio

      const saveActiveBtn = screen.getByRole('button', { name: /save active provider/i });
      await user.click(saveActiveBtn);

      await waitFor(() => {
        expect(mockSetActive).toHaveBeenCalledWith('r2');
      });
    });

    it('disables Save Active Provider button when selection matches current active provider', () => {
      renderPage();

      const saveActiveBtn = screen.getByRole('button', { name: /save active provider/i });
      expect(saveActiveBtn).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  describe('Migration panel', () => {
    it('renders Source and Target provider selects', () => {
      renderPage();

      expect(screen.getAllByText(/source provider/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/target provider/i).length).toBeGreaterThan(0);
    });

    it('Start Migration button is disabled until source and target are different', () => {
      renderPage();

      const startBtn = screen.getByRole('button', { name: /start migration/i });
      expect(startBtn).toBeDisabled();
    });

    it('opens confirmation dialog when Start Migration is clicked with valid source and target', async () => {
      const user = userEvent.setup();
      renderPage();

      const source = screen.getByRole('combobox', { name: /source provider/i });
      await user.click(source);
      await user.click(await screen.findByRole('option', { name: /aws s3/i }));

      const target = screen.getByRole('combobox', { name: /target provider/i });
      await user.click(target);
      await user.click(await screen.findByRole('option', { name: /cloudflare r2/i }));

      await user.click(screen.getByRole('button', { name: /start migration/i }));

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
      renderPage();

      await user.click(screen.getByRole('combobox', { name: /source provider/i }));
      await user.click(await screen.findByRole('option', { name: /aws s3/i }));
      await user.click(screen.getByRole('combobox', { name: /target provider/i }));
      await user.click(await screen.findByRole('option', { name: /cloudflare r2/i }));
      await user.click(screen.getByRole('button', { name: /start migration/i }));

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^start migration$/i }));

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
      renderPage();

      await user.click(screen.getByRole('combobox', { name: /source provider/i }));
      await user.click(await screen.findByRole('option', { name: /aws s3/i }));
      await user.click(screen.getByRole('combobox', { name: /target provider/i }));
      await user.click(await screen.findByRole('option', { name: /cloudflare r2/i }));
      await user.click(screen.getByRole('button', { name: /start migration/i }));

      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(mockStartMigration).not.toHaveBeenCalled();
    });

    it('shows migration progress when activeRun is in-flight', () => {
      mockUseStorageMigration.mockReturnValue({
        ...defaultMigrationMock(),
        activeRun: {
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
        },
      } as any);

      renderPage();

      expect(screen.getByText(/migration in progress/i)).toBeInTheDocument();
      expect(screen.getByText(/copied:/i)).toBeInTheDocument();
      expect(screen.getByText(/45 \/ 100/)).toBeInTheDocument();
      expect(screen.getAllByRole('progressbar').length).toBeGreaterThan(0);
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

      renderPage();

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
      renderPage();

      await user.click(screen.getByRole('button', { name: /cancel migration/i }));

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

      renderPage();

      expect(screen.queryByRole('button', { name: /^start migration$/i })).not.toBeInTheDocument();
    });

    it('shows the run history table when there are past runs', async () => {
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

      renderPage();

      expect(screen.getByText(/recent migration runs/i)).toBeInTheDocument();

      const grid = await screen.findByRole('grid', { name: /migration runs/i });
      await waitFor(() => {
        expect(within(grid).getByText(/local disk.*→.*aws s3/i)).toBeInTheDocument();
      });
      expect(within(grid).getByText('completed')).toBeInTheDocument();
    });
  });
});
