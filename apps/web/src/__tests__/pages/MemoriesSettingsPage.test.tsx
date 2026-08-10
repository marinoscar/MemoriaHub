/**
 * Unit tests for MemoriesSettingsPage (epic #300, issue #315).
 *
 * Mocking strategy mirrors BurstsSettingsPage.test.tsx: usePermissions and
 * useSystemSettings are module-mocked to drive admin state and the settings
 * payload, and every service the page calls is mocked so nothing hits the
 * network.
 *
 * What is actually worth asserting here, per the issue's acceptance criteria:
 *   - admin gating;
 *   - the feature toggle MERGES the features record rather than replacing it
 *     (the documented footgun — replacing it clears every other flag);
 *   - `memories.*` round-trips with the stored values and with defaults when
 *     the namespace is absent, which is its normal state;
 *   - the AI provider/model picker persists through PUT /api/ai/features/memories
 *     and warns when the provider has no enabled credential;
 *   - the digest section warns when no email provider is configured;
 *   - the backfill button is gated on the feature flag, passes the selected
 *     circle, and reports enqueued/skipped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useSystemSettings', () => ({
  useSystemSettings: vi.fn(),
}));

vi.mock('../../hooks/useAiSettings', () => ({
  useAiSettings: vi.fn(),
}));

vi.mock('../../services/email', () => ({
  getEmailSettings: vi.fn(),
}));

vi.mock('../../services/circles', () => ({
  listCircles: vi.fn(),
}));

vi.mock('../../services/adminMemories', () => ({
  runMemoriesBackfill: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import MemoriesSettingsPage from '../../pages/Admin/MemoriesSettingsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { useAiSettings } from '../../hooks/useAiSettings';
import { getEmailSettings } from '../../services/email';
import { listCircles } from '../../services/circles';
import { runMemoriesBackfill } from '../../services/adminMemories';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockUseAiSettings = vi.mocked(useAiSettings);
const mockGetEmailSettings = vi.mocked(getEmailSettings);
const mockListCircles = vi.mocked(listCircles);
const mockRunBackfill = vi.mocked(runMemoriesBackfill);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminPermissions(canWrite = true) {
  return {
    isAdmin: true,
    permissions: new Set(['system_settings:read', 'system_settings:write']),
    roles: new Set(['admin']),
    hasPermission: vi.fn().mockReturnValue(canWrite),
    hasAnyPermission: vi.fn().mockReturnValue(true),
    hasAllPermissions: vi.fn().mockReturnValue(true),
    hasRole: vi.fn().mockReturnValue(true),
    hasAnyRole: vi.fn().mockReturnValue(true),
  };
}

function nonAdminPermissions() {
  return {
    isAdmin: false,
    permissions: new Set<string>(),
    roles: new Set<string>(),
    hasPermission: vi.fn().mockReturnValue(false),
    hasAnyPermission: vi.fn().mockReturnValue(false),
    hasAllPermissions: vi.fn().mockReturnValue(false),
    hasRole: vi.fn().mockReturnValue(false),
    hasAnyRole: vi.fn().mockReturnValue(false),
  };
}

function makeSystemSettingsMock(options: {
  memoriesEnabled?: boolean;
  memories?: Record<string, unknown>;
} = {}) {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  return {
    settings: {
      // Two OTHER flags, so a toggle that replaces the record instead of
      // merging it is visible as a regression.
      features: {
        autoTagging: true,
        faceRecognition: true,
        memories: options.memoriesEnabled ?? false,
      },
      ...(options.memories ? { memories: options.memories } : {}),
      ui: { allowUserThemeOverride: true },
      updatedAt: new Date().toISOString(),
      updatedBy: null,
      version: 1,
    },
    isLoading: false,
    isSaving: false,
    error: null,
    updateSettings,
    replaceSettings: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAiSettingsMock(
  over: {
    provider?: string | null;
    model?: string | null;
    credentialEnabled?: boolean;
  } = {},
) {
  const saveMemoriesFeature = vi.fn().mockResolvedValue(undefined);
  return {
    settings: {
      providers: [
        {
          provider: 'openai',
          configured: true,
          enabled: over.credentialEnabled ?? true,
          last4: 'abcd',
          baseUrl: null,
        },
      ],
      knownProviders: [
        { provider: 'anthropic', configured: false, enabled: false, last4: null, baseUrl: null },
      ],
      features: {
        search: null,
        tagging: null,
        embedding: null,
        memories:
          over.provider === undefined
            ? null
            : { provider: over.provider, model: over.model ?? null },
      },
      conversations: { archiveAfterDays: 30, deleteAfterArchiveDays: 30 },
    },
    loading: false,
    error: null,
    fetchSettings: vi.fn().mockResolvedValue(undefined),
    saveCredentials: vi.fn(),
    removeCredentials: vi.fn(),
    testProvider: vi.fn(),
    getModels: vi.fn().mockResolvedValue(['gpt-4o-mini', 'gpt-4o']),
    saveSearchFeature: vi.fn(),
    saveTaggingFeature: vi.fn(),
    saveEmbeddingFeature: vi.fn(),
    getEmbeddingModels: vi.fn().mockResolvedValue([]),
    testEmbedding: vi.fn(),
    saveEnhanceFeature: vi.fn(),
    getImageModels: vi.fn().mockResolvedValue([]),
    saveMemoriesFeature,
  };
}

function switchFor(labelText: RegExp): HTMLInputElement {
  const label = screen.getByText(labelText);
  return label
    .closest('.MuiFormControlLabel-root')!
    .querySelector('input[type="checkbox"]') as HTMLInputElement;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoriesSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(adminPermissions() as never);
    mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock() as never);
    mockUseAiSettings.mockReturnValue(makeAiSettingsMock() as never);
    mockGetEmailSettings.mockResolvedValue({
      provider: 'smtp',
      enabled: true,
      fromAddress: 'a@b.c',
      fromName: null,
      sesRegion: null,
      sesCredentialAvailable: false,
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        useTls: true,
        username: null,
        passwordConfigured: true,
        passwordLast4: null,
      },
      credentialSource: 'smtp:inline',
    });
    mockListCircles.mockResolvedValue({
      items: [{ id: 'circle-1', name: 'Marin Family' }] as never,
      total: 1,
      page: 1,
      pageSize: 1,
      totalPages: 1,
    });
    mockRunBackfill.mockResolvedValue({ enqueued: 18, circles: 1, skipped: 0 });
  });

  // -------------------------------------------------------------------------
  describe('access control', () => {
    it('redirects non-admin users', () => {
      mockUsePermissions.mockReturnValue(nonAdminPermissions() as never);

      render(<MemoriesSettingsPage />);

      expect(screen.queryByRole('heading', { name: /^memories$/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('page structure', () => {
    beforeEach(() => {
      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });
    });

    it('renders the page heading and back link', () => {
      expect(screen.getByRole('heading', { name: /^memories$/i })).toBeInTheDocument();
      expect(screen.getByText(/back to settings/i)).toBeInTheDocument();
    });

    it('renders every section', () => {
      expect(screen.getByText('Global Settings')).toBeInTheDocument();
      expect(screen.getByText('AI Titles')).toBeInTheDocument();
      expect(screen.getByText('Generation')).toBeInTheDocument();
      expect(screen.getByText('Memory Types')).toBeInTheDocument();
      expect(screen.getByText('Email Digest')).toBeInTheDocument();
      expect(
        screen.getByText(/generate memories from the existing library/i),
      ).toBeInTheDocument();
    });

    it('names the MEMORIES_ENABLED env kill-switch', () => {
      expect(screen.getByText(/MEMORIES_ENABLED=false/)).toBeInTheDocument();
    });

    it('offers a switch for each of the six memory types', () => {
      for (const label of [
        /^On This Day$/,
        /^Trips$/,
        /^People$/,
        /^Themes$/,
        /^Seasonal$/,
        /^Year in Review$/,
      ]) {
        expect(switchFor(label)).toBeTruthy();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('global feature toggle', () => {
    it('reflects features.memories', () => {
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock({ memoriesEnabled: true }) as never,
      );

      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(switchFor(/enable memories globally/i).checked).toBe(true);
    });

    it('MERGES the features record instead of replacing it', async () => {
      const mock = makeSystemSettingsMock();
      mockUseSystemSettings.mockReturnValue(mock as never);

      const user = userEvent.setup();
      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(switchFor(/enable memories globally/i));

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith({
          features: { autoTagging: true, faceRecognition: true, memories: true },
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('memories.* round-trip', () => {
    it('falls back to defaults when the namespace is absent', () => {
      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        (screen.getByLabelText(/generation interval/i) as HTMLInputElement).value,
      ).toBe('24');
      expect(
        (screen.getByLabelText(/max items per memory/i) as HTMLInputElement).value,
      ).toBe('30');
    });

    it('pre-fills from stored settings', () => {
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock({
          memories: {
            generation: { intervalHours: 6 },
            maxItemsPerMemory: 40,
            onThisDay: { enabled: false, lookbackYears: 3, minItems: 5 },
          },
        }) as never,
      );

      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        (screen.getByLabelText(/generation interval/i) as HTMLInputElement).value,
      ).toBe('6');
      expect(
        (screen.getByLabelText(/max items per memory/i) as HTMLInputElement).value,
      ).toBe('40');
      expect(switchFor(/^On This Day$/).checked).toBe(false);
    });

    it('enforces the server bounds on the number inputs', () => {
      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const interval = screen.getByLabelText(/generation interval/i);
      expect(interval).toHaveAttribute('min', '1');
      expect(interval).toHaveAttribute('max', '168');

      const maxItems = screen.getByLabelText(/max items per memory/i);
      expect(maxItems).toHaveAttribute('min', '5');
      expect(maxItems).toHaveAttribute('max', '100');
    });

    it('saves the whole namespace in one call', async () => {
      const mock = makeSystemSettingsMock({ memoriesEnabled: true });
      mockUseSystemSettings.mockReturnValue(mock as never);

      const user = userEvent.setup();
      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /save memories settings/i }));

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith({
          memories: expect.objectContaining({
            generation: { intervalHours: 24 },
            maxItemsPerMemory: 30,
            aiTitles: { enabled: true },
            onThisDay: expect.objectContaining({ enabled: true, lookbackYears: 10 }),
            trips: expect.objectContaining({ minDistanceKm: 50 }),
            people: expect.objectContaining({ favoritesOnly: true }),
            themes: expect.objectContaining({ maxPerPeriod: 3 }),
            seasonal: expect.objectContaining({ minItems: 12 }),
            yearInReview: expect.objectContaining({ minItems: 15 }),
            digest: expect.objectContaining({ frequency: 'weekly', sendHourUtc: 8 }),
          }),
        });
      });
    });

    it('saves an edited value', async () => {
      const mock = makeSystemSettingsMock({ memoriesEnabled: true });
      mockUseSystemSettings.mockReturnValue(mock as never);

      const user = userEvent.setup();
      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const interval = screen.getByLabelText(/generation interval/i);
      await user.clear(interval);
      await user.type(interval, '12');
      await user.click(screen.getByRole('button', { name: /save memories settings/i }));

      await waitFor(() => {
        expect(mock.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            memories: expect.objectContaining({ generation: { intervalHours: 12 } }),
          }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('AI model picker', () => {
    it('reflects the configured ai.features.memories selection', async () => {
      mockUseAiSettings.mockReturnValue(
        makeAiSettingsMock({ provider: 'openai', model: 'gpt-4o' }) as never,
      );

      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByLabelText(/ai provider/i)).toHaveTextContent('openai');
      });
      expect(screen.getByLabelText(/^model$/i)).toHaveTextContent('gpt-4o');
    });

    it('persists the selection through saveMemoriesFeature', async () => {
      const ai = makeAiSettingsMock({ provider: 'openai', model: 'gpt-4o' });
      mockUseAiSettings.mockReturnValue(ai as never);

      const user = userEvent.setup();
      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /save ai model/i }));

      await waitFor(() => {
        expect(ai.saveMemoriesFeature).toHaveBeenCalledWith('openai', 'gpt-4o');
      });
    });

    it('clears the selection with nulls when no provider is chosen', async () => {
      const ai = makeAiSettingsMock();
      mockUseAiSettings.mockReturnValue(ai as never);

      const user = userEvent.setup();
      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(screen.getByRole('button', { name: /save ai model/i }));

      await waitFor(() => {
        expect(ai.saveMemoriesFeature).toHaveBeenCalledWith(null, null);
      });
    });

    it('warns when the selected provider has no enabled credential', async () => {
      mockUseAiSettings.mockReturnValue(
        makeAiSettingsMock({
          provider: 'openai',
          model: 'gpt-4o',
          credentialEnabled: false,
        }) as never,
      );

      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/no credential for openai/i)).toBeInTheDocument();
      });
    });

    it('shows no credential warning when one is configured', async () => {
      mockUseAiSettings.mockReturnValue(
        makeAiSettingsMock({ provider: 'openai', model: 'gpt-4o' }) as never,
      );

      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByLabelText(/ai provider/i)).toHaveTextContent('openai');
      });
      expect(screen.queryByText(/no credential for/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('email digest', () => {
    it('warns when no email provider is configured', async () => {
      mockGetEmailSettings.mockResolvedValue({
        provider: null,
        enabled: false,
        fromAddress: null,
        fromName: null,
        sesRegion: null,
        sesCredentialAvailable: false,
        smtp: {
          host: null,
          port: 587,
          useTls: true,
          username: null,
          passwordConfigured: false,
          passwordLast4: null,
        },
        credentialSource: null,
      });

      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(screen.getByText(/email not configured/i)).toBeInTheDocument();
      });
    });

    it('does not warn when email is configured and enabled', async () => {
      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => expect(mockGetEmailSettings).toHaveBeenCalled());
      expect(screen.queryByText(/email not configured/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('library backfill', () => {
    it('is disabled while the feature is off', () => {
      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        screen.getByRole('button', { name: /generate memories from existing library/i }),
      ).toBeDisabled();
    });

    it('is enabled once the feature is on', () => {
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock({ memoriesEnabled: true }) as never,
      );

      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        screen.getByRole('button', { name: /generate memories from existing library/i }),
      ).not.toBeDisabled();
    });

    it('sweeps every circle by default', async () => {
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock({ memoriesEnabled: true }) as never,
      );

      const user = userEvent.setup();
      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(
        screen.getByRole('button', { name: /generate memories from existing library/i }),
      );

      await waitFor(() => expect(mockRunBackfill).toHaveBeenCalledWith({}));
    });

    it('passes the selected circle', async () => {
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock({ memoriesEnabled: true }) as never,
      );

      const user = userEvent.setup();
      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => expect(mockListCircles).toHaveBeenCalledWith(true));
      await user.click(screen.getByLabelText(/^circle$/i));
      await user.click(await screen.findByRole('option', { name: 'Marin Family' }));
      await user.click(
        screen.getByRole('button', { name: /generate memories from existing library/i }),
      );

      await waitFor(() =>
        expect(mockRunBackfill).toHaveBeenCalledWith({ circleId: 'circle-1' }),
      );
    });

    it('reports enqueued and skipped counts with a link to the job queue', async () => {
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock({ memoriesEnabled: true }) as never,
      );
      mockRunBackfill.mockResolvedValue({ enqueued: 36, circles: 2, skipped: 1 });

      const user = userEvent.setup();
      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(
        screen.getByRole('button', { name: /generate memories from existing library/i }),
      );

      const alert = await screen.findByText(/36 job\(s\) queued across 2 circle/i);
      expect(alert).toBeInTheDocument();
      expect(screen.getByText(/1 skipped \(already generating\)/i)).toBeInTheDocument();
      expect(
        within(alert.closest('.MuiAlert-root') as HTMLElement).getByRole('link', {
          name: /watch progress/i,
        }),
      ).toHaveAttribute('href', '/admin/settings/jobs?type=memory_generation');
    });

    it('surfaces the flag-off 400 from the API', async () => {
      mockUseSystemSettings.mockReturnValue(
        makeSystemSettingsMock({ memoriesEnabled: true }) as never,
      );
      mockRunBackfill.mockRejectedValue(new Error('Memories is disabled globally'));

      const user = userEvent.setup();
      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(
        screen.getByRole('button', { name: /generate memories from existing library/i }),
      );

      await waitFor(() => {
        expect(screen.getByText(/memories is disabled globally/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('loading and error states', () => {
    it('shows a spinner while settings load', () => {
      mockUseSystemSettings.mockReturnValue({
        settings: null,
        isLoading: true,
        isSaving: false,
        error: null,
        updateSettings: vi.fn(),
        replaceSettings: vi.fn(),
        refresh: vi.fn(),
      } as never);

      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows an error alert when settings fail to load', () => {
      mockUseSystemSettings.mockReturnValue({
        settings: null,
        isLoading: false,
        isSaving: false,
        error: 'Failed to load settings',
        updateSettings: vi.fn(),
        replaceSettings: vi.fn(),
        refresh: vi.fn(),
      } as never);

      render(<MemoriesSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument();
    });
  });
});
