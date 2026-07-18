/**
 * Unit tests for the workflow builder's draft state + reducer
 * (issue #141 — Workflows Phase 3 web UI).
 *
 * Covers: blank/template/workflow hydration (incl. deep-clone independence),
 * `sanitizeDefinitionForPreview`, and every reducer branch (top-level and
 * group-level condition edits, action list edits, safety options, and the
 * wholesale `replace` used by hydration).
 */

import { describe, it, expect } from 'vitest';
import {
  builderReducer,
  blankState,
  stateFromTemplate,
  stateFromWorkflow,
  cloneDefinition,
  sanitizeDefinitionForPreview,
  type BuilderState,
} from '../../../pages/Workflows/builderState';
import { WORKFLOW_TEMPLATES } from '../../../constants/workflowTemplates';
import type { Workflow, WorkflowDefinition } from '../../../types/workflows';

function baseDefinition(): WorkflowDefinition {
  return {
    version: 1,
    subject: 'media_item',
    match: 'all',
    conditions: [],
    actions: [],
    options: { requirePreview: true },
  };
}

describe('blankState', () => {
  it('produces an empty, manual-trigger draft with requirePreview on', () => {
    const state = blankState();
    expect(state).toEqual({
      name: '',
      description: '',
      enabled: false,
      trigger: 'manual',
      cronExpression: '',
      definition: {
        version: 1,
        subject: 'media_item',
        match: 'all',
        conditions: [],
        actions: [],
        options: { requirePreview: true },
      },
    });
  });

  it('returns a fresh object each call (no shared mutable state)', () => {
    const a = blankState();
    const b = blankState();
    expect(a).not.toBe(b);
    expect(a.definition).not.toBe(b.definition);
  });
});

describe('stateFromTemplate', () => {
  it('hydrates name/description/trigger/cron and deep-clones the definition', () => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.id === 'clean-up-screenshots')!;
    const state = stateFromTemplate(template);

    expect(state.name).toBe(template.name);
    expect(state.description).toBe(template.description);
    expect(state.enabled).toBe(false);
    expect(state.trigger).toBe(template.suggestedTrigger);
    expect(state.cronExpression).toBe('');
    expect(state.definition).toEqual(template.definition);
    expect(state.definition).not.toBe(template.definition);
  });

  it('falls back to an empty cron string when the template has no suggestedCron', () => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.id === 'trip-album')!;
    expect(template.suggestedCron).toBeUndefined();
    const state = stateFromTemplate(template);
    expect(state.cronExpression).toBe('');
  });

  it('carries the suggestedCron through for a scheduled template', () => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.id === 'archive-social-videos')!;
    const state = stateFromTemplate(template);
    expect(state.cronExpression).toBe(template.suggestedCron);
  });

  it('never lets edits to the hydrated draft mutate the shared template constant', () => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.id === 'clean-up-screenshots')!;
    const originalConditionCount = template.definition.conditions.length;

    const state = stateFromTemplate(template);
    state.definition.conditions.push({ field: 'extra', op: 'contains', value: 'x' });
    state.definition.actions.push({ type: 'archive' });

    expect(template.definition.conditions).toHaveLength(originalConditionCount);
    expect(template.definition.actions).toEqual([{ type: 'move_to_trash' }]);
  });
});

