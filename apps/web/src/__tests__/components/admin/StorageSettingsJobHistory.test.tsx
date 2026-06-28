/**
 * StorageSettings — Job History section tests.
 *
 * Tests: job history retention input renders, accepts valid values (1, 365),
 * shows error for out-of-range (0, 366), the purge switch renders and toggles,
 * saving calls onSaveJobs with { history: { retentionDays, purgeEnabled } }.
 *
 * The Job History section is only rendered when onSaveJobs prop is provided.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { StorageSettings } from '../../../components/admin/StorageSettings';

// ---------------------------------------------------------------------------
// Default props — includes onSaveJobs so the Job History section is rendered
// ---------------------------------------------------------------------------

const defaultStorageSettings = {
  insights: { refreshIntervalHours: 4 },
  trash: { retentionDays: 30 },
};

const defaultJobsSettings = {
  history: { retentionDays: 30, purgeEnabled: true },
};

function makeProps(overrides: {
  settings?: typeof defaultStorageSettings;
  jobsSettings?: typeof defaultJobsSettings | null;
  onSave?: ReturnType<typeof vi.fn>;
  onSaveJobs?: ReturnType<typeof vi.fn> | null;
} = {}) {
  return {
    settings: overrides.settings ?? defaultStorageSettings,
    jobsSettings: overrides.jobsSettings ?? defaultJobsSettings,
    onSave: overrides.onSave ?? vi.fn().mockResolvedValue(undefined),
    onSaveJobs:
      overrides.onSaveJobs !== null
        ? (overrides.onSaveJobs ?? vi.fn().mockResolvedValue(undefined))
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StorageSettings — Job History section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Section renders when onSaveJobs is provided
  // =========================================================================

  describe('section visibility', () => {
    it('renders the Job History heading when onSaveJobs is provided', () => {
      render(<StorageSettings {...makeProps()} />);

      expect(screen.getByText('Job History')).toBeInTheDocument();
    });

    it('does NOT render the Job History section when onSaveJobs is undefined', () => {
      render(<StorageSettings {...makeProps({ onSaveJobs: null })} />);

      expect(screen.queryByText('Job History')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Rendering
  // =========================================================================

  describe('Rendering', () => {
    it('renders the job history retention input', () => {
      render(<StorageSettings {...makeProps()} />);

      expect(
        screen.getByRole('spinbutton', { name: /Job history retention/i }),
      ).toBeInTheDocument();
    });

    it('shows the default value of 30 from jobsSettings', () => {
      render(<StorageSettings {...makeProps()} />);

      const input = screen.getByRole('spinbutton', {
        name: /Job history retention/i,
      }) as HTMLInputElement;
      expect(input.value).toBe('30');
    });

    it('reflects custom retentionDays from jobsSettings prop', () => {
      render(
        <StorageSettings
          {...makeProps({
            jobsSettings: { history: { retentionDays: 14, purgeEnabled: true } },
          })}
        />,
      );

      const input = screen.getByRole('spinbutton', {
        name: /Job history retention/i,
      }) as HTMLInputElement;
      expect(input.value).toBe('14');
    });

    it('renders the Auto-purge old job records switch', () => {
      render(<StorageSettings {...makeProps()} />);

      expect(screen.getByText(/Auto-purge old job records/i)).toBeInTheDocument();
    });

    it('shows the purge switch as checked when purgeEnabled=true', () => {
      render(
        <StorageSettings
          {...makeProps({
            jobsSettings: { history: { retentionDays: 30, purgeEnabled: true } },
          })}
        />,
      );

      // MUI Switch renders with role="switch" (not "checkbox")
      const switchEl = screen.getByRole('switch', { name: /Auto-purge old job records/i });
      expect((switchEl as HTMLInputElement).checked).toBe(true);
    });

    it('shows the purge switch as unchecked when purgeEnabled=false', () => {
      render(
        <StorageSettings
          {...makeProps({
            jobsSettings: { history: { retentionDays: 30, purgeEnabled: false } },
          })}
        />,
      );

      // MUI Switch renders with role="switch" (not "checkbox")
      const switchEl = screen.getByRole('switch', { name: /Auto-purge old job records/i });
      expect((switchEl as HTMLInputElement).checked).toBe(false);
    });

    it('renders the Save Job Settings button', () => {
      render(<StorageSettings {...makeProps()} />);

      expect(screen.getByRole('button', { name: /Save Job Settings/i })).toBeInTheDocument();
    });

    it('Save Job Settings button is disabled when no changes have been made', () => {
      render(<StorageSettings {...makeProps()} />);

      const saveBtn = screen.getByRole('button', { name: /Save Job Settings/i });
      expect(saveBtn).toBeDisabled();
    });
  });

  // =========================================================================
  // Validation — retentionDays
  // =========================================================================

  describe('retentionDays validation', () => {
    it('shows an error message when retentionDays = 0 (below minimum)', () => {
      render(<StorageSettings {...makeProps()} />);

      const input = screen.getByRole('spinbutton', { name: /Job history retention/i });
      fireEvent.change(input, { target: { value: '0' } });

      expect(screen.getByText(/Must be between 1 and 365/i)).toBeInTheDocument();
    });

    it('shows an error message when retentionDays = 366 (above maximum)', () => {
      render(<StorageSettings {...makeProps()} />);

      const input = screen.getByRole('spinbutton', { name: /Job history retention/i });
      fireEvent.change(input, { target: { value: '366' } });

      expect(screen.getByText(/Must be between 1 and 365/i)).toBeInTheDocument();
    });

    it('disables Save Job Settings button when retentionDays is invalid', () => {
      render(<StorageSettings {...makeProps()} />);

      const input = screen.getByRole('spinbutton', { name: /Job history retention/i });
      fireEvent.change(input, { target: { value: '0' } });

      const saveBtn = screen.getByRole('button', { name: /Save Job Settings/i });
      expect(saveBtn).toBeDisabled();
    });

    it('accepts retentionDays = 1 (minimum) with no error', async () => {
      const user = userEvent.setup();
      render(<StorageSettings {...makeProps()} />);

      const input = screen.getByRole('spinbutton', { name: /Job history retention/i });
      await user.clear(input);
      await user.type(input, '1');

      expect(screen.queryByText(/Must be between 1 and 365/i)).not.toBeInTheDocument();
    });

    it('accepts retentionDays = 365 (maximum) with no error', async () => {
      const user = userEvent.setup();
      render(<StorageSettings {...makeProps()} />);

      const input = screen.getByRole('spinbutton', { name: /Job history retention/i });
      await user.clear(input);
      await user.type(input, '365');

      expect(screen.queryByText(/Must be between 1 and 365/i)).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Save — calls onSaveJobs with correct payload
  // =========================================================================

  describe('Save action', () => {
    it('calls onSaveJobs with updated retentionDays when saved', async () => {
      const mockOnSaveJobs = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(<StorageSettings {...makeProps({ onSaveJobs: mockOnSaveJobs })} />);

      const input = screen.getByRole('spinbutton', { name: /Job history retention/i });
      await user.clear(input);
      await user.type(input, '14');

      const saveBtn = screen.getByRole('button', { name: /Save Job Settings/i });
      await user.click(saveBtn);

      await waitFor(() => {
        expect(mockOnSaveJobs).toHaveBeenCalledWith(
          expect.objectContaining({
            history: expect.objectContaining({ retentionDays: 14 }),
          }),
        );
      });
    });

    it('calls onSaveJobs with purgeEnabled when switch is toggled', async () => {
      const mockOnSaveJobs = vi.fn().mockResolvedValue(undefined);
      render(<StorageSettings {...makeProps({ onSaveJobs: mockOnSaveJobs })} />);

      // Toggle the switch (from true to false) — MUI Switch renders with role="switch"
      const switchEl = screen.getByRole('switch', { name: /Auto-purge old job records/i });
      fireEvent.click(switchEl);

      const saveBtn = screen.getByRole('button', { name: /Save Job Settings/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(mockOnSaveJobs).toHaveBeenCalledWith(
          expect.objectContaining({
            history: expect.objectContaining({ purgeEnabled: false }),
          }),
        );
      });
    });

    it('calls onSaveJobs with both retentionDays and purgeEnabled in payload', async () => {
      const mockOnSaveJobs = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(<StorageSettings {...makeProps({ onSaveJobs: mockOnSaveJobs })} />);

      // Change retentionDays
      const input = screen.getByRole('spinbutton', { name: /Job history retention/i });
      await user.clear(input);
      await user.type(input, '60');

      const saveBtn = screen.getByRole('button', { name: /Save Job Settings/i });
      await user.click(saveBtn);

      await waitFor(() => {
        expect(mockOnSaveJobs).toHaveBeenCalledWith({
          history: {
            retentionDays: 60,
            purgeEnabled: true, // unchanged
          },
        });
      });
    });

    it('enables Save Job Settings button when retentionDays changes', async () => {
      const user = userEvent.setup();
      render(<StorageSettings {...makeProps()} />);

      const input = screen.getByRole('spinbutton', { name: /Job history retention/i });
      await user.clear(input);
      await user.type(input, '7');

      const saveBtn = screen.getByRole('button', { name: /Save Job Settings/i });
      expect(saveBtn).not.toBeDisabled();
    });

    it('enables Save Job Settings button when purgeEnabled switch is toggled', () => {
      render(<StorageSettings {...makeProps()} />);

      // MUI Switch renders with role="switch" (not "checkbox")
      const switchEl = screen.getByRole('switch', { name: /Auto-purge old job records/i });
      fireEvent.click(switchEl);

      const saveBtn = screen.getByRole('button', { name: /Save Job Settings/i });
      expect(saveBtn).not.toBeDisabled();
    });
  });
});
