/**
 * RTL tests for WorkflowRunHistory (issue #142 — Workflows Phase 4 web UI).
 *
 * This component is props-driven and router-free (navigation is delegated
 * via `onOpenRun`), so these tests exercise it directly with no mocked
 * hooks or network layer.
 *
 * Covers:
 *   - Trigger badge label per `triggerType` (manual / on_media_enriched / scheduled).
 *   - Status chip label + succeeded/failed counts + "(truncated)" indicator,
 *     present only when `run.truncated` is true.
 *   - Empty state ("No runs yet").
 *   - Error state (Alert with the error message; row list not rendered).
 *   - Loading state (CircularProgress).
 *   - Clicking a run row calls `onOpenRun` with the clicked run.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { WorkflowRunHistory } from '../../../components/workflows/WorkflowRunHistory';
import type { WorkflowRun } from '../../../types/workflows';

let runCounter = 0;

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  runCounter += 1;
  return {
    id: `run-${runCounter}`,
    workflowId: 'workflow-1',
    circleId: 'circle-1',
    status: 'completed',
    triggerType: 'manual',
    matchedCount: 10,
    truncated: false,
    processedCount: 10,
    succeededCount: 9,
    failedCount: 1,
    skippedCount: 0,
    startedById: 'user-1',
    approvedById: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    approvedAt: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    lastError: null,
    ...overrides,
  };
}

describe('WorkflowRunHistory', () => {
  describe('trigger badges', () => {
    it('renders the correct trigger badge label for each triggerType', () => {
      const runs = [
        makeRun({ triggerType: 'manual' }),
        makeRun({ triggerType: 'on_media_enriched' }),
        makeRun({ triggerType: 'scheduled' }),
      ];

      render(
        <WorkflowRunHistory
          runs={runs}
          isLoading={false}
          error={null}
          onOpenRun={vi.fn()}
        />,
      );

      expect(screen.getByText('Manual')).toBeInTheDocument();
      expect(screen.getByText('On new media')).toBeInTheDocument();
      expect(screen.getByText('Scheduled')).toBeInTheDocument();
    });
  });

  describe('status chip and counts', () => {
    it('shows the status chip label and succeeded/failed counts', () => {
      const run = makeRun({
        status: 'completed_with_errors',
        succeededCount: 7,
        failedCount: 3,
      });

      render(
        <WorkflowRunHistory
          runs={[run]}
          isLoading={false}
          error={null}
          onOpenRun={vi.fn()}
        />,
      );

      expect(screen.getByText('Completed with errors')).toBeInTheDocument();
      expect(screen.getByText('✓7 ✗3')).toBeInTheDocument();
    });

    it('shows a "(truncated)" indicator when run.truncated is true', () => {
      const run = makeRun({ matchedCount: 10000, truncated: true });

      const { container } = render(
        <WorkflowRunHistory
          runs={[run]}
          isLoading={false}
          error={null}
          onOpenRun={vi.fn()}
        />,
      );

      expect(container.textContent).toMatch(/Matched .*\(truncated\)/);
    });

    it('does not show a "(truncated)" indicator when run.truncated is false', () => {
      const run = makeRun({ matchedCount: 42, truncated: false });

      const { container } = render(
        <WorkflowRunHistory
          runs={[run]}
          isLoading={false}
          error={null}
          onOpenRun={vi.fn()}
        />,
      );

      expect(container.textContent).not.toMatch(/\(truncated\)/);
      expect(container.textContent).toMatch(/Matched 42/);
    });
  });

  describe('empty state', () => {
    it('renders "No runs yet" when there are no runs', () => {
      render(
        <WorkflowRunHistory
          runs={[]}
          isLoading={false}
          error={null}
          onOpenRun={vi.fn()}
        />,
      );

      expect(screen.getByText('No runs yet')).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('renders the error message and does not render the row list', () => {
      const run = makeRun();

      render(
        <WorkflowRunHistory
          runs={[run]}
          isLoading={false}
          error="Failed to load runs"
          onOpenRun={vi.fn()}
        />,
      );

      expect(screen.getByText('Failed to load runs')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /open run from/i })).not.toBeInTheDocument();
    });
  });

  describe('loading state', () => {
    it('renders a loading indicator and no rows', () => {
      render(
        <WorkflowRunHistory
          runs={[]}
          isLoading
          error={null}
          onOpenRun={vi.fn()}
        />,
      );

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  describe('row click', () => {
    it('calls onOpenRun with the clicked run when a row is clicked', async () => {
      const user = userEvent.setup();
      const onOpenRun = vi.fn();
      const runA = makeRun({ triggerType: 'manual' });
      const runB = makeRun({ triggerType: 'scheduled' });

      render(
        <WorkflowRunHistory
          runs={[runA, runB]}
          isLoading={false}
          error={null}
          onOpenRun={onOpenRun}
        />,
      );

      const rows = screen.getAllByRole('button', { name: /open run from/i });
      expect(rows).toHaveLength(2);

      await user.click(rows[1]);

      expect(onOpenRun).toHaveBeenCalledTimes(1);
      expect(onOpenRun).toHaveBeenCalledWith(expect.objectContaining({ id: runB.id }));
    });
  });
});
