/**
 * RTL tests for WorkflowRunsDrawer — post-#261 (the shared-DataTable migration,
 * epic #238).
 *
 * ## This file carries the epic's container-query acceptance case
 *
 * `docs/specs/datatable.md` §7.2 states the rule this drawer exists to prove:
 * the renderer switch measures the table's OWN CONTAINER, never the viewport.
 * The drawer is ~570px of content on a 1440px desktop, so the correct rendering
 * is the CARD layout — a viewport media query would hand it the full desktop
 * grid and reintroduce horizontal scrolling on a desktop, which is the exact
 * defect epic #238 exists to remove.
 *
 * `installLayoutStubs()` pins `window.matchMedia` to a FIXED 1440px viewport,
 * so every viewport media query in the tree answers "desktop". A `mobile`
 * result therefore CANNOT have come from an accidental viewport match — it can
 * only have come from the container measurement. That is what makes the
 * assertion below meaningful rather than incidental.
 *
 * Scope note (§17.8 / §18.5): table mechanics live in
 * `runDataTableConformanceSuite` and are not re-tested here.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
  VIEWPORT_WIDTH,
} from '../../../../components/datatable/__tests__/testUtils/layoutStubs';
import { WorkflowRunsDrawer } from '../../../../components/workflows/admin/WorkflowRunsDrawer';
import {
  buildWorkflowRunColumns,
  shortRunId,
} from '../../../../components/workflows/admin/workflowRunsColumns';
import type { AdminWorkflowRun } from '../../../../services/adminWorkflows';
import { api } from '../../../../services/api';

/**
 * The drawer's real content width on a desktop: a 620px paper minus `p: 3`
 * (24px) on each side. Comfortably under the component's 600px container
 * threshold, which is why this table draws cards.
 */
const DRAWER_CONTENT_WIDTH = 620 - 48;

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

beforeAll(() => {
  installLayoutStubs();
});

