/**
 * Unit tests for workflowFormat.ts (issue #141 — Workflows Phase 3 web UI).
 *
 * Covers the pure formatting helpers used by the run review/progress page and
 * the builder: cronToText, runStatusColor/Label, deriveActionImpacts,
 * hardDeleteConfirmationText, definitionHasHardDelete, describeWorkflowAction,
 * and isTerminalRunStatus.
 */

import { describe, it, expect } from 'vitest';
import {
  cronToText,
  runStatusColor,
  runStatusLabel,
  isTerminalRunStatus,
  formatCount,
  hardDeleteConfirmationText,
  definitionHasHardDelete,
  describeWorkflowAction,
  deriveActionImpacts,
} from '../../utils/workflowFormat';
import type {
  WorkflowRunStatus,
  WorkflowDefinition,
  WorkflowActionInstance,
} from '../../types/workflows';

// ---------------------------------------------------------------------------
// cronToText
// ---------------------------------------------------------------------------

describe('cronToText', () => {
  it('returns empty string for null', () => {
    expect(cronToText(null)).toBe('');
  });

  it('renders a daily schedule', () => {
    expect(cronToText('0 3 * * *')).toBe('Daily at 3:00 AM');
  });

  it('renders midnight and noon correctly (12-hour boundary)', () => {
    expect(cronToText('0 0 * * *')).toBe('Daily at 12:00 AM');
    expect(cronToText('0 12 * * *')).toBe('Daily at 12:00 PM');
  });

  it('renders a weekly schedule with the correct weekday name', () => {
    expect(cronToText('0 4 * * 0')).toBe('Weekly on Sunday at 4:00 AM');
    expect(cronToText('30 9 * * 3')).toBe('Weekly on Wednesday at 9:30 AM');
  });

  it('treats day-of-week 7 as Sunday', () => {
    expect(cronToText('0 4 * * 7')).toBe('Weekly on Sunday at 4:00 AM');
  });

  it('renders a monthly schedule', () => {
    expect(cronToText('0 5 1 * *')).toBe('Monthly on day 1 at 5:00 AM');
    expect(cronToText('15 22 28 * *')).toBe('Monthly on day 28 at 10:15 PM');
  });

  it('falls back to the raw cron string for an unrecognized shape', () => {
    // Both day-of-month and month set — not one of the three known shapes.
    expect(cronToText('0 3 1 6 *')).toBe('Cron: 0 3 1 6 *');
  });

  it('falls back for the wrong field count', () => {
    expect(cronToText('0 3 * *')).toBe('Cron: 0 3 * *');
  });

  it('falls back for a non-numeric minute/hour', () => {
    expect(cronToText('a b * * *')).toBe('Cron: a b * * *');
  });

  it('falls back for an out-of-range hour', () => {
    expect(cronToText('0 99 * * *')).toBe('Cron: 0 99 * * *');
  });

  it('never throws on garbage input', () => {
    expect(() => cronToText('not a cron expression at all')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runStatusColor / runStatusLabel
// ---------------------------------------------------------------------------

describe('runStatusColor', () => {
  it.each<[WorkflowRunStatus, string]>([
    ['evaluating', 'info'],
    ['running', 'info'],
    ['awaiting_approval', 'warning'],
    ['completed', 'success'],
    ['completed_with_errors', 'warning'],
    ['failed', 'error'],
    ['cancelled', 'default'],
    ['expired', 'default'],
  ])('maps %s to %s', (status, color) => {
    expect(runStatusColor(status)).toBe(color);
  });
});

describe('runStatusLabel', () => {
  it('title-cases only the first word and keeps underscores as spaces', () => {
    expect(runStatusLabel('awaiting_approval')).toBe('Awaiting approval');
    expect(runStatusLabel('completed_with_errors')).toBe('Completed with errors');
    expect(runStatusLabel('completed')).toBe('Completed');
    expect(runStatusLabel('failed')).toBe('Failed');
  });
});

// ---------------------------------------------------------------------------
// isTerminalRunStatus
// ---------------------------------------------------------------------------

describe('isTerminalRunStatus', () => {
  it.each<WorkflowRunStatus>(['completed', 'completed_with_errors', 'failed', 'cancelled', 'expired'])(
    'treats %s as terminal',
    (status) => {
      expect(isTerminalRunStatus(status)).toBe(true);
    },
  );

  it.each<WorkflowRunStatus>(['evaluating', 'awaiting_approval', 'running'])(
    'treats %s as non-terminal',
    (status) => {
      expect(isTerminalRunStatus(status)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// formatCount
// ---------------------------------------------------------------------------

describe('formatCount', () => {
  it('adds thousands separators', () => {
    expect(formatCount(2481)).toBe('2,481');
    expect(formatCount(10000)).toBe('10,000');
  });

  it('rounds fractional input', () => {
    expect(formatCount(3.7)).toBe('4');
  });

  it('falls back to 0 for non-finite input', () => {
    expect(formatCount(NaN)).toBe('0');
    expect(formatCount(Infinity)).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// hardDeleteConfirmationText
// ---------------------------------------------------------------------------

describe('hardDeleteConfirmationText', () => {
  it('formats the exact backend-required confirmation string', () => {
    expect(hardDeleteConfirmationText(2481)).toBe('DELETE 2481');
  });

  it('does not use thousands separators (raw integer only)', () => {
    expect(hardDeleteConfirmationText(10000)).toBe('DELETE 10000');
  });

  it('handles zero matches', () => {
    expect(hardDeleteConfirmationText(0)).toBe('DELETE 0');
  });
});

// ---------------------------------------------------------------------------
// definitionHasHardDelete
// ---------------------------------------------------------------------------

describe('definitionHasHardDelete', () => {
  const baseDef: WorkflowDefinition = {
    version: 1,
    subject: 'media_item',
    match: 'all',
    conditions: [],
    actions: [],
  };

  it('returns true when a hard_delete action is present', () => {
    const def: WorkflowDefinition = { ...baseDef, actions: [{ type: 'hard_delete' }] };
    expect(definitionHasHardDelete(def)).toBe(true);
  });

  it('returns false when no hard_delete action is present', () => {
    const def: WorkflowDefinition = { ...baseDef, actions: [{ type: 'move_to_trash' }] };
    expect(definitionHasHardDelete(def)).toBe(false);
  });

  it('returns false for null/undefined definitions (defensive)', () => {
    expect(definitionHasHardDelete(null)).toBe(false);
    expect(definitionHasHardDelete(undefined)).toBe(false);
  });

  it('returns false when actions is not an array (defensive)', () => {
    const malformed = { ...baseDef, actions: undefined } as unknown as WorkflowDefinition;
    expect(definitionHasHardDelete(malformed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// describeWorkflowAction
// ---------------------------------------------------------------------------

describe('describeWorkflowAction', () => {
  it('describes simple no-param actions', () => {
    expect(describeWorkflowAction({ type: 'move_to_trash' })).toBe('Move to Trash');
    expect(describeWorkflowAction({ type: 'archive' })).toBe('Archive');
    expect(describeWorkflowAction({ type: 'unarchive' })).toBe('Unarchive');
    expect(describeWorkflowAction({ type: 'hard_delete' })).toBe('Permanently delete');
  });

  it('describes set_favorite based on the boolean value', () => {
    expect(describeWorkflowAction({ type: 'set_favorite', favorite: true })).toBe('Mark favorite');
    expect(describeWorkflowAction({ type: 'set_favorite', favorite: false })).toBe('Unmark favorite');
  });

  it('describes move_to_circle with the target name when present', () => {
    expect(
      describeWorkflowAction({ type: 'move_to_circle', targetCircleName: 'Family' }),
    ).toBe("Move to circle 'Family'");
    expect(describeWorkflowAction({ type: 'move_to_circle' })).toBe('Move to circle');
  });

  it('describes add_to_album, preferring createAlbumNamed over albumName/albumId', () => {
    expect(
      describeWorkflowAction({ type: 'add_to_album', createAlbumNamed: 'Italy 2025' }),
    ).toBe("Add to album 'Italy 2025'");
    expect(
      describeWorkflowAction({ type: 'add_to_album', albumName: 'Existing Album' }),
    ).toBe("Add to album 'Existing Album'");
    expect(describeWorkflowAction({ type: 'add_to_album' })).toBe('Add to album');
  });

  it('describes add_tags/remove_tags with a comma-joined tag list (reads the real `names` param)', () => {
    // `add_tags`/`remove_tags` (plural) with a `names` array is the actual
    // shape used everywhere else (templates, ActionsBlock, the backend
    // registry) — see ACTION_PARAM_KIND in workflowActionMeta.ts.
    expect(describeWorkflowAction({ type: 'add_tags', names: ['screenshot'] })).toBe(
      "Add tag 'screenshot'",
    );
    expect(
      describeWorkflowAction({ type: 'add_tags', names: ['a', 'b'] }),
    ).toBe("Add tag 'a', 'b'");
    expect(describeWorkflowAction({ type: 'remove_tags', names: ['old'] })).toBe(
      "Remove tag 'old'",
    );
    expect(describeWorkflowAction({ type: 'add_tags' })).toBe('Add tag');
  });

  it('describes resolve_duplicate_group / resolve_burst_group by action outcome', () => {
    expect(
      describeWorkflowAction({ type: 'resolve_duplicate_group', action: 'trash' }),
    ).toBe('Resolve duplicate groups: keep best, trash the rest');
    expect(
      describeWorkflowAction({ type: 'resolve_duplicate_group', action: 'archive' }),
    ).toBe('Resolve duplicate groups: keep best, archive the rest');
    expect(
      describeWorkflowAction({ type: 'resolve_burst_group', action: 'archive' }),
    ).toBe('Resolve burst groups: keep best, archive the rest');
  });

  it('describes add_person with the person name when present', () => {
    expect(describeWorkflowAction({ type: 'add_person', personName: 'Alice' })).toBe(
      "Tag person 'Alice'",
    );
    expect(describeWorkflowAction({ type: 'add_person' })).toBe('Tag person');
  });

  it('falls back to a prettified type for unknown action types', () => {
    expect(describeWorkflowAction({ type: 'some_future_action' })).toBe('Some Future Action');
  });
});

// ---------------------------------------------------------------------------
// deriveActionImpacts
// ---------------------------------------------------------------------------

describe('deriveActionImpacts', () => {
  it('returns an empty array for non-array input (defensive)', () => {
    expect(deriveActionImpacts(null, 10)).toEqual([]);
    expect(deriveActionImpacts(undefined, 10)).toEqual([]);
  });

  it('uses the effective (matched-minus-excluded) count when no byActionType is given', () => {
    const actions: WorkflowActionInstance[] = [{ type: 'move_to_trash' }];
    const impacts = deriveActionImpacts(actions, 2481);
    expect(impacts).toEqual([{ key: 'move_to_trash-0', label: 'Move to Trash', count: 2481 }]);
  });

  it('clamps a negative effective count to zero', () => {
    const impacts = deriveActionImpacts([{ type: 'archive' }], -5);
    expect(impacts[0].count).toBe(0);
  });

  it('prefers the applied count from byActionType once the run has begun applying', () => {
    const actions: WorkflowActionInstance[] = [
      { type: 'move_to_trash' },
      { type: 'add_tags', names: ['screenshot'] },
    ];
    const impacts = deriveActionImpacts(actions, 2481, {
      move_to_trash: { applied: 34, failed: 1, skipped: 0 },
    });
    expect(impacts[0]).toEqual({ key: 'move_to_trash-0', label: 'Move to Trash', count: 34 });
    // No byActionType entry for add_tags yet — falls back to the effective count.
    expect(impacts[1]).toEqual({
      key: 'add_tags-1',
      label: "Add tag 'screenshot'",
      count: 2481,
    });
  });

  it('produces a stable key per action ordinal even for duplicate types', () => {
    const impacts = deriveActionImpacts(
      [{ type: 'archive' }, { type: 'archive' }],
      5,
    );
    expect(impacts.map((i) => i.key)).toEqual(['archive-0', 'archive-1']);
  });
});
