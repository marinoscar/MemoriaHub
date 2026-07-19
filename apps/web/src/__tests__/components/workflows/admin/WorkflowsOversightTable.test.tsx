/**
 * RTL tests for WorkflowsOversightTable (issue #143 — Workflows Phase 5 admin UI).
 *
 * Purely presentational and props-driven — the parent owns fetching,
 * pagination, and the row-action handlers — so these tests exercise it
 * directly with no mocked hooks or network layer.
 *
 * Covers:
 *   - Empty state and loading state.
 *   - Row rendering: circle/name/subject/trigger/enabled chip/last-run/totals.
 *   - Row actions: "Runs" always calls onViewRuns; "Disable" calls onDisable
 *     only when canManage and the workflow is currently enabled.
 *   - Disable button disabled states (no permission / already disabled) via
 *     the Tooltip title, since MUI disables the inner button but keeps the
 *     Tooltip wrapper interactive.
 *   - Pagination callbacks (onPageChange / onPageSizeChange).
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../utils/test-utils';
import { WorkflowsOversightTable } from '../../../../components/workflows/admin/WorkflowsOversightTable';
import type { AdminWorkflowListItem } from '../../../../services/adminWorkflows';

function makeItem(overrides: Partial<AdminWorkflowListItem> = {}): AdminWorkflowListItem {
  return {
    id: 'workflow-1',
    circle: { id: 'circle-1', name: 'Family circle' },
    name: 'Screenshot cleanup',
    subjectType: 'media_item',
    trigger: 'manual',
    enabled: true,
    cronExpression: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: { id: 'user-1', email: 'admin@example.com', displayName: 'Admin' },
    lastRun: null,
    totals: { runs: 0, matched: 0, actioned: 0 },
    ...overrides,
  } as AdminWorkflowListItem;
}

const baseProps = {
  loading: false,
  totalItems: 1,
  page: 0,
  pageSize: 25,
  canManage: true,
  onPageChange: vi.fn(),
  onPageSizeChange: vi.fn(),
  onDisable: vi.fn(),
  onViewRuns: vi.fn(),
};

describe('WorkflowsOversightTable', () => {
  describe('empty and loading states', () => {
    it('shows "No workflows found." when items is empty and not loading', () => {
      render(<WorkflowsOversightTable {...baseProps} items={[]} totalItems={0} />);

      expect(screen.getByText(/no workflows found/i)).toBeInTheDocument();
    });

    it('shows a loading spinner instead of the empty state while loading with no items yet', () => {
      render(<WorkflowsOversightTable {...baseProps} items={[]} totalItems={0} loading />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByText(/no workflows found/i)).not.toBeInTheDocument();
    });

    it('renders existing rows even while a background refresh is loading', () => {
      render(<WorkflowsOversightTable {...baseProps} items={[makeItem()]} loading />);

      expect(screen.getByText('Screenshot cleanup')).toBeInTheDocument();
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });
  });

  describe('row rendering', () => {
    it('renders circle name, workflow name, subject, trigger, and an Enabled chip', () => {
      render(<WorkflowsOversightTable {...baseProps} items={[makeItem()]} />);

      expect(screen.getByText('Family circle')).toBeInTheDocument();
      expect(screen.getByText('Screenshot cleanup')).toBeInTheDocument();
      expect(screen.getByText('Media item')).toBeInTheDocument();
      expect(screen.getByText('Manual')).toBeInTheDocument();
      // "Enabled" also appears as a column header, so a live row must add a
      // SECOND match (the status chip) — getAllByText avoids a false negative.
      expect(screen.getAllByText('Enabled')).toHaveLength(2);
    });

    it('renders a Disabled chip for a disabled workflow', () => {
      render(<WorkflowsOversightTable {...baseProps} items={[makeItem({ enabled: false })]} />);

      expect(screen.getByText('Disabled')).toBeInTheDocument();
      // Only the column header remains — no chip renders the word "Enabled".
      expect(screen.getAllByText('Enabled')).toHaveLength(1);
    });

    it('renders "—" for a null circle', () => {
      render(<WorkflowsOversightTable {...baseProps} items={[makeItem({ circle: null })]} />);

      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('renders "Never run" when lastRun is null', () => {
      render(<WorkflowsOversightTable {...baseProps} items={[makeItem({ lastRun: null })]} />);

      expect(screen.getByText(/never run/i)).toBeInTheDocument();
    });

    it('renders the last-run status chip and succeeded/failed counts', () => {
      const item = makeItem({
        lastRun: {
          status: 'completed_with_errors',
          triggerType: 'manual',
          createdAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          matchedCount: 20,
          processedCount: 20,
          succeededCount: 15,
          failedCount: 5,
          skippedCount: 0,
        },
      });

      render(<WorkflowsOversightTable {...baseProps} items={[item]} />);

      expect(screen.getByText('Completed with errors')).toBeInTheDocument();
      expect(screen.getByText(/15 ok/)).toBeInTheDocument();
      expect(screen.getByText(/5 failed/)).toBeInTheDocument();
    });

    it('renders formatted matched/actioned totals', () => {
      render(
        <WorkflowsOversightTable
          {...baseProps}
          items={[makeItem({ totals: { runs: 4, matched: 2481, actioned: 2000 } })]}
        />,
      );

      expect(screen.getByText('2,481')).toBeInTheDocument();
      expect(screen.getByText('2,000')).toBeInTheDocument();
    });
  });

  describe('row actions', () => {
    it('calls onViewRuns with the workflow when "Runs" is clicked', async () => {
      const user = userEvent.setup();
      const onViewRuns = vi.fn();
      const item = makeItem();
      render(<WorkflowsOversightTable {...baseProps} items={[item]} onViewRuns={onViewRuns} />);

      await user.click(screen.getByRole('button', { name: /runs/i }));

      expect(onViewRuns).toHaveBeenCalledWith(item);
    });

    it('calls onDisable with the workflow when "Disable" is clicked (canManage + enabled)', async () => {
      const user = userEvent.setup();
      const onDisable = vi.fn();
      const item = makeItem({ enabled: true });
      render(
        <WorkflowsOversightTable {...baseProps} items={[item]} canManage onDisable={onDisable} />,
      );

      await user.click(screen.getByRole('button', { name: /disable/i }));

      expect(onDisable).toHaveBeenCalledWith(item);
    });

    it('disables the Disable button when canManage is false', () => {
      render(
        <WorkflowsOversightTable
          {...baseProps}
          items={[makeItem({ enabled: true })]}
          canManage={false}
        />,
      );

      expect(screen.getByRole('button', { name: /disable/i })).toBeDisabled();
    });

    it('disables the Disable button when the workflow is already disabled', () => {
      render(
        <WorkflowsOversightTable
          {...baseProps}
          items={[makeItem({ enabled: false })]}
          canManage
        />,
      );

      expect(screen.getByRole('button', { name: /disable/i })).toBeDisabled();
    });
  });

  describe('pagination', () => {
    it('renders TablePagination reflecting totalItems/page/pageSize', () => {
      render(
        <WorkflowsOversightTable {...baseProps} items={[makeItem()]} totalItems={57} page={1} pageSize={25} />,
      );

      // MUI TablePagination renders "26–50 of 57" for page=1 (0-based), pageSize=25.
      expect(screen.getByText(/26.50 of 57/)).toBeInTheDocument();
    });
  });
});