describe('WorkflowRunsDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every test in this file renders at the drawer's REAL content width.
    resetContainerWidth(DRAWER_CONTENT_WIDTH);
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  // =========================================================================
  // Container-driven layout — issue #261's named acceptance case
  // =========================================================================

  describe('narrow container on a wide viewport (issue #261)', () => {
    it('renders CARDS in the drawer even though the viewport is a 1440px desktop', async () => {
      render(<WorkflowRunsDrawer {...baseProps} runs={[makeRun()]} />);

      // The viewport really is a desktop — this is what makes the assertion
      // below about the CONTAINER rather than about the window.
      expect(VIEWPORT_WIDTH).toBe(1440);
      expect(window.matchMedia('(min-width:1200px)').matches).toBe(true);

      const table = await screen.findByTestId('datatable');
      expect(table).toHaveAttribute('data-layout', 'mobile');
      expect(table).toHaveAttribute('data-renderer', 'mobile');

      // …and the card list, not a grid, is what was actually drawn.
      expect(screen.getByRole('list', { name: /workflow run history/i })).toBeInTheDocument();
      expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    });

    it('never lets the drawer scroll sideways: the table is width-contained', async () => {
      render(<WorkflowRunsDrawer {...baseProps} runs={[makeRun()]} />);

      const table = await screen.findByTestId('datatable');
      const styles = window.getComputedStyle(table);
      expect(styles.maxWidth).toBe('100%');
      expect(styles.minWidth).toBe('0px');
    });

    it('switches to the GRID when the same table is given a desktop-width container', async () => {
      // The mirror image of the first case: nothing about this component pins a
      // layout — only the measured width decides.
      resetContainerWidth(1400);
      render(<WorkflowRunsDrawer {...baseProps} runs={[makeRun()]} />);

      const table = await screen.findByTestId('datatable');
      expect(table).toHaveAttribute('data-layout', 'desktop');
      expect(screen.getByRole('grid', { name: /workflow run history/i })).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Column definitions (pure)
  // =========================================================================

  describe('column definitions', () => {
    const columns = buildWorkflowRunColumns();

    it('leads with the row-unique run id so per-row controls are nameable', () => {
      const firstPrimary = columns.find((column) => column.priority === 'primary')!;
      expect(firstPrimary.id).toBe('id');
      expect(firstPrimary.value!(makeRun({ id: 'abcdefgh-1234' }))).toBe('abcdefgh');
    });

    it('makes status a PRIMARY column so it lands in the card headline', () => {
      expect(columns.find((column) => column.id === 'status')!.priority).toBe('primary');
    });

    it('declares no sortable column — the endpoint accepts no sortBy', () => {
      expect(columns.some((column) => column.sortable)).toBe(false);
    });
  });

  // =========================================================================
  // Header / states
  // =========================================================================

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
    it('shows a loading overlay when loading with no runs yet', async () => {
      render(<WorkflowRunsDrawer {...baseProps} runs={[]} loading />);

      expect(await screen.findByTestId('datatable-loading-overlay')).toBeInTheDocument();
    });

    it('keeps the runs on screen during a background refresh', async () => {
      // The #261 loading contract: `loading` is a prop, never a gate.
      render(<WorkflowRunsDrawer {...baseProps} runs={[makeRun({ id: 'run-keepme' })]} loading />);

      expect(await screen.findByText(shortRunId('run-keepme'))).toBeInTheDocument();
      expect(screen.getByTestId('datatable-loading-overlay')).toBeInTheDocument();
    });

    it('shows the error message in an Alert', () => {
      render(<WorkflowRunsDrawer {...baseProps} runs={[]} error="Failed to load runs" />);

      expect(screen.getByText('Failed to load runs')).toBeInTheDocument();
    });

    it('shows "No runs for this workflow yet." when runs is empty and not loading', async () => {
      render(<WorkflowRunsDrawer {...baseProps} runs={[]} />);

      expect(await screen.findByText(/no runs for this workflow yet/i)).toBeInTheDocument();
    });
  });

  describe('row rendering', () => {
    it('renders the status chip and matched/succeeded/failed counts', async () => {
      const run = makeRun({ matchedCount: 100, succeededCount: 30, failedCount: 10 });
      render(<WorkflowRunsDrawer {...baseProps} runs={[run]} />);

      const card = await screen.findByTestId('datatable-card');
      expect(within(card).getByText('Running')).toBeInTheDocument();
      expect(within(card).getByText('100')).toBeInTheDocument();
      expect(within(card).getByText('30')).toBeInTheDocument();
      expect(within(card).getByText('10')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Admin-cancel action
  // =========================================================================

  describe('admin-cancel action', () => {
    async function openRowMenu(user: ReturnType<typeof userEvent.setup>, id = 'run-1') {
      await user.click(
        await screen.findByRole('button', { name: `Row actions for ${shortRunId(id)}` }),
      );
    }

    it('offers an enabled Cancel action for a non-terminal (running) run', async () => {
      const user = userEvent.setup();
      render(<WorkflowRunsDrawer {...baseProps} runs={[makeRun({ status: 'running' })]} />);

      await openRowMenu(user);

      expect(screen.getByRole('menuitem', { name: /cancel run/i })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('disables Cancel for a terminal (completed) run', async () => {
      // #259's rule: a per-row `disabled` replaces "render nothing", so the
      // control stays discoverable instead of silently becoming an em dash.
      const user = userEvent.setup();
      render(<WorkflowRunsDrawer {...baseProps} runs={[makeRun({ status: 'completed' })]} />);

      await openRowMenu(user);

      expect(screen.getByRole('menuitem', { name: /cancel run/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('keeps Cancel enabled for an awaiting_approval run — not a terminal status', async () => {
      const user = userEvent.setup();
      render(
        <WorkflowRunsDrawer {...baseProps} runs={[makeRun({ status: 'awaiting_approval' })]} />,
      );

      await openRowMenu(user);

      expect(screen.getByRole('menuitem', { name: /cancel run/i })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('calls onCancel with the run when Cancel is chosen', async () => {
      const user = userEvent.setup();
      const onCancel = vi.fn();
      const run = makeRun({ status: 'running' });
      render(<WorkflowRunsDrawer {...baseProps} runs={[run]} onCancel={onCancel} />);

      await openRowMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /cancel run/i }));

      expect(onCancel).toHaveBeenCalledWith(run);
    });

    it('omits the Cancel action entirely without jobs:write', async () => {
      // The permission gate is on the action ARRAY (§13.1), so it is absent
      // from the DOM rather than present-but-inert — in every renderer.
      render(
        <WorkflowRunsDrawer
          {...baseProps}
          runs={[makeRun({ status: 'running' })]}
          canCancel={false}
        />,
      );

      expect(await screen.findByTestId('datatable-card')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: `Row actions for ${shortRunId('run-1')}` }),
      ).not.toBeInTheDocument();
    });

    it('disables Cancel for the specific run currently being cancelled', async () => {
      const user = userEvent.setup();
      render(
        <WorkflowRunsDrawer
          {...baseProps}
          runs={[makeRun({ id: 'run-target', status: 'running' })]}
          cancellingRunId="run-target"
        />,
      );

      await openRowMenu(user, 'run-target');

      expect(screen.getByRole('menuitem', { name: /cancel run/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('does not disable Cancel for a different run while another run is mid-cancel', async () => {
      const user = userEvent.setup();
      render(
        <WorkflowRunsDrawer
          {...baseProps}
          runs={[
            makeRun({ id: 'run-aaaa', status: 'running' }),
            makeRun({ id: 'run-bbbb', status: 'running' }),
          ]}
          cancellingRunId="run-aaaa"
        />,
      );

      await openRowMenu(user, 'run-bbbb');

      expect(screen.getByRole('menuitem', { name: /cancel run/i })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });
  });
});
