/**
 * RTL tests for WorkflowRunsDrawer (issue #143 — Workflows Phase 5 admin UI).
 *
 * Purely presentational and props-driven — the parent owns fetching runs for
 * the selected workflow and the cancel-confirm flow — so these tests
 * exercise it directly with no mocked hooks or network layer.
 *
 * Covers:
 *   - Closed state renders nothing meaningful; open state shows the heading
 *     and workflow name.
 *   - Loading / error / empty states.
 *   - Row rendering: status chip, matched/succeeded/failed counts.
 *   - Admin-cancel action: the Cancel button is offered only for non-terminal
 *     runs, calls onCancel with the run, is disabled while canCancel is
 *     false or while that specific run is mid-cancel (cancellingRunId).
 *   - Close button calls onClose.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../utils/test-utils';
import { WorkflowRunsDrawer } from '../../../../components/workflows/admin/WorkflowRunsDrawer';
import type { AdminWorkflowRun } from '../../../../services/adminWorkflows';

function makeRun(overrides: Partial<AdminWorkflowRun> = {}): AdminWorkflowRun {
  return {
    id: 'run-1',
    workflowId: 'workflow-1',
    workflow: { id: 'workflow-1', name: 'Screenshot cleanup' },
    circleId: 'circle-1',
    circle: { id: 'circle-1', name: 'Family circle' },
    status: 'running',
    triggerType: 'manual',
    matchedCount: 100,
    truncated: false,
    processedCount: 40,
    succeededCount: 30,
    failedCount: 10,
    skippedCount: 0,
    startedById: 'user-1',
    approvedById: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    approvedAt: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastError: null,
    ...overrides,
  } as AdminWorkflowRun;
}

const baseProps = {
  open: true,
  workflowName: 'Screenshot cleanup',
  loading: false,
  error: null,
  canCancel: true,
  cancellingRunId: null,
  onCancel: vi.fn(),
  onClose: vi.fn(),
};

describe('WorkflowRunsDrawer', () => {
  describe('open/closed and header', () => {
    it('shows the "Run history" heading and workflow name when open', () => {
      render(<WorkflowRunsDrawer {...baseProps} runs={[]} />);

      expect(screen.getByRole('heading', { name: /run history/i })).toBeInTheDocument();
      expect(screen.getByText('Screenshot cleanup')).toBeInTheDocument();
    });

    it('falls back to "Workflow" when workflowName is null', () => {
      render(<WorkflowRunsDrawer {...baseProps} workflowName={null} runs={[]} />);

      expect(screen.getByText('Workflow')).toBeInTheDocument();
    });

    it('calls onClose when the close icon button is clicked', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<WorkflowRunsDrawer {...baseProps} runs={[]} onClose={onClose} />);

      await user.click(screen.getByRole('button', { name: /close run history/i }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('loading / error / empty states', () => {
    it('shows a loading spinner when loading with no runs yet', () => {
      render(<WorkflowRunsDrawer {...baseProps} runs={[]} loading />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows the error message in an Alert', () => {
      render(<WorkflowRunsDrawer {...baseProps} runs={[]} error="Failed to load runs" />);

      expect(screen.getByText('Failed to load runs')).toBeInTheDocument();
    });

    it('shows "No runs for this workflow yet." when runs is empty and not loading', () => {
      render(<WorkflowRunsDrawer {...baseProps} runs={[]} />);

      expect(screen.getByText(/no runs for this workflow yet/i)).toBeInTheDocument();
    });
  });

  describe('row rendering', () => {
    it('renders the status chip and matched/succeeded/failed counts', () => {
      const run = makeRun({ matchedCount: 100, succeededCount: 30, failedCount: 10 });
      render(<WorkflowRunsDrawer {...baseProps} runs={[run]} />);

      expect(screen.getByText('Running')).toBeInTheDocument();
      expect(screen.getByText('100')).toBeInTheDocument();
      expect(screen.getByText('30')).toBeInTheDocument();
      expect(screen.getByText('10')).toBeInTheDocument();
    });
  });

  describe('admin-cancel action', () => {
    it('offers a Cancel button for a non-terminal (running) run', () => {
      render(<WorkflowRunsDrawer {...baseProps} runs={[makeRun({ status: 'running' })]} />);

      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('does not offer a Cancel button for a terminal (completed) run — shows "—" instead', () => {
      render(<WorkflowRunsDrawer {...baseProps} runs={[makeRun({ status: 'completed' })]} />);

      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('does not offer a Cancel button for an awaiting_approval run — treated as non-terminal, still cancellable', () => {
      render(<WorkflowRunsDrawer {...baseProps} runs={[makeRun({ status: 'awaiting_approval' })]} />);

      // awaiting_approval is NOT in the terminal set, so Cancel is still offered.
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('calls onCancel with the run when Cancel is clicked', async () => {
      const user = userEvent.setup();
      const onCancel = vi.fn();
      const run = makeRun({ status: 'running' });
      render(<WorkflowRunsDrawer {...baseProps} runs={[run]} onCancel={onCancel} />);

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(onCancel).toHaveBeenCalledWith(run);
    });

    it('disables Cancel when canCancel is false (missing jobs:write)', () => {
      render(
        <WorkflowRunsDrawer
          {...baseProps}
          runs={[makeRun({ status: 'running' })]}
          canCancel={false}
        />,
      );

      expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
    });

    it('disables Cancel for the specific run currently being cancelled', () => {
      const run = makeRun({ id: 'run-target', status: 'running' });
      render(
        <WorkflowRunsDrawer {...baseProps} runs={[run]} cancellingRunId="run-target" />,
      );

      expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
    });

    it('does not disable Cancel for a different run while another run is mid-cancel', () => {
      const runA = makeRun({ id: 'run-a', status: 'running' });
      const runB = makeRun({ id: 'run-b', status: 'running' });
      render(
        <WorkflowRunsDrawer {...baseProps} runs={[runA, runB]} cancellingRunId="run-a" />,
      );

      const buttons = screen.getAllByRole('button', { name: /cancel/i });
      expect(buttons).toHaveLength(2);
      expect(buttons[0]).toBeDisabled(); // run-a: mid-cancel
      expect(buttons[1]).toBeEnabled(); // run-b: unaffected
    });
  });
});
