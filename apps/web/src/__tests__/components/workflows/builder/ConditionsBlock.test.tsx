/**
 * RTL tests for ConditionsBlock (issue #141 — Workflows Phase 3 web UI).
 *
 * Covers the issue's "Builder condition rows" and "Subject-driven form
 * population" bullets: the field picker reflects exactly the Subject
 * registry's fields (grouped), and add/remove of a top-level condition row,
 * adding a nested condition group (one level), and toggling ALL/ANY all work
 * through the real `builderReducer` (via a small harness component — no
 * network, no router needed for this block in isolation).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useReducer } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../utils/test-utils';
import { ConditionsBlock } from '../../../../components/workflows/builder/ConditionsBlock';
import {
  builderReducer,
  blankState,
} from '../../../../pages/Workflows/builderState';
import type { WorkflowFieldDescriptor } from '../../../../types/workflows';

// ---------------------------------------------------------------------------
// The value editor (via ConditionRow) fetches the circle's tag vocabulary and
// albums once per block mount. Mock the network-backed service so the block
// never hits real fetch — deterministic, empty lists are enough since none of
// these tests select a tag-set/album field.
// ---------------------------------------------------------------------------
vi.mock('../../../../services/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../services/media')>();
  return {
    ...actual,
    getExploreTags: vi.fn().mockResolvedValue([]),
    listAlbums: vi.fn().mockResolvedValue({ items: [], meta: { page: 1, pageSize: 200, totalItems: 0, totalPages: 0 } }),
  };
});

// A field registry spanning every WorkflowFieldGroup, mirroring the shape
// `GET /api/workflows/subjects` would return for the media_item subject.
const FIELDS: WorkflowFieldDescriptor[] = [
  { key: 'filename', label: 'Filename', group: 'File', type: 'string', operators: ['contains', 'starts_with', 'equals'], valueType: 'string', dependency: 'metadata' },
  { key: 'capturedAt', label: 'Capture date', group: 'Dates', type: 'date', operators: ['before', 'after'], valueType: 'iso-date', dependency: 'metadata' },
  { key: 'country', label: 'Country', group: 'Location', type: 'string', operators: ['equals'], valueType: 'string', dependency: 'metadata' },
  { key: 'hasTag', label: 'Has tag', group: 'Tags', type: 'string', operators: ['contains'], valueType: 'string', dependency: 'tags' },
  { key: 'personName', label: 'Person name', group: 'People', type: 'string', operators: ['contains'], valueType: 'string', dependency: 'faces' },
  { key: 'mimeType', label: 'File type', group: 'Media', type: 'string', operators: ['equals'], valueType: 'string', dependency: 'metadata' },
  { key: 'albumName', label: 'Album name', group: 'Organization', type: 'string', operators: ['equals'], valueType: 'string', dependency: 'metadata' },
  { key: 'inPendingDuplicateGroup', label: 'In pending duplicate group', group: 'Review', type: 'boolean', operators: ['is'], valueType: 'boolean', dependency: 'duplicates' },
];

// Harness — a real reducer + dispatch, so every interaction exercises the
// production `builderReducer`, not a mock.
function ConditionsHarness({ fields = FIELDS }: { fields?: WorkflowFieldDescriptor[] }) {
  const [state, dispatch] = useReducer(builderReducer, undefined, blankState);
  return (
    <ConditionsBlock
      circleId="circle-1"
      fields={fields}
      match={state.definition.match}
      conditions={state.definition.conditions}
      dispatch={dispatch}
    />
  );
}

describe('ConditionsBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('subject-driven field population', () => {
    it('offers exactly the registry fields, grouped, in the field picker', async () => {
      const user = userEvent.setup();
      render(<ConditionsHarness />);

      await user.click(screen.getByRole('button', { name: 'Add condition' }));

      const fieldInput = screen.getByRole('combobox', { name: /field/i });
      await user.click(fieldInput);

      const listbox = await screen.findByRole('listbox');
      const optionLabels = within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent);

      expect(optionLabels).toEqual([
        'Filename',
        'Capture date',
        'Country',
        'Has tag',
        'Person name',
        'File type',
        'Album name',
        'In pending duplicate group',
      ]);
    });

    it('filters the operator choices to the selected field\'s registry operators', async () => {
      const user = userEvent.setup();
      render(<ConditionsHarness />);

      await user.click(screen.getByRole('button', { name: 'Add condition' }));
      await user.click(screen.getByRole('combobox', { name: /field/i }));
      await user.click(await screen.findByRole('option', { name: 'Filename' }));

      // MUI's Select trigger doesn't compute an accessible name reliably in
      // jsdom even though it is visually labeled "Condition" — select it
      // positionally: the Field Autocomplete is combobox[0], the operator
      // Select is combobox[1] once a field has been chosen.
      await user.click(screen.getAllByRole('combobox')[1]);
      const opListbox = await screen.findByRole('listbox');
      const opLabels = within(opListbox)
        .getAllByRole('option')
        .map((o) => o.textContent);
      // Filename's registry operators are contains / starts_with / equals.
      expect(opLabels).toEqual(['contains', 'starts with', 'is']);
    });
  });

  describe('condition rows', () => {
    it('adds a top-level condition row on "Add condition"', async () => {
      const user = userEvent.setup();
      render(<ConditionsHarness />);

      expect(screen.queryByRole('combobox', { name: /field/i })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Add condition' }));
      expect(screen.getAllByRole('combobox', { name: /field/i })).toHaveLength(1);
    });

    it('removes a top-level condition row on the row\'s remove button', async () => {
      const user = userEvent.setup();
      render(<ConditionsHarness />);

      await user.click(screen.getByRole('button', { name: 'Add condition' }));
      expect(screen.getAllByRole('combobox', { name: /field/i })).toHaveLength(1);

      await user.click(screen.getByRole('button', { name: /remove condition/i }));
      expect(screen.queryByRole('combobox', { name: /field/i })).not.toBeInTheDocument();
      expect(
        screen.getByText(/this workflow will match every item/i),
      ).toBeInTheDocument();
    });

    it('adds a nested condition group (one level) with its own match toggle and an inner leaf', async () => {
      const user = userEvent.setup();
      render(<ConditionsHarness />);

      await user.click(screen.getByRole('button', { name: 'Add condition group' }));

      expect(screen.getByText('Condition group')).toBeInTheDocument();
      // The group starts with exactly one empty leaf row.
      expect(screen.getAllByRole('combobox', { name: /field/i })).toHaveLength(1);
      // Add a second leaf inside the group.
      await user.click(screen.getByRole('button', { name: 'Add condition to group' }));
      expect(screen.getAllByRole('combobox', { name: /field/i })).toHaveLength(2);
    });

    it('removing the group removes all of its nested leaves at once', async () => {
      const user = userEvent.setup();
      render(<ConditionsHarness />);

      await user.click(screen.getByRole('button', { name: 'Add condition group' }));
      await user.click(screen.getByRole('button', { name: 'Add condition to group' }));
      expect(screen.getAllByRole('combobox', { name: /field/i })).toHaveLength(2);

      await user.click(screen.getByRole('button', { name: /remove group/i }));
      expect(screen.queryByRole('combobox', { name: /field/i })).not.toBeInTheDocument();
      expect(screen.queryByText('Condition group')).not.toBeInTheDocument();
    });
  });

  describe('ALL / ANY toggle', () => {
    it('toggles the top-level match mode between ALL and ANY', async () => {
      const user = userEvent.setup();
      render(<ConditionsHarness />);

      const allButtons = screen.getAllByRole('button', { name: 'Match ALL' });
      const anyButtons = screen.getAllByRole('button', { name: 'Match ANY' });
      // Only the top-level toggle exists before any group is added.
      expect(allButtons).toHaveLength(1);
      expect(anyButtons).toHaveLength(1);

      expect(allButtons[0]).toHaveAttribute('aria-pressed', 'true');
      expect(anyButtons[0]).toHaveAttribute('aria-pressed', 'false');

      await user.click(anyButtons[0]);

      expect(screen.getAllByRole('button', { name: 'Match ANY' })[0]).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getAllByRole('button', { name: 'Match ALL' })[0]).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    it('toggles a group\'s own match mode independently of the top-level toggle', async () => {
      const user = userEvent.setup();
      render(<ConditionsHarness />);

      await user.click(screen.getByRole('button', { name: 'Add condition group' }));

      // Now two ALL/ANY toggles exist: top-level and the group's own.
      const anyButtons = screen.getAllByRole('button', { name: 'Match ANY' });
      expect(anyButtons).toHaveLength(2);
      const groupAnyButton = anyButtons[1];

      await user.click(groupAnyButton);

      // The top-level toggle is unaffected; only the group's toggle flips.
      expect(screen.getAllByRole('button', { name: 'Match ALL' })[0]).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getAllByRole('button', { name: 'Match ANY' })[1]).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });
});
