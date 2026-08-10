/**
 * Workflow builder — LocationPickerMap opt-out guard (issue #376).
 *
 * The location picker gained three behavioural props that default to ON
 * (`geolocateSetsValue`, `scrollWheelZoom`, `showPlaceholderMarker`). Neither
 * workflow-builder surface is a location editor — one edits a `set_location`
 * action param, the other a map-radius condition value — and issue #376's
 * acceptance criteria require both to stay visually and behaviourally
 * unchanged, so both must opt out of all three.
 *
 * LocationPickerMap is stubbed so the props can be inspected without pulling
 * Leaflet into jsdom.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '../../../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — declared BEFORE importing the modules under test
// ---------------------------------------------------------------------------

vi.mock('../../../../components/media/LocationPickerMap', () => ({
  LocationPickerMap: vi.fn(() => <div data-testid="location-picker-map" />),
}));

// ---------------------------------------------------------------------------
// Imports after mocks (Vitest requires this order)
// ---------------------------------------------------------------------------

import { ActionParamEditor } from '../../../../components/workflows/builder/ActionParamEditor';
import { ConditionValueEditor } from '../../../../components/workflows/builder/ConditionValueEditor';
import { LocationPickerMap } from '../../../../components/media/LocationPickerMap';
import type {
  WorkflowActionInstance,
  WorkflowFieldDescriptor,
} from '../../../../types/workflows';

const mockLocationPickerMap = vi.mocked(LocationPickerMap);

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeSetLocationAction(
  overrides: Partial<WorkflowActionInstance> = {},
): WorkflowActionInstance {
  return { type: 'set_location', ...overrides } as WorkflowActionInstance;
}

function makeGeoRadiusField(
  overrides: Partial<WorkflowFieldDescriptor> = {},
): WorkflowFieldDescriptor {
  return {
    key: 'near',
    label: 'Near location (map radius)',
    valueType: 'geo-radius',
    operators: ['within'],
    ...overrides,
  } as WorkflowFieldDescriptor;
}

/** Props the stubbed LocationPickerMap was last rendered with. */
function lastMapProps(): Record<string, unknown> {
  const calls = mockLocationPickerMap.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as unknown as Record<string, unknown>;
}

/** Every #376 behavioural addition must be explicitly disabled. */
function expectFullyOptedOut() {
  const props = lastMapProps();
  expect(props.geolocateSetsValue).toBe(false);
  expect(props.scrollWheelZoom).toBe(false);
  expect(props.showPlaceholderMarker).toBe(false);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActionParamEditor — set_location map opts out of the #376 additions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables geolocate-sets-value, scroll zoom and the placeholder marker', () => {
    render(
      <ActionParamEditor
        circleId="circle-1"
        action={makeSetLocationAction()}
        onChange={vi.fn()}
        tags={[]}
        albums={[]}
      />,
    );

    expectFullyOptedOut();
  });

  it('keeps the opt-out once a pin has been chosen', () => {
    render(
      <ActionParamEditor
        circleId="circle-1"
        action={makeSetLocationAction({ lat: 9.93, lng: -84.09 } as Partial<WorkflowActionInstance>)}
        onChange={vi.fn()}
        tags={[]}
        albums={[]}
      />,
    );

    expectFullyOptedOut();
    expect(lastMapProps().value).toEqual({ lat: 9.93, lng: -84.09 });
  });
});

describe('ConditionValueEditor — geo-radius map opts out of the #376 additions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables geolocate-sets-value, scroll zoom and the placeholder marker', () => {
    render(
      <ConditionValueEditor
        circleId="circle-1"
        field={makeGeoRadiusField()}
        op="within"
        value={null}
        onChange={vi.fn()}
        tags={[]}
        albums={[]}
      />,
    );

    expectFullyOptedOut();
    // An unset condition still passes a null value — no implicit centre.
    expect(lastMapProps().value).toBeNull();
  });

  it('keeps the opt-out once a centre has been chosen', () => {
    render(
      <ConditionValueEditor
        circleId="circle-1"
        field={makeGeoRadiusField()}
        op="within"
        value={{ lat: 9.93, lng: -84.09, radiusKm: 25 }}
        onChange={vi.fn()}
        tags={[]}
        albums={[]}
      />,
    );

    expectFullyOptedOut();
    expect(lastMapProps().value).toEqual({ lat: 9.93, lng: -84.09 });
  });
});
