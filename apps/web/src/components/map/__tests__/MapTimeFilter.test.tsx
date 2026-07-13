/**
 * Component tests — MapTimeFilter
 *
 * Pure MUI component (no leaflet dependency) — renders a 5-way exclusive
 * ToggleButtonGroup (3M / 12M / 3Y / All / Custom) plus a Popover with two
 * native date inputs for the Custom range.
 *
 * Preset date math is asserted against a fixed system time (fake timers) so
 * the `from` ISO string comparisons are deterministic. Interactions use
 * `fireEvent` rather than `userEvent` — `@testing-library/user-event`
 * internally schedules via real timers unless `advanceTimers` is wired up,
 * which hangs (times out) under `vi.useFakeTimers()`. The click/change
 * handlers here are plain synchronous MUI callbacks, so `fireEvent` is
 * sufficient and avoids that interaction entirely.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '../../../__tests__/utils/test-utils';
import { MapTimeFilter } from '../MapTimeFilter';
import type { MapTimeRange } from '../MapTimeFilter';

const FIXED_NOW = new Date('2026-07-13T12:00:00.000Z');

describe('MapTimeFilter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  it('renders the toggle button group with all 5 presets', () => {
    const onChange = vi.fn();
    render(<MapTimeFilter onChange={onChange} />);

    expect(
      screen.getByRole('group', { name: /filter map by time range/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3M' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '12M' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3Y' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------
  // Presets
  // ---------------------------------------------------------------------

  it('calls onChange with { from: null, to: null } when "All" is clicked', () => {
    const onChange = vi.fn();
    render(<MapTimeFilter onChange={onChange} />);

    // "All" is the default-selected preset, and MUI's exclusive
    // ToggleButtonGroup does not fire onChange when re-clicking the
    // already-active value (it emits `null`, which the component's handler
    // explicitly ignores to keep an exclusive choice). Select a different
    // preset first so the click on "All" is a genuine selection change.
    fireEvent.click(screen.getByRole('button', { name: '3M' }));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(onChange).toHaveBeenLastCalledWith({ from: null, to: null });
  });

  it('calls onChange with a from date ~12 months before now when "12M" is clicked', () => {
    const onChange = vi.fn();
    render(<MapTimeFilter onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '12M' }));

    const expected = new Date(FIXED_NOW);
    expected.setFullYear(expected.getFullYear() - 1);

    expect(onChange).toHaveBeenCalledWith({
      from: expected.toISOString(),
      to: null,
    });
  });

  it('calls onChange with a from date ~3 months before now when "3M" is clicked', () => {
    const onChange = vi.fn();
    render(<MapTimeFilter onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '3M' }));

    const expected = new Date(FIXED_NOW);
    expected.setMonth(expected.getMonth() - 3);

    expect(onChange).toHaveBeenCalledWith({
      from: expected.toISOString(),
      to: null,
    });
  });

  it('calls onChange with a from date ~3 years before now when "3Y" is clicked', () => {
    const onChange = vi.fn();
    render(<MapTimeFilter onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '3Y' }));

    const expected = new Date(FIXED_NOW);
    expected.setFullYear(expected.getFullYear() - 3);

    expect(onChange).toHaveBeenCalledWith({
      from: expected.toISOString(),
      to: null,
    });
  });

  // ---------------------------------------------------------------------
  // Custom range
  // ---------------------------------------------------------------------

  it('opens a popover with From/To date inputs when "Custom" is clicked', () => {
    const onChange = vi.fn();
    render(<MapTimeFilter onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

    expect(screen.getByLabelText('From')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('To')).toHaveAttribute('type', 'date');
  });

  it('calls onChange with an empty range immediately when "Custom" is selected', () => {
    const onChange = vi.fn();
    render(<MapTimeFilter onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

    expect(onChange).toHaveBeenLastCalledWith({ from: null, to: null });
  });

  it('calls onChange with the parsed From date at T00:00:00 local time when typed', () => {
    const onChange = vi.fn();
    render(<MapTimeFilter onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    onChange.mockClear();

    const fromInput = screen.getByLabelText('From');
    fireEvent.change(fromInput, { target: { value: '2024-03-15' } });

    const expectedFrom = new Date('2024-03-15T00:00:00').toISOString();
    expect(onChange).toHaveBeenLastCalledWith({ from: expectedFrom, to: null });
  });

  it('calls onChange with the parsed To date at T23:59:59.999 local time when typed', () => {
    const onChange = vi.fn();
    render(<MapTimeFilter onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    onChange.mockClear();

    const toInput = screen.getByLabelText('To');
    fireEvent.change(toInput, { target: { value: '2024-06-30' } });

    const expectedTo = new Date('2024-06-30T23:59:59.999').toISOString();
    expect(onChange).toHaveBeenLastCalledWith({ from: null, to: expectedTo });
  });

  it('combines From and To when both are typed', () => {
    const onChange = vi.fn();
    render(<MapTimeFilter onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

    const fromInput = screen.getByLabelText('From');
    fireEvent.change(fromInput, { target: { value: '2024-03-15' } });

    const toInput = screen.getByLabelText('To');
    fireEvent.change(toInput, { target: { value: '2024-06-30' } });

    const expectedFrom = new Date('2024-03-15T00:00:00').toISOString();
    const expectedTo = new Date('2024-06-30T23:59:59.999').toISOString();
    expect(onChange).toHaveBeenLastCalledWith({ from: expectedFrom, to: expectedTo });
  });

  // Type-only sanity check (not a runtime assertion) — ensures the exported
  // MapTimeRange type shape matches what onChange receives.
  it('exports a MapTimeRange type usable by callers', () => {
    const sample: MapTimeRange = { from: null, to: null };
    expect(sample).toEqual({ from: null, to: null });
  });
});
