/**
 * `TimezoneSettings` — unit tests (issue #444).
 *
 * `detectTimeZone`/`listTimeZones` are mocked so the "Detected" affordance can
 * be exercised deterministically: the real ones read whatever zone the CI
 * machine happens to be in.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { TimezoneSettings } from '../../../components/settings/TimezoneSettings';

vi.mock('../../../utils/timezone', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/timezone')>(
    '../../../utils/timezone',
  );
  return {
    ...actual,
    detectTimeZone: vi.fn(() => 'Europe/Madrid'),
    listTimeZones: vi.fn(() => [
      'America/Costa_Rica',
      'America/New_York',
      'Europe/Madrid',
      'UTC',
    ]),
  };
});

import { detectTimeZone } from '../../../utils/timezone';

const mockDetect = vi.mocked(detectTimeZone);

describe('TimezoneSettings', () => {
  const onTimezoneChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDetect.mockReturnValue('Europe/Madrid');
  });

  it('renders as a card with the #timezone anchor', () => {
    const { container } = render(
      <TimezoneSettings
        currentTimezone="America/Costa_Rica"
        onTimezoneChange={onTimezoneChange}
      />,
    );

    expect(container.querySelector('#timezone')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /time zone/i })).toBeInTheDocument();
  });

  it('renders the current value in the input', () => {
    render(
      <TimezoneSettings
        currentTimezone="America/Costa_Rica"
        onTimezoneChange={onTimezoneChange}
      />,
    );

    expect(screen.getByRole('combobox', { name: /time zone/i })).toHaveValue(
      'America/Costa_Rica',
    );
  });

  it('calls the handler with the IANA string when a zone is selected', async () => {
    const user = userEvent.setup();
    render(
      <TimezoneSettings
        currentTimezone="America/Costa_Rica"
        onTimezoneChange={onTimezoneChange}
      />,
    );

    const input = screen.getByRole('combobox', { name: /time zone/i });
    await user.click(input);
    await user.clear(input);
    await user.type(input, 'New_York');
    await user.click(await screen.findByRole('option', { name: 'America/New_York' }));

    expect(onTimezoneChange).toHaveBeenCalledTimes(1);
    expect(onTimezoneChange).toHaveBeenCalledWith('America/New_York');
  });

  it('shows the Detected affordance when the browser zone differs', async () => {
    const user = userEvent.setup();
    render(
      <TimezoneSettings
        currentTimezone="America/Costa_Rica"
        onTimezoneChange={onTimezoneChange}
      />,
    );

    expect(screen.getByText(/detected: europe\/madrid/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /use detected time zone/i }));
    expect(onTimezoneChange).toHaveBeenCalledWith('Europe/Madrid');
  });

  it('hides the Detected affordance when the browser zone already matches', () => {
    render(
      <TimezoneSettings
        currentTimezone="Europe/Madrid"
        onTimezoneChange={onTimezoneChange}
      />,
    );

    expect(screen.queryByText(/^detected:/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /use detected time zone/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the Detected affordance when nothing is stored yet', () => {
    render(
      <TimezoneSettings currentTimezone={null} onTimezoneChange={onTimezoneChange} />,
    );

    expect(screen.getByText(/detected: europe\/madrid/i)).toBeInTheDocument();
  });

  it('hides the Detected affordance when the browser reports nothing usable', () => {
    mockDetect.mockReturnValue(null);

    render(
      <TimezoneSettings
        currentTimezone="America/Costa_Rica"
        onTimezoneChange={onTimezoneChange}
      />,
    );

    expect(screen.queryByText(/^detected:/i)).not.toBeInTheDocument();
  });

  it('offers a stored zone the runtime does not enumerate', async () => {
    const user = userEvent.setup();
    render(
      <TimezoneSettings
        currentTimezone="Pacific/Chatham"
        onTimezoneChange={onTimezoneChange}
      />,
    );

    const input = screen.getByRole('combobox', { name: /time zone/i });
    expect(input).toHaveValue('Pacific/Chatham');

    await user.click(input);
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Pacific/Chatham')).toBeInTheDocument();
  });

  it('renders a live sample of the current time in the selected zone', () => {
    render(
      <TimezoneSettings
        currentTimezone="America/Costa_Rica"
        onTimezoneChange={onTimezoneChange}
      />,
    );

    expect(screen.getByText(/it is currently/i)).toBeInTheDocument();
  });

  it('explains that photo capture dates are unaffected', () => {
    render(
      <TimezoneSettings
        currentTimezone="America/Costa_Rica"
        onTimezoneChange={onTimezoneChange}
      />,
    );

    // The helper text is broken up by <strong>, so match the text node that
    // carries the actual claim rather than the whole paragraph.
    expect(
      screen.getByText(/change photo capture dates/i, { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByText(/today/i, { exact: false })).toBeInTheDocument();
  });

  it('disables the control while a save is in flight', () => {
    render(
      <TimezoneSettings
        currentTimezone="America/Costa_Rica"
        onTimezoneChange={onTimezoneChange}
        disabled
      />,
    );

    expect(screen.getByRole('combobox', { name: /time zone/i })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /use detected time zone/i }),
    ).toBeDisabled();
  });
});
