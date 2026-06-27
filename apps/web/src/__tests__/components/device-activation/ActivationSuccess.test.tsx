/**
 * ActivationSuccess — unit tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
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

  // -------------------------------------------------------------------------
  // returnUri — deep-link back to the originating app
  // -------------------------------------------------------------------------

  describe('returnUri prop — deep-link button', () => {
    beforeEach(() => {
      // Use fake timers to control the auto-redirect setTimeout
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows "Return to app" button when success=true and returnUri is a valid memoriahub: deep link', () => {
      render(
        <ActivationSuccess
          success={true}
          message="Device activated."
          returnUri="memoriahub://auth/device-complete"
        />,
      );
      expect(screen.getByRole('button', { name: /return to app/i })).toBeInTheDocument();
    });

    it('clicking "Return to app" sets window.location.href to the deep link', () => {
      let assignedHref = '';
      Object.defineProperty(window, 'location', {
        value: { ...window.location, set href(v: string) { assignedHref = v; } },
        configurable: true,
        writable: true,
      });

      render(
        <ActivationSuccess
          success={true}
          message="Device activated."
          returnUri="memoriahub://auth/device-complete"
        />,
      );

      // Use fireEvent to avoid interaction with fake timers
      fireEvent.click(screen.getByRole('button', { name: /return to app/i }));
      expect(assignedHref).toBe('memoriahub://auth/device-complete');
    });

    it('auto-redirects to the deep link after ~800 ms', () => {
      let assignedHref = '';
      Object.defineProperty(window, 'location', {
        value: { ...window.location, set href(v: string) { assignedHref = v; } },
        configurable: true,
        writable: true,
      });

      render(
        <ActivationSuccess
          success={true}
          message="Device activated."
          returnUri="memoriahub://auth/device-complete"
        />,
      );

      // Before timer fires, href should not be set
      expect(assignedHref).toBe('');

      // Advance timers past 800 ms
      vi.advanceTimersByTime(800);
      expect(assignedHref).toBe('memoriahub://auth/device-complete');
    });

    it('does NOT show "Return to app" button when returnUri has an unsafe scheme (http://)', () => {
      render(
        <ActivationSuccess
          success={true}
          message="Device activated."
          returnUri="http://evil.com/steal-token"
        />,
      );
      expect(screen.queryByRole('button', { name: /return to app/i })).not.toBeInTheDocument();
    });

    it('does NOT show "Return to app" button when returnUri is a javascript: URI', () => {
      render(
        <ActivationSuccess
          success={true}
          message="Device activated."
          returnUri="javascript:alert(1)"
        />,
      );
      expect(screen.queryByRole('button', { name: /return to app/i })).not.toBeInTheDocument();
    });

    it('does NOT show "Return to app" button when returnUri is a data: URI', () => {
      render(
        <ActivationSuccess
          success={true}
          message="Done!"
          returnUri="data:text/html,<script>alert(1)</script>"
        />,
      );
      expect(screen.queryByRole('button', { name: /return to app/i })).not.toBeInTheDocument();
    });

    it('does NOT auto-redirect when returnUri has an unsafe scheme', () => {
      let assignedHref = '';
      Object.defineProperty(window, 'location', {
        value: { ...window.location, set href(v: string) { assignedHref = v; } },
        configurable: true,
        writable: true,
      });

      render(
        <ActivationSuccess
          success={true}
          message="Done!"
          returnUri="http://evil.com"
        />,
      );

      vi.advanceTimersByTime(2000);
      expect(assignedHref).toBe('');
    });

    it('does NOT show "Return to app" button when success=false, even with a valid returnUri', () => {
      render(
        <ActivationSuccess
          success={false}
          message="Access denied."
          returnUri="memoriahub://auth/device-complete"
        />,
      );
      expect(screen.queryByRole('button', { name: /return to app/i })).not.toBeInTheDocument();
    });

    it('shows "close this page" tip (not Return to app) when returnUri is absent on success', () => {
      render(<ActivationSuccess success={true} message="Done!" />);
      expect(screen.queryByRole('button', { name: /return to app/i })).not.toBeInTheDocument();
      expect(screen.getByText(/close this page/i)).toBeInTheDocument();
    });

    it('accepts an https:// returnUri and shows the Return to app button', () => {
      render(
        <ActivationSuccess
          success={true}
          message="Done!"
          returnUri="https://app.example.com/callback"
        />,
      );
      expect(screen.getByRole('button', { name: /return to app/i })).toBeInTheDocument();
    });
  });
});
