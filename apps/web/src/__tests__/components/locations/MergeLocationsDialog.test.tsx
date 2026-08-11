/**
 * Unit tests for MergeLocationsDialog (issue #407).
 *
 * The shared dialog behind both merge surfaces — `/places` select mode and the
 * admin "All locations" browser. What is load-bearing here:
 *   - the target split: a new group sends `canonicalName`, an existing one
 *     sends `targetGroupId` and NEVER a name (adding must not rename);
 *   - the mixed-country prompt: a selection spanning two countries is never
 *     silently resolved to one of them, and only submits `countryCode: ''`
 *     after the user explicitly agrees;
 *   - the 409 path: the owning group is named from `details.groupName` and the
 *     dialog stays open so the caller's selection survives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../../services/locationGroups', async () => {
  const actual = await vi.importActual<typeof import('../../../services/locationGroups')>(
    '../../../services/locationGroups',
  );
  return {
    ...actual,
    listLocationGroups: vi.fn(),
    mergeLocationGroups: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import MergeLocationsDialog from '../../../components/locations/MergeLocationsDialog';
import type { MergeLocationCandidate } from '../../../components/locations/MergeLocationsDialog';
import { listLocationGroups, mergeLocationGroups } from '../../../services/locationGroups';
import type {
  LocationGroupSummary,
  MergeLocationGroupsResult,
} from '../../../services/locationGroups';

const mockListGroups = vi.mocked(listLocationGroups);
const mockMerge = vi.mocked(mergeLocationGroups);

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<MergeLocationCandidate> = {}): MergeLocationCandidate {
  return {
    value: 'Conroe',
    itemCount: 12,
    countryCode: 'US',
    groupCanonicalName: null,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<LocationGroupSummary> = {}): LocationGroupSummary {
  return {
    id: 'group-1',
    level: 'locality',
    canonicalName: 'The Woodlands',
    countryCode: 'US',
    memberCount: 2,
    itemCount: 500,
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

/**
 * Mirrors the real `POST /api/location-groups/merge` payload: the display name
 * lives at `group.canonicalName`, not at the top level — on the merge-into path
 * there is no new name, only the target group's existing one.
 */
function makeMergeResult(
  overrides: Partial<MergeLocationGroupsResult> = {},
): MergeLocationGroupsResult {
  return {
    groupId: 'g-new',
    created: true,
    added: 3,
    skipped: 0,
    jobId: 'job-1',
    status: 'pending',
    group: {
      ...makeGroup({ id: 'g-new', canonicalName: 'The Woodlands' }),
      normalizedName: 'the woodlands',
      aliases: [],
    },
    ...overrides,
  };
}

function renderDialog(props: Partial<React.ComponentProps<typeof MergeLocationsDialog>> = {}) {
  const onClose = vi.fn();
  const onMerged = vi.fn();
  const result = render(
    <MergeLocationsDialog
      open
      level="locality"
      selection={[
        makeCandidate({ value: 'Conroe', itemCount: 12 }),
        makeCandidate({ value: 'Shenandoah', itemCount: 4 }),
        makeCandidate({ value: 'The Woodlands', itemCount: 1188 }),
      ]}
      onClose={onClose}
      onMerged={onMerged}
      {...props}
    />,
  );
  return { ...result, onClose, onMerged };
}

// ---------------------------------------------------------------------------

