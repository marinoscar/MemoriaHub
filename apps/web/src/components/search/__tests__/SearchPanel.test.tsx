/**
 * Unit tests for SearchPanel — payload-building assertions.
 *
 * Exercises five core scenarios:
 *   A. Country picklist selected → onSubmit receives filters.country
 *   B. Map mode + pin dropped  → onSubmit receives filters.near
 *   C. Date range only          → onSubmit receives filters.capturedAt, no location
 *   D. Favorites flag ON/OFF    → onSubmit includes/omits filters.favorite
 *   E. AI description filled    → onSubmit receives semanticQuery (top-level)
 *
 * Heavy sub-components (LocationPickerMap, PersonMultiSelect) are stubbed so
 * tests run without Leaflet or async people fetches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../__tests__/utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — declared BEFORE importing the modules under test
// ---------------------------------------------------------------------------

// Mock location facets and explore tags — return minimal static data
vi.mock('../../../services/media', () => ({
  getLocationFacets: vi.fn(),
  getExploreTags: vi.fn(),
}));

// Stub PersonMultiSelect so it renders a simple placeholder (no async calls)
vi.mock('../PersonMultiSelect', () => ({
  PersonMultiSelect: vi.fn(({ label }: { label: string }) => (
    <div data-testid="person-multi-select">{label}</div>
  )),
}));

// Stub LocationPickerMap to render a button that simulates dropping a pin when clicked
vi.mock('../../media/LocationPickerMap', () => ({
  LocationPickerMap: vi.fn(
    ({
      onChange,
    }: {
      onChange: (latlng: { lat: number; lng: number }) => void;
      value: unknown;
      height?: number;
    }) => (
      <button
        data-testid="location-picker-map"
        onClick={() => onChange({ lat: 9.93, lng: -84.09 })}
      >
        Drop pin
      </button>
    ),
  ),
}));

// ---------------------------------------------------------------------------
// Imports after mocks (Vitest requires this order)
// ---------------------------------------------------------------------------

import { SearchPanel } from '../SearchPanel';
import { getLocationFacets, getExploreTags } from '../../../services/media';

const mockGetLocationFacets = vi.mocked(getLocationFacets);
const mockGetExploreTags = vi.mocked(getExploreTags);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CIRCLE_ID = 'circle-test-123';

/** Minimal LocationCountry with one country, one region, one locality */
const mockFacets = [
  {
    country: 'Costa Rica',
    countryCode: 'CR',
    count: 10,
    regions: [
      {
        name: 'San José',
        count: 10,
        localities: [{ name: 'Heredia', count: 10 }],
      },
    ],
  },
];

