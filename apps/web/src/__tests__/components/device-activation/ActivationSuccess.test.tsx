/**
 * ActivationSuccess — unit tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { ActivationSuccess } from '../../../components/device-activation/ActivationSuccess';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

describe('ActivationSuccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Success state', () => {
    it('shows "Device Authorized!" heading when success=true', () => {
      render(<ActivationSuccess success={true} message="Device activated." />);
      expect(screen.getByText(/device authorized!/i)).toBeInTheDocument();
    });

    it('shows the success message', () => {
      render(<ActivationSuccess success={true} message="Device activated." />);
      expect(screen.getByText('Device activated.')).toBeInTheDocument();
    });

    it('shows "close this page" tip on success', () => {
      render(<ActivationSuccess success={true} message="Done!" />);
      expect(screen.getByText(/close this page/i)).toBeInTheDocument();
    });

    it('does NOT show "Try Another Code" on success', () => {
      render(<ActivationSuccess success={true} message="Done!" />);
      expect(screen.queryByRole('button', { name: /try another code/i })).not.toBeInTheDocument();
    });

    it('navigates to / when "Go to Home" is clicked', async () => {
      const user = userEvent.setup();
      render(<ActivationSuccess success={true} message="Done!" />);

      await user.click(screen.getByRole('button', { name: /go to home/i }));
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  describe('Failure state', () => {
    it('shows "Device Access Denied" heading when success=false', () => {
      render(<ActivationSuccess success={false} message="Access denied." />);
      expect(screen.getByText(/device access denied/i)).toBeInTheDocument();
    });

    it('shows the denial message', () => {
      render(<ActivationSuccess success={false} message="Access denied." />);
      expect(screen.getByText('Access denied.')).toBeInTheDocument();
    });

    it('shows "Try Another Code" button on failure', () => {
      render(<ActivationSuccess success={false} message="No." />);
      expect(screen.getByRole('button', { name: /try another code/i })).toBeInTheDocument();
    });

    it('reloads the page when "Try Another Code" is clicked', async () => {
      const reloadMock = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { ...window.location, reload: reloadMock },
        configurable: true,
      });

      const user = userEvent.setup();
      render(<ActivationSuccess success={false} message="No." />);

      await user.click(screen.getByRole('button', { name: /try another code/i }));
      expect(reloadMock).toHaveBeenCalledTimes(1);
    });
  });
});
