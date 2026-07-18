/**
 * RTL tests for ActionsBlock (issue #141 — Workflows Phase 3 web UI).
 *
 * Covers the "action options reflect the registry" half of the "Subject-
 * driven form population" bullet, plus add/remove of an action row through
 * the real `builderReducer`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useReducer } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../utils/test-utils';
import { ActionsBlock } from '../../../../components/workflows/builder/ActionsBlock';
import {
  builderReducer,
  blankState,
} from '../../../../pages/Workflows/builderState';
import type { WorkflowActionDescriptor } from '../../../../types/workflows';

// ActionParamEditor's 'tags' kind reads the circle's tag vocabulary.
vi.mock('../../../../services/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../services/media')>();
  return {
    ...actual,
    getExploreTags: vi.fn().mockResolvedValue([]),
    listAlbums: vi.fn().mockResolvedValue({ items: [], meta: { page: 1, pageSize: 200, totalItems: 0, totalPages: 0 } }),
  };
});

// Every type here maps to ActionParamKind 'none' or 'tags' (ACTION_PARAM_KIND
// in workflowActionMeta.ts), so no person-picker / circle-picker network
// calls are triggered.
const ACTIONS: WorkflowActionDescriptor[] = [
  { type: 'move_to_trash', label: 'Move to Trash' },
  { type: 'archive', label: 'Archive' },
  { type: 'unarchive', label: 'Unarchive' },
  { type: 'add_tags', label: 'Add tags' },
  { type: 'hard_delete', label: 'Permanently delete', destructive: true },
];

function ActionsHarness({ actionCatalog = ACTIONS }: { actionCatalog?: WorkflowActionDescriptor[] }) {
  const [state, dispatch] = useReducer(builderReducer, undefined, blankState);
  return (
    <ActionsBlock
      circleId="circle-1"
      actionCatalog={actionCatalog}
      actions={state.definition.actions}
      dispatch={dispatch}
      hardDeleteAllowed={null}
    />
  );
}

describe('ActionsBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('subject-driven action population', () => {
    it('defaults a newly-added action to the first non-destructive registry action', async () => {
      const user = userEvent.setup();
      render(<ActionsHarness />);

      await user.click(screen.getByRole('button', { name: 'Add action' }));

      // The Action Select's current value is the first non-destructive type
      // (move_to_trash comes before the destructive hard_delete entry).
      expect(screen.getByText('Move to Trash')).toBeInTheDocument();
    });

    it('offers exactly the registry actions, in order, in the Action picker', async () => {
      const user = userEvent.setup();
      render(<ActionsHarness />);

      await user.click(screen.getByRole('button', { name: 'Add action' }));
      await user.click(screen.getAllByRole('combobox')[0]);

      const listbox = await screen.findByRole('listbox');
      const optionLabels = within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent);

      expect(optionLabels).toEqual([
        'Move to Trash',
        'Archive',
        'Unarchive',
        'Add tags',
        'Permanently delete',
      ]);
    });
  });

  describe('action rows', () => {
    it('shows an empty-state hint and no rows before any action is added', async () => {
      render(<ActionsHarness />);
      // `findBy` flushes the block's tag/album fetch effect inside act(),
      // avoiding a spurious "not wrapped in act" warning from that unrelated
      // in-flight promise resolving after this test's synchronous assertions.
      expect(
        await screen.findByText(/add at least one action for this workflow to do anything/i),
      ).toBeInTheDocument();
      expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    });

    it('adds an action row on "Add action"', async () => {
      const user = userEvent.setup();
      render(<ActionsHarness />);

      await user.click(screen.getByRole('button', { name: 'Add action' }));
      expect(screen.getAllByRole('combobox')).toHaveLength(1);
      expect(
        screen.queryByText(/add at least one action for this workflow/i),
      ).not.toBeInTheDocument();
    });

    it('adds a second action row appended after the first', async () => {
      const user = userEvent.setup();
      render(<ActionsHarness />);

      await user.click(screen.getByRole('button', { name: 'Add action' }));
      await user.click(screen.getByRole('button', { name: 'Add action' }));
      expect(screen.getAllByRole('combobox')).toHaveLength(2);
    });

    it('removes an action row on its remove button', async () => {
      const user = userEvent.setup();
      render(<ActionsHarness />);

      await user.click(screen.getByRole('button', { name: 'Add action' }));
      expect(screen.getAllByRole('combobox')).toHaveLength(1);

      await user.click(screen.getByRole('button', { name: 'Remove action' }));
      expect(screen.queryAllByRole('combobox')).toHaveLength(0);
      expect(
        screen.getByText(/add at least one action for this workflow to do anything/i),
      ).toBeInTheDocument();
    });

    it('shows the manual-trigger-only warning for hard_delete but not for a normal action', async () => {
      const user = userEvent.setup();
      render(<ActionsHarness />);

      await user.click(screen.getByRole('button', { name: 'Add action' }));
      expect(screen.queryByText(/permanent delete — use with care/i)).not.toBeInTheDocument();

      await user.click(screen.getAllByRole('combobox')[0]);
      await user.click(await screen.findByRole('option', { name: 'Permanently delete' }));

      expect(screen.getByText(/permanent delete — use with care/i)).toBeInTheDocument();
      expect(screen.getByText(/manual trigger only/i)).toBeInTheDocument();
    });
  });
});
