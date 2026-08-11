/**
 * Unit tests for LocationGroupsSettingsPage (Admin > Location Groups, #375).
 *
 * Mocking strategy (mirrors LocationInferenceSettingsPage.test.tsx):
 *   - usePermissions is module-mocked so the RBAC guard can be driven directly.
 *     Unlike the Location Inference page this one is gated on BOTH the admin
 *     role AND `geo_settings:read`, so an admin lacking the permission must
 *     still be redirected.
 *   - useSystemSettings is module-mocked for the feature flag + the
 *     locationGrouping.* knobs.
 *   - services/locationGroups and services/jobs are module-mocked so no real
 *     API call is made.
 *
 * Covers:
 *   - Access control (non-admin, and admin without geo_settings:read)
 *   - Page structure and the one-Save global settings section
 *   - A suggestion card's Merge posts and removes the card
 *   - Group list rows: enable toggle and delete
 *   - Rebuild trigger
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

vi.mock('../../services/jobs', () => ({
  listJobs: vi.fn(),
}));

vi.mock('../../services/locationGroups', async () => {
  const actual = await vi.importActual<typeof import('../../services/locationGroups')>(
    '../../services/locationGroups',
  );
  return {
    ...actual,
    listLocationGroups: vi.fn(),
    listLocationGroupSuggestions: vi.fn(),
    listLocationValues: vi.fn(),
    createLocationGroup: vi.fn(),
    updateLocationGroup: vi.fn(),
    deleteLocationGroup: vi.fn(),
    mergeLocationGroups: vi.fn(),
    rebuildLocationGroups: vi.fn(),
  };
});

// The editor dialog owns its own network calls; it has its own spec.
vi.mock('../../pages/Admin/LocationGroupEditorDialog', () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="editor-dialog" /> : null,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import LocationGroupsSettingsPage from '../../pages/Admin/LocationGroupsSettingsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { listJobs } from '../../services/jobs';
import {
  createLocationGroup,
  deleteLocationGroup,
  listLocationGroupSuggestions,
  listLocationGroups,
  listLocationValues,
  mergeLocationGroups,
  rebuildLocationGroups,
  updateLocationGroup,
} from '../../services/locationGroups';
import type {
  LocationGroupSuggestion,
  LocationGroupSummary,
  LocationValue,
  MergeLocationGroupsResult,
} from '../../services/locationGroups';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseSystemSettings = vi.mocked(useSystemSettings);
const mockListGroups = vi.mocked(listLocationGroups);
const mockListSuggestions = vi.mocked(listLocationGroupSuggestions);
const mockListValues = vi.mocked(listLocationValues);
const mockMerge = vi.mocked(mergeLocationGroups);
const mockCreateGroup = vi.mocked(createLocationGroup);
const mockUpdateGroup = vi.mocked(updateLocationGroup);
const mockDeleteGroup = vi.mocked(deleteLocationGroup);
const mockRebuild = vi.mocked(rebuildLocationGroups);
const mockListJobs = vi.mocked(listJobs);

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makePermissions(overrides: { isAdmin?: boolean; permissions?: string[] } = {}) {
  const perms = new Set(overrides.permissions ?? ['geo_settings:read', 'geo_settings:write']);
  return {
    isAdmin: overrides.isAdmin ?? true,
    permissions: perms,
    roles: new Set(overrides.isAdmin === false ? [] : ['admin']),
    hasPermission: vi.fn((p: string) => perms.has(p)),
    hasAnyPermission: vi.fn(() => true),
    hasAllPermissions: vi.fn(() => true),
    hasRole: vi.fn(() => overrides.isAdmin !== false),
    hasAnyRole: vi.fn(() => overrides.isAdmin !== false),
  };
}

function makeSystemSettingsMock(locationGrouping = true) {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  return {
    settings: {
      features: { locationGrouping },
      locationGrouping: {
        radiusCaptureEnabled: true,
        maxRadiusKm: 25,
        suggestionMinItems: 3,
      },
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

function makeGroup(overrides: Partial<LocationGroupSummary> = {}): LocationGroupSummary {
  return {
    id: 'group-1',
    level: 'locality',
    canonicalName: 'Heredia',
    countryCode: 'CR',
    memberCount: 3,
    itemCount: 1204,
    coverMediaItemId: null,
    coverThumbnailUrl: null,
    centerLat: null,
    centerLng: null,
    radiusKm: null,
    enabled: true,
    notes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeValue(overrides: Partial<LocationValue> = {}): LocationValue {
  return {
    value: 'Conroe',
    countryCode: 'US',
    itemCount: 12,
    groupId: null,
    groupCanonicalName: null,
    ...overrides,
  };
}

/** Mirrors the real merge payload — the name lives at `group.canonicalName`. */
function makeMergeResult(
  overrides: Partial<MergeLocationGroupsResult> = {},
): MergeLocationGroupsResult {
  return {
    groupId: 'g-new',
    created: true,
    added: 2,
    skipped: 0,
    jobId: 'job-7',
    status: 'pending',
    group: {
      ...makeGroup({ id: 'g-new', canonicalName: 'The Woodlands' }),
      normalizedName: 'the woodlands',
      aliases: [],
    },
    ...overrides,
  };
}