describe('MergeLocationsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListGroups.mockResolvedValue({
      items: [makeGroup()],
      meta: { total: 1, page: 1, pageSize: 200 },
    });
    mockMerge.mockResolvedValue(makeMergeResult());
  });

  // -------------------------------------------------------------------------
  describe('prefill and preview', () => {
    it('prefills the name with the selected value that has the most photos', async () => {
      renderDialog();

      const name = await screen.findByLabelText(/canonical name/i);
      expect(name).toHaveValue('The Woodlands');
    });

    it('previews the location count, photo total and target name', async () => {
      renderDialog();

      const preview = await screen.findByTestId('merge-preview');
      expect(preview.textContent).toMatch(/3 locations/);
      expect(preview.textContent).toMatch(/1,204 photos/);
      expect(preview.textContent).toMatch(/The Woodlands/);
    });

    it('warns that the merge is not visible until the rebuild runs', async () => {
      renderDialog();

      expect(await screen.findByText(/rebuild/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('target selection', () => {
    it('creates a new group with the edited canonical name', async () => {
      const user = userEvent.setup();
      const { onMerged, onClose } = renderDialog();

      const name = await screen.findByLabelText(/canonical name/i);
      await user.clear(name);
      await user.type(name, 'Woodlands Area');
      await user.click(screen.getByRole('button', { name: /^merge$/i }));

      await waitFor(() => {
        expect(mockMerge).toHaveBeenCalledWith({
          level: 'locality',
          countryCode: 'US',
          values: ['Conroe', 'Shenandoah', 'The Woodlands'],
          canonicalName: 'Woodlands Area',
        });
      });
      expect(onMerged).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });

    it('sends targetGroupId, and neither a name nor a scope, when adding to an existing group', async () => {
      const user = userEvent.setup();
      renderDialog();

      await user.click(await screen.findByRole('radio', { name: /an existing group/i }));

      const picker = await screen.findByRole('combobox', { name: /existing group/i });
      await user.click(picker);
      await user.click(await screen.findByRole('option', { name: 'The Woodlands' }));

      await user.click(screen.getByRole('button', { name: /^merge$/i }));

      await waitFor(() => {
        expect(mockMerge).toHaveBeenCalledWith({
          level: 'locality',
          values: ['Conroe', 'Shenandoah', 'The Woodlands'],
          targetGroupId: 'group-1',
        });
      });
      const body = mockMerge.mock.calls[0][0] as Record<string, unknown>;
      // Adding must not rename the group…
      expect('canonicalName' in body).toBe(false);
      // …nor re-scope it: the API inherits the target's own countryCode, and a
      // non-empty one that disagreed would be a 400 the user cannot act on.
      expect('countryCode' in body).toBe(false);
    });

    it('disables Merge until an existing group is picked', async () => {
      const user = userEvent.setup();
      renderDialog();

      await user.click(await screen.findByRole('radio', { name: /an existing group/i }));

      expect(screen.getByRole('button', { name: /^merge$/i })).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  describe('country scoping', () => {
    it('submits the forced country code verbatim, including the unscoped sentinel', async () => {
      const user = userEvent.setup();
      renderDialog({ forcedCountryCode: '', level: 'region' });

      await user.click(await screen.findByRole('button', { name: /^merge$/i }));

      await waitFor(() => {
        expect(mockMerge).toHaveBeenCalledWith(
          expect.objectContaining({ level: 'region', countryCode: '' }),
        );
      });
    });

    it('prompts before making a mixed-country selection apply everywhere', async () => {
      const user = userEvent.setup();
      renderDialog({
        selection: [
          makeCandidate({ value: 'Ontario', itemCount: 30, countryCode: 'CA' }),
          makeCandidate({ value: 'Ontario', itemCount: 10, countryCode: 'US' }),
        ],
      });

      expect(await screen.findByText(/span 2 countries/i)).toBeInTheDocument();
      // Nothing may be submitted until the user explicitly agrees.
      expect(screen.getByRole('button', { name: /^merge$/i })).toBeDisabled();

      await user.click(screen.getByRole('checkbox', { name: /apply in every country/i }));

      expect(screen.getByRole('button', { name: /^merge$/i })).toBeEnabled();
      await user.click(screen.getByRole('button', { name: /^merge$/i }));

      await waitFor(() => {
        expect(mockMerge).toHaveBeenCalledWith(expect.objectContaining({ countryCode: '' }));
      });
    });

    it('drops the mixed-country prompt when adding to an existing group', async () => {
      const user = userEvent.setup();
      renderDialog({
        selection: [
          makeCandidate({ value: 'Ontario', itemCount: 30, countryCode: 'CA' }),
          makeCandidate({ value: 'Ontario County', itemCount: 10, countryCode: 'US' }),
        ],
      });

      expect(await screen.findByText(/span 2 countries/i)).toBeInTheDocument();

      // The target group's own scope governs, so there is nothing to decide.
      await user.click(screen.getByRole('radio', { name: /an existing group/i }));

      expect(screen.queryByText(/span 2 countries/i)).not.toBeInTheDocument();
    });

    it('does not prompt when every selected value shares one country', async () => {
      renderDialog();

      await screen.findByLabelText(/canonical name/i);
      expect(screen.queryByText(/span \d+ countries/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('409 conflict', () => {
    it('names the owning group and keeps the dialog open', async () => {
      const { ApiError } = await import('../../../services/api');
      mockMerge.mockRejectedValue(
        new ApiError('"conroe" is already a member of "Conroe TX"', 409, undefined, {
          groupId: 'g-owner',
          groupName: 'Conroe TX',
        }),
      );

      const user = userEvent.setup();
      const { onMerged, onClose } = renderDialog();

      await user.click(await screen.findByRole('button', { name: /^merge$/i }));

      expect(await screen.findByText(/already in group "Conroe TX"/i)).toBeInTheDocument();
      // The caller's selection must survive so the offender can be unticked.
      expect(onMerged).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByText(/Conroe \(12\)/)).toBeInTheDocument();
    });

    it('surfaces a non-409 failure as a plain error', async () => {
      mockMerge.mockRejectedValue(new Error('Queue unavailable'));

      const user = userEvent.setup();
      const { onClose } = renderDialog();

      await user.click(await screen.findByRole('button', { name: /^merge$/i }));

      expect(await screen.findByText(/queue unavailable/i)).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
