/**
 * SearchPanel — LocationPickerMap integration guard (issue #376).
 *
 * The location picker gained two behavioural props that default to ON
 * (`geolocateSetsValue`, `scrollWheelZoom`). SearchPanel is NOT a location
 * editor — it builds a search filter — so it must opt OUT of both, and its
 * pin-drop behaviour must be exactly what it was before.
 *
 * LocationPickerMap is stubbed (same approach as the neighbouring SearchPanel
 * suite) so we can inspect the props SearchPanel actually passes without
 * pulling Leaflet into jsdom.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — declared BEFORE importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../../../services/media', () => ({
  getLocationFacets: vi.fn(),
  getExploreTags: vi.fn(),
}));

vi.mock('../../../components/search/PersonMultiSelect', () => ({
  PersonMultiSelect: vi.fn(({ label }: { label: string }) => (
    <div data-testid="person-multi-select">{label}</div>
  )),
}));

vi.mock('../../../components/media/LocationPickerMap', () => ({
  LocationPickerMap: vi.fn(
    ({ onChange }: { onChange: (latlng: { lat: number; lng: number }) => void }) => (
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

import { SearchPanel } from '../../../components/search/SearchPanel';
import { getLocationFacets, getExploreTags } from '../../../services/media';
import { LocationPickerMap } from '../../../components/media/LocationPickerMap';

const mockGetLocationFacets = vi.mocked(getLocationFacets);
const mockGetExploreTags = vi.mocked(getExploreTags);
const mockLocationPickerMap = vi.mocked(LocationPickerMap);

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const CIRCLE_ID = 'circle-test-376';

function makeFacets() {
  return [
    {
      country: 'Costa Rica',
      countryCode: 'CR',
      count: 10,
      regions: [{ name: 'San José', count: 10, localities: [{ name: 'Heredia', count: 10 }] }],
    },
  ];
}

function makeProps(
  overrides: Partial<{
    open: boolean;
    onClose: ReturnType<typeof vi.fn>;
    onSubmit: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    open: true,
    circleId: CIRCLE_ID,
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
}

async function waitForLoaded() {
  await waitFor(() => {
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
}

/** Last props the stubbed LocationPickerMap was rendered with. */
function lastMapProps(): Record<string, unknown> {
  const calls = mockLocationPickerMap.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SearchPanel — location picker props are unchanged by #376', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLocationFacets.mockResolvedValue(makeFacets() as never);
    mockGetExploreTags.mockResolvedValue([]);
  });

  it('opts out of geolocate-sets-value so "Use my location" cannot write a filter', async () => {
    const user = userEvent.setup();
    render(<SearchPanel {...makeProps()} />);
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: /map radius/i }));

    expect(lastMapProps().geolocateSetsValue).toBe(false);
  });

  it('opts out of scroll-wheel zoom so the panel keeps scrolling normally', async () => {
    const user = userEvent.setup();
    render(<SearchPanel {...makeProps()} />);
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: /map radius/i }));

    expect(lastMapProps().scrollWheelZoom).toBe(false);
  });

  it('opts out of the placeholder marker so the panel is visually unchanged', async () => {
    const user = userEvent.setup();
    render(<SearchPanel {...makeProps()} />);
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: /map radius/i }));

    expect(lastMapProps().showPlaceholderMarker).toBe(false);
  });

  it('still submits filters.near when a pin is dropped', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<SearchPanel {...makeProps({ onSubmit })} />);
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: /map radius/i }));
    await user.click(screen.getByTestId('location-picker-map'));
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => {
      const call = onSubmit.mock.calls[0]?.[0] as { filters: Record<string, unknown> };
      expect(call.filters).toMatchObject({
        near: { lat: 9.93, lng: -84.09, radiusKm: expect.any(Number) },
      });
    });
  });
});