function makeSuggestion(
  overrides: Partial<LocationGroupSuggestion> = {},
): LocationGroupSuggestion {
  return {
    suggestedCanonicalName: 'Heredia',
    countryCode: 'CR',
    members: [
      { value: 'Heredia', itemCount: 800 },
      { value: 'Heredia Province', itemCount: 300 },
      { value: 'Provincia de Heredia', itemCount: 104 },
    ],
    totalItems: 1204,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocationGroupsSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(makePermissions() as any);
    mockUseSystemSettings.mockReturnValue(makeSystemSettingsMock() as any);
    mockListGroups.mockResolvedValue({
      items: [],
      meta: { total: 0, page: 1, pageSize: 100 },
    });
    mockListSuggestions.mockResolvedValue({ items: [], meta: { total: 0, limit: 25 } });
    mockListValues.mockResolvedValue({
      items: [],
      meta: { total: 0, page: 1, pageSize: 50 },
    });
    mockMerge.mockResolvedValue(makeMergeResult());
    mockListJobs.mockResolvedValue({
      items: [],
      meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
    } as any);
  });

  // -------------------------------------------------------------------------
  describe('access control', () => {
    it('renders for an admin holding geo_settings:read', async () => {
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        await screen.findByRole('heading', { name: /location groups/i }),
      ).toBeInTheDocument();
    });

    it('redirects a non-admin user', () => {
      mockUsePermissions.mockReturnValue(makePermissions({ isAdmin: false, permissions: [] }) as any);

      render(<LocationGroupsSettingsPage />);

      expect(screen.queryByRole('heading', { name: /location groups/i })).not.toBeInTheDocument();
    });

    it('redirects an admin lacking geo_settings:read', () => {
      mockUsePermissions.mockReturnValue(
        makePermissions({ isAdmin: true, permissions: ['system_settings:read'] }) as any,
      );

      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByRole('heading', { name: /location groups/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('page structure', () => {
    it('renders the Back to Settings link and every section', async () => {
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(await screen.findByText(/back to settings/i)).toBeInTheDocument();
      expect(screen.getByText('Global Settings')).toBeInTheDocument();
      expect(screen.getByText('Suggestions')).toBeInTheDocument();
      expect(screen.getByText('Groups')).toBeInTheDocument();
      expect(screen.getByText(/rebuild canonical names/i)).toBeInTheDocument();
    });

    it('renders the Countries / Regions / Cities tabs', async () => {
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(await screen.findByRole('tab', { name: 'Countries' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Regions' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Cities' })).toBeInTheDocument();
    });

    it('loads groups and suggestions for the default (Cities) level', async () => {
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(mockListGroups).toHaveBeenCalledWith(
          expect.objectContaining({ level: 'locality' }),
        );
        expect(mockListSuggestions).toHaveBeenCalledWith(
          expect.objectContaining({ level: 'locality' }),
        );
      });
    });

    it('refetches for the selected level when a tab is chosen', async () => {
      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(await screen.findByRole('tab', { name: 'Regions' }));

      await waitFor(() => {
        expect(mockListGroups).toHaveBeenCalledWith(expect.objectContaining({ level: 'region' }));
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('global settings', () => {
    it('renders the feature and radius-capture switches from settings', async () => {
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const feature = (await screen.findByText(/enable location grouping globally/i))
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(feature?.checked).toBe(true);

      const radius = screen
        .getByText(/capture photos by area radius/i)
        .closest('.MuiFormControlLabel-root')
        ?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      expect(radius?.checked).toBe(true);
    });

    it('binds the max-radius slider and min-items field to the loaded settings', async () => {
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(await screen.findByText(/maximum capture radius/i)).toBeInTheDocument();
      const sliders = screen.getAllByRole('slider');
      expect(sliders.find((s) => s.getAttribute('aria-valuenow') === '25')).toBeTruthy();

      const minItems = screen.getByLabelText(/minimum photos per suggested value/i);
      expect(minItems).toHaveValue(3);
    });

    it('saves the feature flag and the whole locationGrouping namespace in ONE call', async () => {
      const settingsMock = makeSystemSettingsMock(true);
      mockUseSystemSettings.mockReturnValue(settingsMock as any);

      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(await screen.findByRole('button', { name: /save settings/i }));

      await waitFor(() => {
        expect(settingsMock.updateSettings).toHaveBeenCalledTimes(1);
        expect(settingsMock.updateSettings).toHaveBeenCalledWith({
          features: expect.objectContaining({ locationGrouping: true }),
          locationGrouping: {
            radiusCaptureEnabled: true,
            maxRadiusKm: 25,
            suggestionMinItems: 3,
          },
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('suggestions', () => {
    it('renders a suggestion card listing its members and total photos', async () => {
      mockListSuggestions.mockResolvedValue({
        items: [makeSuggestion()],
        meta: { total: 1, limit: 25 },
      });

      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(
        await screen.findByText(
          /Heredia · Heredia Province · Provincia de Heredia — 1,204 photos/i,
        ),
      ).toBeInTheDocument();
    });

    it('Merge posts the cluster as a new group and removes the card', async () => {
      mockListSuggestions.mockResolvedValue({
        items: [makeSuggestion()],
        meta: { total: 1, limit: 25 },
      });
      mockCreateGroup.mockResolvedValue({ id: 'new-group' } as any);

      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(await screen.findByRole('button', { name: /merge/i }));

      await waitFor(() => {
        expect(mockCreateGroup).toHaveBeenCalledWith({
          level: 'locality',
          canonicalName: 'Heredia',
          countryCode: 'CR',
          memberValues: ['Heredia', 'Heredia Province', 'Provincia de Heredia'],
        });
      });

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /merge/i })).not.toBeInTheDocument();
      });
    });

    it('merges under the edited canonical name', async () => {
      mockListSuggestions.mockResolvedValue({
        items: [makeSuggestion()],
        meta: { total: 1, limit: 25 },
      });
      mockCreateGroup.mockResolvedValue({ id: 'new-group' } as any);

      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const nameField = await screen.findByLabelText(/canonical name/i);
      await user.clear(nameField);
      await user.type(nameField, 'Heredia City');
      await user.click(screen.getByRole('button', { name: /merge/i }));

      await waitFor(() => {
        expect(mockCreateGroup).toHaveBeenCalledWith(
          expect.objectContaining({ canonicalName: 'Heredia City' }),
        );
      });
    });

    it('shows the owning group name when the merge hits a 409 conflict', async () => {
      const { ApiError } = await import('../../services/api');
      mockListSuggestions.mockResolvedValue({
        items: [makeSuggestion()],
        meta: { total: 1, limit: 25 },
      });
      mockCreateGroup.mockRejectedValue(
        new ApiError('"heredia" is already a member of "Heredia"', 409, undefined, {
          groupId: 'g-owner',
          groupName: 'Heredia',
        }),
      );

      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(await screen.findByRole('button', { name: /merge/i }));

      expect(await screen.findByText(/already in group "Heredia"/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('all locations (#407)', () => {
    /** Three ungrouped US cities that look nothing alike — the #407 motivator. */
    const WOODLANDS_PAGE: LocationValue[] = [
      makeValue({ value: 'Conroe', itemCount: 12 }),
      makeValue({ value: 'Shenandoah', itemCount: 4 }),
    ];

    it('lists raw values with country, count and owning group', async () => {
      mockListValues.mockResolvedValue({
        items: [
          makeValue({ value: 'Conroe', itemCount: 12 }),
          makeValue({
            value: 'The Woodlands',
            itemCount: 1188,
            groupId: 'g-1',
            groupCanonicalName: 'Woodlands Area',
          }),
        ],
        meta: { total: 812, page: 1, pageSize: 50 },
      });

      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const row = await screen.findByTestId('value-row-The Woodlands');
      expect(within(row).getByText('The Woodlands')).toBeInTheDocument();
      expect(within(row).getByText('US')).toBeInTheDocument();
      expect(within(row).getByText('1,188 photos')).toBeInTheDocument();
      expect(within(row).getByText('in "Woodlands Area"')).toBeInTheDocument();
    });

    it('reports an honest total from meta.total, not the page length', async () => {
      mockListValues.mockResolvedValue({
        items: WOODLANDS_PAGE,
        meta: { total: 812, page: 1, pageSize: 50 },
      });

      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(await screen.findByText(/showing 2 of 812/i)).toBeInTheDocument();
    });

    it('scopes the query to the active level tab', async () => {
      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() => {
        expect(mockListValues).toHaveBeenCalledWith(
          expect.objectContaining({ level: 'locality', page: 1 }),
        );
      });

      await user.click(screen.getByRole('tab', { name: 'Regions' }));

      await waitFor(() => {
        expect(mockListValues).toHaveBeenCalledWith(
          expect.objectContaining({ level: 'region' }),
        );
      });
    });

    it('keeps the selection across a search-term change', async () => {
      mockListValues.mockResolvedValue({
        items: WOODLANDS_PAGE,
        meta: { total: 812, page: 1, pageSize: 50 },
      });

      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(await screen.findByLabelText('Select Conroe'));
      expect(screen.getByTestId('values-selection-bar').textContent).toMatch(/1 selected/);

      // A new search term returns a completely different page…
      mockListValues.mockResolvedValue({
        items: [makeValue({ value: 'The Woodlands', itemCount: 1188 })],
        meta: { total: 1, page: 1, pageSize: 50 },
      });
      await user.type(screen.getByLabelText(/search locations/i), 'Woodlands');

      await waitFor(() => {
        expect(mockListValues).toHaveBeenCalledWith(
          expect.objectContaining({ q: 'Woodlands', page: 1 }),
        );
      });

      // …and the earlier tick is still counted, off-page.
      await user.click(await screen.findByLabelText('Select The Woodlands'));
      expect(screen.getByTestId('values-selection-bar').textContent).toMatch(/2 selected/);
    });

    it('keeps the selection across a page change', async () => {
      mockListValues.mockResolvedValue({
        items: WOODLANDS_PAGE,
        meta: { total: 120, page: 1, pageSize: 50 },
      });

      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(await screen.findByLabelText('Select Conroe'));

      mockListValues.mockResolvedValue({
        items: [makeValue({ value: 'Spring', itemCount: 30 })],
        meta: { total: 120, page: 2, pageSize: 50 },
      });
      await user.click(screen.getByRole('button', { name: /next/i }));

      await waitFor(() => {
        expect(mockListValues).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
      });

      expect(await screen.findByTestId('value-row-Spring')).toBeInTheDocument();
      expect(screen.getByTestId('values-selection-bar').textContent).toMatch(/1 selected/);
    });

    it('merges the accumulated selection and reports the queued rebuild', async () => {
      mockListValues.mockResolvedValue({
        items: WOODLANDS_PAGE,
        meta: { total: 2, page: 1, pageSize: 50 },
      });
      mockMerge.mockResolvedValue(makeMergeResult({ jobId: 'job-7', status: 'pending' }));

      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(await screen.findByLabelText('Select Conroe'));
      await user.click(screen.getByLabelText('Select Shenandoah'));
      await user.click(screen.getByRole('button', { name: /merge…/i }));

      const name = await screen.findByLabelText(/canonical name/i);
      await user.clear(name);
      await user.type(name, 'The Woodlands');
      await user.click(screen.getByRole('button', { name: /^merge$/i }));

      await waitFor(() => {
        expect(mockMerge).toHaveBeenCalledWith({
          level: 'locality',
          countryCode: 'US',
          values: ['Conroe', 'Shenandoah'],
          canonicalName: 'The Woodlands',
        });
      });

      // The merge's own rebuild job is surfaced the way the Rebuild section does.
      await waitFor(
        () => {
          expect(screen.getByText(/rebuild job job-7 — pending/i)).toBeInTheDocument();
          expect(screen.queryByTestId('values-selection-bar')).not.toBeInTheDocument();
        },
        { timeout: 5000 },
      );
    });

    it('keeps the selection when the merge is rejected with a 409', async () => {
      const { ApiError } = await import('../../services/api');
      mockListValues.mockResolvedValue({
        items: WOODLANDS_PAGE,
        meta: { total: 2, page: 1, pageSize: 50 },
      });
      mockMerge.mockRejectedValue(
        new ApiError('"conroe" is already a member of "Conroe TX"', 409, undefined, {
          groupId: 'g-owner',
          groupName: 'Conroe TX',
        }),
      );

      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(await screen.findByLabelText('Select Conroe'));
      await user.click(screen.getByRole('button', { name: /merge…/i }));
      await user.click(await screen.findByRole('button', { name: /^merge$/i }));

      await waitFor(
        () => {
          expect(screen.getByText(/already in group "Conroe TX"/i)).toBeInTheDocument();
        },
        { timeout: 5000 },
      );
      expect(screen.getByTestId('values-selection-bar').textContent).toMatch(/1 selected/);
    });

    it('asks before merging a selection that spans two countries', async () => {
      mockListValues.mockResolvedValue({
        items: [
          makeValue({ value: 'Ontario', countryCode: 'CA', itemCount: 30 }),
          makeValue({ value: 'Ontario CA', countryCode: 'US', itemCount: 10 }),
        ],
        meta: { total: 2, page: 1, pageSize: 50 },
      });

      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(await screen.findByLabelText('Select Ontario'));
      await user.click(screen.getByLabelText('Select Ontario CA'));
      await user.click(screen.getByRole('button', { name: /merge…/i }));

      expect(await screen.findByText(/span 2 countries/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^merge$/i })).toBeDisabled();

      await user.click(screen.getByRole('checkbox', { name: /apply in every country/i }));
      await user.click(screen.getByRole('button', { name: /^merge$/i }));

      await waitFor(() => {
        expect(mockMerge).toHaveBeenCalledWith(expect.objectContaining({ countryCode: '' }));
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('groups list', () => {
    it('renders a group row with member/item counts', async () => {
      mockListGroups.mockResolvedValue({
        items: [makeGroup()],
        meta: { total: 1, page: 1, pageSize: 100 },
      });

      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const row = await screen.findByTestId('group-row-group-1');
      expect(within(row).getByText('Heredia')).toBeInTheDocument();
      expect(within(row).getByText('3 members')).toBeInTheDocument();
      expect(within(row).getByText('1,204 photos')).toBeInTheDocument();
    });

    it('PATCHes enabled=false when the row switch is turned off', async () => {
      mockListGroups.mockResolvedValue({
        items: [makeGroup()],
        meta: { total: 1, page: 1, pageSize: 100 },
      });
      mockUpdateGroup.mockResolvedValue({ id: 'group-1' } as any);

      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(await screen.findByLabelText('Enable Heredia'));

      await waitFor(() => {
        expect(mockUpdateGroup).toHaveBeenCalledWith('group-1', { enabled: false });
      });
    });

    it('deletes a group and drops the row', async () => {
      mockListGroups.mockResolvedValue({
        items: [makeGroup()],
        meta: { total: 1, page: 1, pageSize: 100 },
      });
      mockDeleteGroup.mockResolvedValue(undefined);

      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(await screen.findByLabelText('Delete Heredia'));

      await waitFor(() => {
        expect(mockDeleteGroup).toHaveBeenCalledWith('group-1');
        expect(screen.queryByTestId('group-row-group-1')).not.toBeInTheDocument();
      });
    });

    it('opens the editor dialog from "New group"', async () => {
      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(await screen.findByRole('button', { name: /new group/i }));

      expect(screen.getByTestId('editor-dialog')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('rebuild', () => {
    it('queues a rebuild and shows the returned job', async () => {
      mockRebuild.mockResolvedValue({ jobId: 'job-42', status: 'pending' });

      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(await screen.findByRole('button', { name: /rebuild now/i }));

      await waitFor(() => {
        expect(mockRebuild).toHaveBeenCalled();
      });
      expect(await screen.findByText(/rebuild job job-42 — pending/i)).toBeInTheDocument();
    });

    it('surfaces a rebuild failure', async () => {
      mockRebuild.mockRejectedValue(new Error('Queue unavailable'));

      const user = userEvent.setup();
      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await user.click(await screen.findByRole('button', { name: /rebuild now/i }));

      expect(await screen.findByText(/queue unavailable/i)).toBeInTheDocument();
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
      } as any);

      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

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
      } as any);

      render(<LocationGroupsSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument();
    });
  });
});
