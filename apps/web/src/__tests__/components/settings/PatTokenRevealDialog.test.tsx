/**
 * PatTokenRevealDialog — unit tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { PatTokenRevealDialog } from '../../../components/settings/PatTokenRevealDialog';

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  token: 'mhub_test_token_1234567890abcdef',
};

describe('PatTokenRevealDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('renders the dialog title', () => {
      render(<PatTokenRevealDialog {...defaultProps} />);
      expect(screen.getByText(/personal access token created/i)).toBeInTheDocument();
    });

    it('shows the warning about copying the token', () => {
      render(<PatTokenRevealDialog {...defaultProps} />);
      expect(screen.getByText(/copy your personal access token now/i)).toBeInTheDocument();
    });

    it('displays the token in a text field', () => {
      render(<PatTokenRevealDialog {...defaultProps} />);
      const input = screen.getByDisplayValue('mhub_test_token_1234567890abcdef');
      expect(input).toBeInTheDocument();
    });

    it('displays empty field when token is null', () => {
      render(<PatTokenRevealDialog {...defaultProps} token={null} />);
      const input = screen.getByLabelText(/your token/i);
      expect(input).toHaveValue('');
    });

    it('shows the copy button', () => {
      render(<PatTokenRevealDialog {...defaultProps} />);
      expect(screen.getByRole('button', { name: /copy token/i })).toBeInTheDocument();
    });

    it('shows the Done button', () => {
      render(<PatTokenRevealDialog {...defaultProps} />);
      expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
    });
  });

  describe('handleClose via Done button', () => {
    it('calls onClose when Done is clicked', async () => {
      const user = userEvent.setup();
      render(<PatTokenRevealDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /done/i }));
      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleCopy', () => {
    it('copies token to clipboard when copy button is clicked', async () => {
      const user = userEvent.setup();
      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: mockWriteText },
        configurable: true,
      });

      render(<PatTokenRevealDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /copy token/i }));

      await waitFor(() => {
        expect(mockWriteText).toHaveBeenCalledWith('mhub_test_token_1234567890abcdef');
      });
    });

    it('shows "copied" state after successful copy', async () => {
      const user = userEvent.setup();
      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: mockWriteText },
        configurable: true,
      });

      render(<PatTokenRevealDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /copy token/i }));

      await waitFor(() => {
        expect(screen.getByText(/token copied to clipboard/i)).toBeInTheDocument();
      });
    });

    it('does not crash when token is null and copy is clicked', async () => {
      const user = userEvent.setup();
      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: mockWriteText },
        configurable: true,
      });

      render(<PatTokenRevealDialog {...defaultProps} token={null} />);

      // Should not throw
      await user.click(screen.getByRole('button', { name: /copy token/i }));
      expect(mockWriteText).not.toHaveBeenCalled();
    });

    it('handles clipboard API failure gracefully', async () => {
      const user = userEvent.setup();
      const mockWriteText = vi.fn().mockRejectedValue(new Error('Permission denied'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: mockWriteText },
        configurable: true,
      });

      render(<PatTokenRevealDialog {...defaultProps} />);

      // Should not crash
      await user.click(screen.getByRole('button', { name: /copy token/i }));

      // Token copied alert should NOT appear since clipboard failed
      await waitFor(() => {
        expect(screen.queryByText(/token copied to clipboard/i)).not.toBeInTheDocument();
      });
    });
  });

  describe('Dialog not open', () => {
    it('does not render content when open is false', () => {
      render(<PatTokenRevealDialog {...defaultProps} open={false} />);
      // MUI Dialog hides content when closed
      expect(screen.queryByText(/personal access token created/i)).not.toBeInTheDocument();
    });
  });
});