function defaultProps(overrides: Partial<{
  open: boolean;
  onClose: ReturnType<typeof vi.fn>;
  onSubmit: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    open: true,
    circleId: CIRCLE_ID,
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
}

/** Wait until the loading spinner disappears (facets+tags loaded). */
async function waitForLoaded() {
  await waitFor(() => {
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SearchPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLocationFacets.mockResolvedValue(mockFacets as any);
    mockGetExploreTags.mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  // A. Country picklist
  // -------------------------------------------------------------------------
  describe('A — country picklist selection', () => {
    it('calls onSubmit with filters.country when a country is selected', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      render(<SearchPanel {...defaultProps({ onSubmit })} />);

      await waitForLoaded();

      // Open the Country Autocomplete and select "Costa Rica (10)"
      const countryInput = screen.getByRole('combobox', { name: /country/i });
      await user.click(countryInput);

      const option = await screen.findByRole('option', { name: /Costa Rica/i });
      await user.click(option);

      await user.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            circleId: CIRCLE_ID,
            filters: expect.objectContaining({ country: 'Costa Rica' }),
          }),
        );
      });
    });

    it('does NOT include capturedAt when only country is selected', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      render(<SearchPanel {...defaultProps({ onSubmit })} />);

      await waitForLoaded();

      const countryInput = screen.getByRole('combobox', { name: /country/i });
      await user.click(countryInput);
      const option = await screen.findByRole('option', { name: /Costa Rica/i });
      await user.click(option);

      await user.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => {
        const call = onSubmit.mock.calls[0]?.[0] as any;
        expect(call.filters).not.toHaveProperty('capturedAt');
      });
    });
  });

  // -------------------------------------------------------------------------
  // B. Map mode + pin drop
  // -------------------------------------------------------------------------
  describe('B — map mode with dropped pin', () => {
    it('calls onSubmit with filters.near when map mode is active and pin is dropped', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      render(<SearchPanel {...defaultProps({ onSubmit })} />);

      await waitForLoaded();

      // Switch to Map radius mode
      await user.click(screen.getByRole('button', { name: /map radius/i }));

      // The stubbed LocationPickerMap renders a "Drop pin" button
      await user.click(screen.getByTestId('location-picker-map'));

      await user.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => {
        const call = onSubmit.mock.calls[0]?.[0] as any;
        expect(call.filters).toMatchObject({
          near: { lat: 9.93, lng: -84.09, radiusKm: expect.any(Number) },
        });
        // No picklist location keys
        expect(call.filters).not.toHaveProperty('country');
        expect(call.filters).not.toHaveProperty('region');
        expect(call.filters).not.toHaveProperty('locality');
      });
    });

    it('does NOT include filters.near when map mode is active but no pin dropped', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      render(<SearchPanel {...defaultProps({ onSubmit })} />);

      await waitForLoaded();

      // Switch to Map mode but do NOT click the map to drop a pin
      await user.click(screen.getByRole('button', { name: /map radius/i }));

      await user.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => {
        const call = onSubmit.mock.calls[0]?.[0] as any;
        expect(call.filters).not.toHaveProperty('near');
      });
    });
  });

  // -------------------------------------------------------------------------
  // C. Date range only
  // -------------------------------------------------------------------------
  describe('C — date range filter', () => {
    it('calls onSubmit with filters.capturedAt from/to when dates are filled', async () => {
      const onSubmit = vi.fn();
      render(<SearchPanel {...defaultProps({ onSubmit })} />);

      await waitForLoaded();

      // Fill the From date input — "Date taken" section renders before
      // "Upload date", both of which have From/To labeled fields, so pick
      // the first match.
      fireEvent.change(screen.getAllByLabelText(/^from$/i)[0], {
        target: { value: '2023-01-15' },
      });
      // Fill the To date input
      fireEvent.change(screen.getAllByLabelText(/^to$/i)[0], {
        target: { value: '2023-12-31' },
      });

      fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => {
        const call = onSubmit.mock.calls[0]?.[0] as any;
        expect(call.filters).toHaveProperty('capturedAt');
        expect(call.filters.capturedAt).toHaveProperty('from');
        expect(call.filters.capturedAt).toHaveProperty('to');
        // No location keys
        expect(call.filters).not.toHaveProperty('country');
        expect(call.filters).not.toHaveProperty('near');
      });
    });

    it('from ISO string starts at midnight UTC', async () => {
      const onSubmit = vi.fn();
      render(<SearchPanel {...defaultProps({ onSubmit })} />);
      await waitForLoaded();

      fireEvent.change(screen.getAllByLabelText(/^from$/i)[0], {
        target: { value: '2023-06-01' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => {
        const call = onSubmit.mock.calls[0]?.[0] as any;
        expect(call.filters.capturedAt.from).toMatch(/T00:00:00/);
      });
    });

    it('to ISO string ends at 23:59:59 UTC', async () => {
      const onSubmit = vi.fn();
      render(<SearchPanel {...defaultProps({ onSubmit })} />);
      await waitForLoaded();

      fireEvent.change(screen.getAllByLabelText(/^to$/i)[0], {
        target: { value: '2023-06-30' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => {
        const call = onSubmit.mock.calls[0]?.[0] as any;
        expect(call.filters.capturedAt.to).toMatch(/T23:59:59/);
      });
    });
  });

  // -------------------------------------------------------------------------
  // D. Favorites flag
  // -------------------------------------------------------------------------
  describe('D — favorites flag', () => {
    /**
     * Open the "More filters" accordion.
     * MUI AccordionSummary renders a div[role="button"]; if it's not
     * accessible by name (because its accessible name is only the icon),
     * we fall back to clicking the Typography text inside.
     */
    async function expandMoreFilters(user: ReturnType<typeof userEvent.setup>) {
      const btn = screen.queryByRole('button', { name: /more filters/i });
      if (btn) {
        await user.click(btn);
      } else {
        await user.click(screen.getByText(/more filters/i));
      }
    }

    /**
     * Find the "Favorites only" switch input via label association.
     * FormControlLabel wraps the label text around the input so
     * getByLabelText locates the underlying <input> regardless of role.
     */
    function getFavSwitch() {
      return screen.findByLabelText(/favorites only/i);
    }

    it('sends filters.favorite=true when switch is turned ON', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      render(<SearchPanel {...defaultProps({ onSubmit })} />);
      await waitForLoaded();

      await expandMoreFilters(user);

      const favSwitch = await getFavSwitch();
      await user.click(favSwitch);

      await user.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => {
        const call = onSubmit.mock.calls[0]?.[0] as any;
        expect(call.filters).toMatchObject({ favorite: true });
      });
    });

    it('omits filters.favorite when switch is OFF (default)', async () => {
      const onSubmit = vi.fn();
      render(<SearchPanel {...defaultProps({ onSubmit })} />);
      await waitForLoaded();

      fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => {
        const call = onSubmit.mock.calls[0]?.[0] as any;
        expect(call.filters).not.toHaveProperty('favorite');
      });
    });

    it('omits filters.favorite when switch is turned ON then OFF again', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      render(<SearchPanel {...defaultProps({ onSubmit })} />);
      await waitForLoaded();

      await expandMoreFilters(user);

      const favSwitch = await getFavSwitch();
      await user.click(favSwitch); // ON
      await user.click(favSwitch); // OFF

      await user.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => {
        const call = onSubmit.mock.calls[0]?.[0] as any;
        expect(call.filters).not.toHaveProperty('favorite');
      });
    });
  });

  // -------------------------------------------------------------------------
  // E. AI description / semanticQuery
  // -------------------------------------------------------------------------
  describe('E — AI description (semanticQuery)', () => {
    it('sends top-level semanticQuery when AI description is filled', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      render(<SearchPanel {...defaultProps({ onSubmit })} />);
      await waitForLoaded();

      const descInput = screen.getByRole('textbox', { name: /describe the photo/i });
      await user.clear(descInput);
      await user.type(descInput, 'sunset over the ocean');

      await user.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => {
        const call = onSubmit.mock.calls[0]?.[0] as any;
        expect(call.semanticQuery).toBe('sunset over the ocean');
      });
    });

    it('omits semanticQuery when AI description is blank', async () => {
      const onSubmit = vi.fn();
      render(<SearchPanel {...defaultProps({ onSubmit })} />);
      await waitForLoaded();

      fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => {
        const call = onSubmit.mock.calls[0]?.[0] as any;
        expect(call.semanticQuery).toBeUndefined();
      });
    });

    it('strips whitespace-only AI description (treats as empty)', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      render(<SearchPanel {...defaultProps({ onSubmit })} />);
      await waitForLoaded();

      const descInput = screen.getByRole('textbox', { name: /describe the photo/i });
      await user.type(descInput, '   ');

      await user.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => {
        const call = onSubmit.mock.calls[0]?.[0] as any;
        expect(call.semanticQuery).toBeUndefined();
      });
    });
  });

  // -------------------------------------------------------------------------
  // General wiring
  // -------------------------------------------------------------------------
  describe('general wiring', () => {
    it('calls onSubmit and onClose after clicking Search', async () => {
      const onSubmit = vi.fn();
      const onClose = vi.fn();

      render(<SearchPanel open circleId={CIRCLE_ID} onSubmit={onSubmit} onClose={onClose} />);
      await waitForLoaded();

      fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ circleId: CIRCLE_ID }),
        );
        expect(onClose).toHaveBeenCalled();
      });
    });

    it('always sends circleId in the onSubmit payload', async () => {
      const onSubmit = vi.fn();
      render(<SearchPanel {...defaultProps({ onSubmit })} />);
      await waitForLoaded();

      fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ circleId: CIRCLE_ID }),
        );
      });
    });
  });
});
