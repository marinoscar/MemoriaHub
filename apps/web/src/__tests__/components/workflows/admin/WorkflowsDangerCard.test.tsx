/**
 * RTL tests for WorkflowsDangerCard (issue #143 — Workflows Phase 5 admin UI).
 *
 * Purely presentational and props-driven — the parent owns the
 * `workflows.allowHardDelete` value and the save call, so these tests
 * exercise it directly with no mocked hooks or network layer.
 *
 * Covers:
 *   - Toggle reflects the `allowHardDelete` prop (checked/unchecked).
 *   - Clicking the toggle calls `onToggle` with the flipped value (the
 *     "confirm flow" from the caller's perspective — the card itself has no
 *     internal confirmation step; WorkflowsSettingsPage decides what to do
 *     with the callback).
 *   - Disabled while `saving` or before `ready`.
 *   - The unlocked warning Alert appears only when `allowHardDelete` is true.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../utils/test-utils';
import { WorkflowsDangerCard } from '../../../../components/workflows/admin/WorkflowsDangerCard';

describe('WorkflowsDangerCard', () => {
  describe('toggle state', () => {
    it('is unchecked when allowHardDelete is false', () => {
      render(
        <WorkflowsDangerCard allowHardDelete={false} saving={false} ready onToggle={vi.fn()} />,
      );

      const toggle = screen.getByLabelText(/allow the hard-delete workflow action/i) as HTMLInputElement;
      expect(toggle.checked).toBe(false);
    });

    it('is checked when allowHardDelete is true', () => {
      render(
        <WorkflowsDangerCard allowHardDelete={true} saving={false} ready onToggle={vi.fn()} />,
      );

      const toggle = screen.getByLabelText(/allow the hard-delete workflow action/i) as HTMLInputElement;
      expect(toggle.checked).toBe(true);
    });
  });

  describe('toggle confirm flow (callback)', () => {
    it('calls onToggle(true) when clicked from unlocked=false', async () => {
      const user = userEvent.setup();
      const onToggle = vi.fn();
      render(
        <WorkflowsDangerCard allowHardDelete={false} saving={false} ready onToggle={onToggle} />,
      );

      await user.click(screen.getByLabelText(/allow the hard-delete workflow action/i));

      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(onToggle).toHaveBeenCalledWith(true);
    });

    it('calls onToggle(false) when clicked from unlocked=true', async () => {
      const user = userEvent.setup();
      const onToggle = vi.fn();
      render(
        <WorkflowsDangerCard allowHardDelete={true} saving={false} ready onToggle={onToggle} />,
      );

      await user.click(screen.getByLabelText(/allow the hard-delete workflow action/i));

      expect(onToggle).toHaveBeenCalledWith(false);
    });
  });

  describe('disabled states', () => {
    it('is disabled while saving', () => {
      render(
        <WorkflowsDangerCard allowHardDelete={false} saving={true} ready onToggle={vi.fn()} />,
      );

      expect(screen.getByLabelText(/allow the hard-delete workflow action/i)).toBeDisabled();
    });

    it('is disabled before settings are ready', () => {
      render(
        <WorkflowsDangerCard allowHardDelete={false} saving={false} ready={false} onToggle={vi.fn()} />,
      );

      expect(screen.getByLabelText(/allow the hard-delete workflow action/i)).toBeDisabled();
    });

    it('is enabled once ready and not saving', () => {
      render(
        <WorkflowsDangerCard allowHardDelete={false} saving={false} ready={true} onToggle={vi.fn()} />,
      );

      expect(screen.getByLabelText(/allow the hard-delete workflow action/i)).toBeEnabled();
    });
  });

  describe('unlocked warning', () => {
    it('does not show the warning Alert when allowHardDelete is false', () => {
      render(
        <WorkflowsDangerCard allowHardDelete={false} saving={false} ready onToggle={vi.fn()} />,
      );

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows the warning Alert with "unlocked" text when allowHardDelete is true', () => {
      render(
        <WorkflowsDangerCard allowHardDelete={true} saving={false} ready onToggle={vi.fn()} />,
      );

      const alert = screen.getByRole('alert');
      expect(alert.textContent).toMatch(/currently\s*unlocked/i);
    });
  });

  describe('static content', () => {
    it('always renders the Danger Zone heading and unrecoverable-deletion copy', () => {
      render(
        <WorkflowsDangerCard allowHardDelete={false} saving={false} ready onToggle={vi.fn()} />,
      );

      expect(screen.getByText(/danger zone/i)).toBeInTheDocument();
      expect(screen.getByText(/unrecoverable/i)).toBeInTheDocument();
    });
  });
});