describe('stateFromWorkflow', () => {
  function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
    return {
      id: 'wf-1',
      circleId: 'circle-1',
      name: 'My workflow',
      description: null,
      subjectType: 'media_item',
      enabled: true,
      trigger: 'scheduled',
      cronExpression: '0 3 * * *',
      nextRunAt: null,
      definition: baseDefinition(),
      dependencies: [],
      createdById: 'user-1',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('maps a null description to an empty string and a null cron to an empty string', () => {
    const workflow = makeWorkflow({ description: null, trigger: 'manual', cronExpression: null });
    const state = stateFromWorkflow(workflow);
    expect(state.description).toBe('');
    expect(state.cronExpression).toBe('');
  });

  it('preserves a real description/cron and deep-clones the definition', () => {
    const workflow = makeWorkflow({ description: 'Nightly cleanup' });
    const state = stateFromWorkflow(workflow);
    expect(state.description).toBe('Nightly cleanup');
    expect(state.enabled).toBe(true);
    expect(state.trigger).toBe('scheduled');
    expect(state.cronExpression).toBe('0 3 * * *');
    expect(state.definition).toEqual(workflow.definition);
    expect(state.definition).not.toBe(workflow.definition);
  });
});

describe('cloneDefinition', () => {
  it('produces a deep, independent copy', () => {
    const def = baseDefinition();
    def.conditions.push({ field: 'x', op: 'contains', value: 'y' });
    const clone = cloneDefinition(def);
    expect(clone).toEqual(def);
    clone.conditions.push({ field: 'z', op: 'contains', value: 'w' });
    expect(def.conditions).toHaveLength(1);
    expect(clone.conditions).toHaveLength(2);
  });
});

describe('sanitizeDefinitionForPreview', () => {
  it('drops a half-built top-level leaf (no field/op)', () => {
    const def: WorkflowDefinition = {
      ...baseDefinition(),
      conditions: [
        { field: '', op: '' },
        { field: 'country', op: 'equals', value: 'Italy' },
      ],
    };
    const result = sanitizeDefinitionForPreview(def);
    expect(result.conditions).toEqual([{ field: 'country', op: 'equals', value: 'Italy' }]);
  });

  it('drops a group that becomes empty after filtering incomplete leaves', () => {
    const def: WorkflowDefinition = {
      ...baseDefinition(),
      conditions: [
        {
          match: 'all',
          conditions: [{ field: '', op: '' }],
        },
      ],
    };
    const result = sanitizeDefinitionForPreview(def);
    expect(result.conditions).toEqual([]);
  });

  it('keeps a group but drops only its incomplete member leaves', () => {
    const def: WorkflowDefinition = {
      ...baseDefinition(),
      conditions: [
        {
          match: 'all',
          conditions: [
            { field: 'country', op: 'equals', value: 'Italy' },
            { field: '', op: '' },
          ],
        },
      ],
    };
    const result = sanitizeDefinitionForPreview(def);
    expect(result.conditions).toEqual([
      { match: 'all', conditions: [{ field: 'country', op: 'equals', value: 'Italy' }] },
    ]);
  });

  it('does not mutate the input definition', () => {
    const def: WorkflowDefinition = {
      ...baseDefinition(),
      conditions: [{ field: '', op: '' }],
    };
    const before = JSON.stringify(def);
    sanitizeDefinitionForPreview(def);
    expect(JSON.stringify(def)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

describe('builderReducer', () => {
  it('handles setName/setDescription/setEnabled/setTrigger/setCron', () => {
    let state = blankState();
    state = builderReducer(state, { kind: 'setName', value: 'My workflow' });
    expect(state.name).toBe('My workflow');
    state = builderReducer(state, { kind: 'setDescription', value: 'desc' });
    expect(state.description).toBe('desc');
    state = builderReducer(state, { kind: 'setEnabled', value: true });
    expect(state.enabled).toBe(true);
    state = builderReducer(state, { kind: 'setTrigger', value: 'scheduled' });
    expect(state.trigger).toBe('scheduled');
    state = builderReducer(state, { kind: 'setCron', value: '0 3 * * *' });
    expect(state.cronExpression).toBe('0 3 * * *');
  });

  it('handles setMatch at the top level', () => {
    let state = blankState();
    state = builderReducer(state, { kind: 'setMatch', value: 'any' });
    expect(state.definition.match).toBe('any');
  });

  describe('top-level conditions', () => {
    it('addLeaf appends an empty leaf', () => {
      let state = blankState();
      state = builderReducer(state, { kind: 'addLeaf' });
      expect(state.definition.conditions).toEqual([{ field: '', op: '' }]);
    });

    it('addGroup appends a group with one empty leaf and match "all"', () => {
      let state = blankState();
      state = builderReducer(state, { kind: 'addGroup' });
      expect(state.definition.conditions).toEqual([
        { match: 'all', conditions: [{ field: '', op: '' }] },
      ]);
    });

    it('updateLeaf patches only the targeted top-level leaf', () => {
      let state = blankState();
      state = builderReducer(state, { kind: 'addLeaf' });
      state = builderReducer(state, { kind: 'addLeaf' });
      state = builderReducer(state, {
        kind: 'updateLeaf',
        index: 1,
        patch: { field: 'country', op: 'equals', value: 'Italy' },
      });
      expect(state.definition.conditions).toEqual([
        { field: '', op: '' },
        { field: 'country', op: 'equals', value: 'Italy' },
      ]);
    });

    it('updateLeaf is a no-op when the target index is a group', () => {
      let state = blankState();
      state = builderReducer(state, { kind: 'addGroup' });
      const before = state.definition.conditions[0];
      state = builderReducer(state, {
        kind: 'updateLeaf',
        index: 0,
        patch: { field: 'country' },
      });
      expect(state.definition.conditions[0]).toEqual(before);
    });

    it('removeTop removes the condition at the given index', () => {
      let state = blankState();
      state = builderReducer(state, { kind: 'addLeaf' });
      state = builderReducer(state, { kind: 'addGroup' });
      state = builderReducer(state, { kind: 'removeTop', index: 0 });
      expect(state.definition.conditions).toHaveLength(1);
      expect(state.definition.conditions[0]).toEqual({ match: 'all', conditions: [{ field: '', op: '' }] });
    });
  });

  describe('group-level conditions', () => {
    function withOneGroup(): BuilderState {
      return builderReducer(blankState(), { kind: 'addGroup' });
    }

    it('setGroupMatch updates only the targeted group', () => {
      let state = withOneGroup();
      state = builderReducer(state, { kind: 'setGroupMatch', groupIndex: 0, value: 'any' });
      expect(state.definition.conditions).toEqual([
        { match: 'any', conditions: [{ field: '', op: '' }] },
      ]);
    });

    it('addGroupLeaf appends an empty leaf inside the group', () => {
      let state = withOneGroup();
      state = builderReducer(state, { kind: 'addGroupLeaf', groupIndex: 0 });
      const group = state.definition.conditions[0] as { conditions: unknown[] };
      expect(group.conditions).toHaveLength(2);
    });

    it('updateGroupLeaf patches only the targeted child leaf', () => {
      let state = withOneGroup();
      state = builderReducer(state, { kind: 'addGroupLeaf', groupIndex: 0 });
      state = builderReducer(state, {
        kind: 'updateGroupLeaf',
        groupIndex: 0,
        childIndex: 1,
        patch: { field: 'country', op: 'equals', value: 'Italy' },
      });
      expect(state.definition.conditions).toEqual([
        {
          match: 'all',
          conditions: [
            { field: '', op: '' },
            { field: 'country', op: 'equals', value: 'Italy' },
          ],
        },
      ]);
    });

    it('removeGroupLeaf removes only the targeted child leaf', () => {
      let state = withOneGroup();
      state = builderReducer(state, { kind: 'addGroupLeaf', groupIndex: 0 });
      state = builderReducer(state, { kind: 'removeGroupLeaf', groupIndex: 0, childIndex: 0 });
      const group = state.definition.conditions[0] as { conditions: unknown[] };
      expect(group.conditions).toHaveLength(1);
    });

    it('group-scoped actions never touch a top-level leaf at the same index', () => {
      let state = blankState();
      state = builderReducer(state, { kind: 'addLeaf' }); // index 0: a plain leaf, not a group
      state = builderReducer(state, {
        kind: 'setGroupMatch',
        groupIndex: 0,
        value: 'any',
      });
      // No group exists at index 0, so the leaf is untouched.
      expect(state.definition.conditions).toEqual([{ field: '', op: '' }]);
    });
  });

  describe('actions', () => {
    it('addAction appends to the end', () => {
      let state = blankState();
      state = builderReducer(state, { kind: 'addAction', action: { type: 'move_to_trash' } });
      state = builderReducer(state, { kind: 'addAction', action: { type: 'archive' } });
      expect(state.definition.actions).toEqual([{ type: 'move_to_trash' }, { type: 'archive' }]);
    });

    it('setAction replaces the action at the given index', () => {
      let state = blankState();
      state = builderReducer(state, { kind: 'addAction', action: { type: 'move_to_trash' } });
      state = builderReducer(state, {
        kind: 'setAction',
        index: 0,
        action: { type: 'add_tags', names: ['x'] },
      });
      expect(state.definition.actions).toEqual([{ type: 'add_tags', names: ['x'] }]);
    });

    it('removeAction removes the action at the given index', () => {
      let state = blankState();
      state = builderReducer(state, { kind: 'addAction', action: { type: 'move_to_trash' } });
      state = builderReducer(state, { kind: 'addAction', action: { type: 'archive' } });
      state = builderReducer(state, { kind: 'removeAction', index: 0 });
      expect(state.definition.actions).toEqual([{ type: 'archive' }]);
    });

    it('moveAction swaps adjacent actions', () => {
      let state = blankState();
      state = builderReducer(state, { kind: 'addAction', action: { type: 'a' } });
      state = builderReducer(state, { kind: 'addAction', action: { type: 'b' } });
      state = builderReducer(state, { kind: 'addAction', action: { type: 'c' } });
      state = builderReducer(state, { kind: 'moveAction', index: 0, direction: 1 });
      expect(state.definition.actions.map((a) => a.type)).toEqual(['b', 'a', 'c']);
    });

    it('moveAction is a no-op moving the first action up', () => {
      let state = blankState();
      state = builderReducer(state, { kind: 'addAction', action: { type: 'a' } });
      state = builderReducer(state, { kind: 'addAction', action: { type: 'b' } });
      const before = state;
      const after = builderReducer(state, { kind: 'moveAction', index: 0, direction: -1 });
      expect(after).toBe(before);
    });

    it('moveAction is a no-op moving the last action down', () => {
      let state = blankState();
      state = builderReducer(state, { kind: 'addAction', action: { type: 'a' } });
      state = builderReducer(state, { kind: 'addAction', action: { type: 'b' } });
      const before = state;
      const after = builderReducer(state, { kind: 'moveAction', index: 1, direction: 1 });
      expect(after).toBe(before);
    });
  });

  describe('safety options', () => {
    it('setMaxItems sets a value', () => {
      let state = blankState();
      state = builderReducer(state, { kind: 'setMaxItems', value: 500 });
      expect(state.definition.options?.maxItems).toBe(500);
    });

    it('setMaxItems with undefined clears a previously-set value', () => {
      let state = blankState();
      state = builderReducer(state, { kind: 'setMaxItems', value: 500 });
      state = builderReducer(state, { kind: 'setMaxItems', value: undefined });
      expect(state.definition.options?.maxItems).toBeUndefined();
      expect('maxItems' in (state.definition.options ?? {})).toBe(false);
    });

    it('setRequirePreview sets the flag without disturbing maxItems', () => {
      let state = blankState();
      state = builderReducer(state, { kind: 'setMaxItems', value: 100 });
      state = builderReducer(state, { kind: 'setRequirePreview', value: false });
      expect(state.definition.options).toEqual({ requirePreview: false, maxItems: 100 });
    });
  });

  it('replace swaps in a wholesale new state (template/workflow hydration)', () => {
    const state = blankState();
    const template = WORKFLOW_TEMPLATES.find((t) => t.id === 'clean-up-screenshots')!;
    const hydrated = stateFromTemplate(template);
    const result = builderReducer(state, { kind: 'replace', state: hydrated });
    expect(result).toBe(hydrated);
  });

  it('returns the same state reference for an unknown action kind (defensive default)', () => {
    const state = blankState();
    // @ts-expect-error — deliberately exercising the reducer's default branch.
    const result = builderReducer(state, { kind: 'not_a_real_action' });
    expect(result).toBe(state);
  });
});
