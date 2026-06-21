/**
 * StorageSettings — trash retentionDays validation tests.
 *
 * Tests: retentionDays input renders, accepts valid values (1, 30, 365),
 * shows an error for out-of-range values (0, 366), and disables Save when
 * there is a validation error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { StorageSettings } from '../../../components/admin/StorageSettings';

// ---------------------------------------------------------------------------
// Default props
// ---------------------------------------------------------------------------
const defaultProps = {
  settings: {
    insights: { refreshIntervalHours: 4 },
    trash: { retentionDays: 30 },
  },
  onSave: vi.fn().mockResolvedValue(undefined),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('StorageSettings — trash retentionDays', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultProps.onSave.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  describe('Rendering', () => {
    it('renders the Trash section heading', () => {
      render(<StorageSettings {...defaultProps} />);
      // Multiple elements contain "Trash" (heading + helper text) so we check at least one is present
      expect(screen.getAllByText(/trash/i).length).toBeGreaterThan(0);
    });

    it('renders the retention days input', () => {
      render(<StorageSettings {...defaultProps} />);
      expect(
        screen.getByRole('spinbutton', { name: /trash retention period/i }),
      ).toBeInTheDocument();
    });

    it('shows the default value of 30 from settings', () => {
      render(<StorageSettings {...defaultProps} />);
      const input = screen.getByRole('spinbutton', {
        name: /trash retention period/i,
      }) as HTMLInputElement;
      expect(input.value).toBe('30');
    });

    it('reflects retentionDays from settings prop', () => {
      render(
        <StorageSettings
          {...defaultProps}
          settings={{ insights: { refreshIntervalHours: 4 }, trash: { retentionDays: 7 } }}
        />,
      );
      const input = screen.getByRole('spinbutton', {
        name: /trash retention period/i,
      }) as HTMLInputElement;
      expect(input.value).toBe('7');
    });
  });

  // -------------------------------------------------------------------------
  // Validation — accepts valid values
  // -------------------------------------------------------------------------
  describe('valid values', () => {
    it('accepts retentionDays = 1 (minimum) with no error', async () => {
      const user = userEvent.setup();
      render(<StorageSettings {...defaultProps} />);

      const input = screen.getByRole('spinbutton', { name: /trash retention period/i });
      await user.clear(input);
      await user.type(input, '1');

      // No error helper text for out-of-range
      expect(screen.queryByText(/must be between 1 and 365/i)).not.toBeInTheDocument();
    });

    it('accepts retentionDays = 365 (maximum) with no error', async () => {
      const user = userEvent.setup();
      render(<StorageSettings {...defaultProps} />);

      const input = screen.getByRole('spinbutton', { name: /trash retention period/i });
      await user.clear(input);
      await user.type(input, '365');

      expect(screen.queryByText(/must be between 1 and 365/i)).not.toBeInTheDocument();
    });

    it('accepts retentionDays = 30 (default) with no error', async () => {
      render(<StorageSettings {...defaultProps} />);
      expect(screen.queryByText(/must be between 1 and 365/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Validation — rejects invalid values
  // -------------------------------------------------------------------------
  describe('invalid values', () => {
    it('shows an error message when retentionDays = 0 (below minimum)', () => {
      render(<StorageSettings {...defaultProps} />);

      const input = screen.getByRole('spinbutton', { name: /trash retention period/i });
      fireEvent.change(input, { target: { value: '0' } });

      expect(screen.getByText(/must be between 1 and 365/i)).toBeInTheDocument();
    });

    it('shows an error message when retentionDays = 366 (above maximum)', () => {
      render(<StorageSettings {...defaultProps} />);

      const input = screen.getByRole('spinbutton', { name: /trash retention period/i });
      fireEvent.change(input, { target: { value: '366' } });

      expect(screen.getByText(/must be between 1 and 365/i)).toBeInTheDocument();
    });

    it('disables the Save Changes button when retentionDays is invalid', () => {
      render(<StorageSettings {...defaultProps} />);

      const input = screen.getByRole('spinbutton', { name: /trash retention period/i });
      fireEvent.change(input, { target: { value: '0' } });

      const saveBtn = screen.getByRole('button', { name: /save changes/i });
      expect(saveBtn).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  // Save — includes retentionDays in the payload
  // -------------------------------------------------------------------------
  describe('Save action', () => {
    it('calls onSave with the correct retentionDays when saved', async () => {
      const user = userEvent.setup();
      render(<StorageSettings {...defaultProps} />);

      const input = screen.getByRole('spinbutton', { name: /trash retention period/i });
      await user.clear(input);
      await user.type(input, '14');

      const saveBtn = screen.getByRole('button', { name: /save changes/i });
      await user.click(saveBtn);

      await waitFor(() => {
        expect(defaultProps.onSave).toHaveBeenCalledWith(
          expect.objectContaining({
            trash: { retentionDays: 14 },
          }),
        );
      });
    });

    it('Save Changes button is disabled when no changes have been made', () => {
      render(<StorageSettings {...defaultProps} />);
      const saveBtn = screen.getByRole('button', { name: /save changes/i });
      expect(saveBtn).toBeDisabled();
    });
  });
});
