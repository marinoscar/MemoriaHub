/**
 * RTL tests for WorkflowRunPage (issue #141 — Workflows Phase 3 web UI).
 *
 * Covers three issue bullets:
 *   - "Approval typed-confirmation gate": on a hard_delete run, the Approve
 *     button stays disabled until the user types `DELETE {matchedCount}`.
 *   - "Exclusion checkboxes": checking items accumulates excluded ids, and
 *     the ≤500 exclusion cap disables further checkboxes once reached.
 *   - "Progress polling": while a run is non-terminal, the run detail is
 *     re-fetched on the 2s interval (fake timers); polling stops once the
 *     run reaches a terminal status.
 *
 * All data hooks are mocked directly (mirroring the DuplicateGroupPage.test
 * precedent), so these tests exercise WorkflowRunPage's own render/effect
 * logic without a real network or MSW handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../../hooks/useWorkflowRun', () => ({
  useWorkflowRun: vi.fn(),
}));

vi.mock('../../../hooks/useWorkflowRunItems', () => ({
  useWorkflowRunItems: vi.fn(),
}));

vi.mock('../../../hooks/useWorkflowMutations', () => ({
  useWorkflowMutations: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ id: 'wf-1', runId: 'run-1' }),
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import WorkflowRunPage from '../../../pages/Workflows/WorkflowRunPage';
import { usePermissions } from '../../../hooks/usePermissions';
import { useCircle } from '../../../hooks/useCircle';
import { useWorkflowRun } from '../../../hooks/useWorkflowRun';
import { useWorkflowRunItems } from '../../../hooks/useWorkflowRunItems';
import { useWorkflowMutations } from '../../../hooks/useWorkflowMutations';
import type { WorkflowRunDetail, WorkflowRunItem } from '../../../types/workflows';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseCircle = vi.mocked(useCircle);
const mockUseWorkflowRun = vi.mocked(useWorkflowRun);
const mockUseWorkflowRunItems = vi.mocked(useWorkflowRunItems);
const mockUseWorkflowMutations = vi.mocked(useWorkflowMutations);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCircleContext(overrides: Partial<ReturnType<typeof useCircle>> = {}) {
  return {
    activeCircle: { id: 'circle-1', name: 'Test Circle', description: null, ownerId: 'user-1', isPersonal: false, createdAt: '', updatedAt: '' },
    activeCircleId: 'circle-1',
    activeCircleRole: 'collaborator',
    circles: [],
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ReturnType<typeof useCircle>;
}

function makePermissions(perms: string[] = ['media:write', 'media:delete']) {
  return {
    permissions: new Set(perms),
    roles: new Set<string>(),
    hasPermission: (p: string) => perms.includes(p),
    hasAnyPermission: () => true,
    hasAllPermissions: () => true,
    hasRole: () => false,
    hasAnyRole: () => false,
    isAdmin: false,
  } as unknown as ReturnType<typeof usePermissions>;
}

function makeRun(overrides: Partial<WorkflowRunDetail> = {}): WorkflowRunDetail {
  return {
    id: 'run-1',
    workflowId: 'wf-1',
    circleId: 'circle-1',
    status: 'awaiting_approval',
    triggerType: 'manual',
    matchedCount: 5,
    truncated: false,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedById: null,
    approvedById: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    approvedAt: null,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    definitionSnapshot: {
      version: 1,
      subject: 'media_item',
      match: 'all',
      conditions: [],
      actions: [{ type: 'move_to_trash' }],
    },
    itemStatusCounts: {},
    actionSummary: { scanned: 0, partial: false, byActionType: {} },
    ...overrides,
  };
}

function makeItem(id: string, overrides: Partial<WorkflowRunItem> = {}): WorkflowRunItem {
  return {
    id,
    mediaItemId: id,
    status: 'matched',
    actionResults: null,
    error: null,
    updatedAt: '2025-01-01T00:00:00.000Z',
    media: { type: 'photo', capturedAt: null, filename: `${id}.jpg`, width: 100, height: 100 },
    thumbnailUrl: null,
    ...overrides,
  };
}

type RunHookReturn = ReturnType<typeof useWorkflowRun>;
function makeRunHook(overrides: Partial<RunHookReturn> = {}): RunHookReturn {
  return {
    run: makeRun(),
    isLoading: false,
    error: null,
    fetchRun: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as RunHookReturn;
}

type ItemsHookReturn = ReturnType<typeof useWorkflowRunItems>;
function makeItemsHook(overrides: Partial<ItemsHookReturn> = {}): ItemsHookReturn {
  return {
    items: [],
    meta: null,
    isLoading: false,
    error: null,
    fetchItems: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as ItemsHookReturn;
}

type MutationsHookReturn = ReturnType<typeof useWorkflowMutations>;
function makeMutationsHook(overrides: Partial<MutationsHookReturn> = {}): MutationsHookReturn {
  return {
    createWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
    deleteWorkflow: vi.fn(),
    runWorkflow: vi.fn(),
    approveRun: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'running' }),
    cancelRun: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'cancelled' }),
    duplicateWorkflow: vi.fn(),
    setEnabled: vi.fn(),
    isSaving: false,
    error: null,
    ...overrides,
  } as MutationsHookReturn;
}

describe('WorkflowRunPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCircle.mockReturnValue(makeCircleContext());
    mockUsePermissions.mockReturnValue(makePermissions());
    mockUseWorkflowRunItems.mockReturnValue(makeItemsHook());
    mockUseWorkflowMutations.mockReturnValue(makeMutationsHook());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Approval typed-confirmation gate
  // -------------------------------------------------------------------------
  describe('hard-delete typed confirmation gate', () => {
    it('keeps Approve disabled until the exact "DELETE {matchedCount}" text is typed', async () => {
      const user = userEvent.setup();
      const run = makeRun({
        matchedCount: 5,
        definitionSnapshot: {
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [],
          actions: [{ type: 'hard_delete' }],
        },
      });
      mockUseWorkflowRun.mockReturnValue(makeRunHook({ run }));

      render(<WorkflowRunPage />);

      const approveButton = screen.getByRole('button', { name: /approve & run/i });
      expect(approveButton).toBeDisabled();

      const confirmField = screen.getByPlaceholderText('DELETE 5');
      await user.type(confirmField, 'DELETE 3');
      expect(approveButton).toBeDisabled();
      expect(screen.getByText('Confirmation text does not match.')).toBeInTheDocument();

      await user.clear(confirmField);
      await user.type(confirmField, 'DELETE 5');
      expect(approveButton).toBeEnabled();
    });

    it('submits the exact confirmation string on approve', async () => {
      const user = userEvent.setup();
      const run = makeRun({
        matchedCount: 5,
        definitionSnapshot: {
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [],
          actions: [{ type: 'hard_delete' }],
        },
      });
      const approveRun = vi.fn().mockResolvedValue({ runId: 'run-1', status: 'running' });
      mockUseWorkflowRun.mockReturnValue(makeRunHook({ run }));
      mockUseWorkflowMutations.mockReturnValue(makeMutationsHook({ approveRun }));

      render(<WorkflowRunPage />);

      await user.type(screen.getByPlaceholderText('DELETE 5'), 'DELETE 5');
      await user.click(screen.getByRole('button', { name: /approve & run/i }));

      expect(approveRun).toHaveBeenCalledWith('run-1', {
        excludedItemIds: undefined,
        confirmation: 'DELETE 5',
      });
    });

    it('does not gate the Approve button when the run has no hard_delete action', () => {
      const run = makeRun({ matchedCount: 5 }); // default action: move_to_trash
      mockUseWorkflowRun.mockReturnValue(makeRunHook({ run }));

      render(<WorkflowRunPage />);

      expect(screen.getByRole('button', { name: /approve & run/i })).toBeEnabled();
      expect(screen.queryByText(/permanent deletion/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Exclusion checkboxes
  // -------------------------------------------------------------------------
  describe('exclusion checkboxes', () => {
    it('accumulates excluded item ids and shows the effective-matched count', async () => {
      const user = userEvent.setup();
      const run = makeRun({ matchedCount: 5 });
      const items = [makeItem('a'), makeItem('b'), makeItem('c')];
      mockUseWorkflowRun.mockReturnValue(makeRunHook({ run }));
      mockUseWorkflowRunItems.mockReturnValue(makeItemsHook({ items }));

      render(<WorkflowRunPage />);

      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes).toHaveLength(3);

      await user.click(checkboxes[0]);
      await user.click(checkboxes[1]);

      expect(screen.getByText(/2 excluded/)).toBeInTheDocument();
      expect(screen.getByText(/3 will be affected/)).toBeInTheDocument();

      // Unchecking restores it.
      await user.click(checkboxes[0]);
      expect(screen.getByText(/1 excluded/)).toBeInTheDocument();
      expect(screen.getByText(/4 will be affected/)).toBeInTheDocument();
    });

    it('caps exclusions at 500 and disables further checkboxes once the cap is reached', () => {
      // The item grid is unpaginated/unmemoized in the component, so
      // rendering 500+ real Cards at once and clicking each one is
      // computationally infeasible in jsdom (each click re-renders every
      // sibling). Instead, this drives the SAME mounted page instance
      // through 100 "pages" of 5 freshly-mocked items each — exactly how a
      // real user would reach 500 exclusions by paging through the review
      // grid — so `excluded` genuinely accumulates to 500 real ids via 500
      // real checkbox clicks, without ever rendering more than 5 Cards at
      // a time.
      const PAGE_SIZE = 5;
      const PAGES = 100; // 100 * 5 = exactly 500 distinct excluded ids
      const run = makeRun({ matchedCount: 600 });
      mockUseWorkflowRun.mockReturnValue(makeRunHook({ run }));

      let utils: ReturnType<typeof render> | undefined;
      for (let page = 0; page < PAGES; page++) {
        const items = Array.from({ length: PAGE_SIZE }, (_, i) => makeItem(`p${page}-${i}`));
        mockUseWorkflowRunItems.mockReturnValue(makeItemsHook({ items }));
        if (!utils) {
          utils = render(<WorkflowRunPage />);
        } else {
          utils.rerender(<WorkflowRunPage />);
        }
        for (const cb of screen.getAllByRole('checkbox')) {
          fireEvent.click(cb);
        }
      }

      expect(screen.getByText(/exclusion limit reached \(500\)/i)).toBeInTheDocument();
      expect(screen.getByText(/500 excluded/)).toBeInTheDocument();

      // A brand-new, never-before-seen item on the "next page": its
      // checkbox is disabled on arrival because the cap is already hit, and
      // clicking it has no effect.
      const freshItem = makeItem('fresh-item');
      mockUseWorkflowRunItems.mockReturnValue(makeItemsHook({ items: [freshItem] }));
      utils!.rerender(<WorkflowRunPage />);

      const [freshCheckbox] = screen.getAllByRole('checkbox');
      expect(freshCheckbox).toBeDisabled();
      fireEvent.click(freshCheckbox);
      expect(freshCheckbox).not.toBeChecked();
      expect(screen.getByText(/500 excluded/)).toBeInTheDocument();
    }, 60000);
  });

  // -------------------------------------------------------------------------
  // Progress polling
  // -------------------------------------------------------------------------
  describe('progress polling', () => {
    it('re-fetches the run every 2s while non-terminal, and stops once terminal', () => {
      vi.useFakeTimers();
      const fetchRun = vi.fn().mockResolvedValue(undefined);
      const runningRun = makeRun({ status: 'running', matchedCount: 100, processedCount: 10 });
      mockUseWorkflowRun.mockReturnValue(makeRunHook({ run: runningRun, fetchRun }));

      const { rerender } = render(<WorkflowRunPage />);

      // Initial mount fetch.
      expect(fetchRun).toHaveBeenCalledTimes(1);
      expect(fetchRun).toHaveBeenCalledWith('run-1');

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(fetchRun).toHaveBeenCalledTimes(2);

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(fetchRun).toHaveBeenCalledTimes(3);

      // The run reaches a terminal status — polling must stop.
      const completedRun = makeRun({ status: 'completed', matchedCount: 100, processedCount: 100, succeededCount: 100 });
      mockUseWorkflowRun.mockReturnValue(makeRunHook({ run: completedRun, fetchRun }));
      rerender(<WorkflowRunPage />);

      const callsAtTerminal = fetchRun.mock.calls.length;
      act(() => {
        vi.advanceTimersByTime(10000);
      });
      expect(fetchRun).toHaveBeenCalledTimes(callsAtTerminal);
    });

    it('does not poll at all when the run starts already terminal', () => {
      vi.useFakeTimers();
      const fetchRun = vi.fn().mockResolvedValue(undefined);
      const completedRun = makeRun({ status: 'completed', matchedCount: 10, processedCount: 10, succeededCount: 10 });
      mockUseWorkflowRun.mockReturnValue(makeRunHook({ run: completedRun, fetchRun }));

      render(<WorkflowRunPage />);
      const callsAfterMount = fetchRun.mock.calls.length;

      act(() => {
        vi.advanceTimersByTime(10000);
      });
      expect(fetchRun).toHaveBeenCalledTimes(callsAfterMount);
    });
  });
});
