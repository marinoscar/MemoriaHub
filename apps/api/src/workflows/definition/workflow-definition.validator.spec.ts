/**
 * Unit tests for WorkflowDefinitionValidator (issue #139).
 *
 * Pure — no NestJS module or DB dependency (constructed directly). Layers
 * registry-aware validation on top of the structural Zod schema.
 */
import { BadRequestException } from '@nestjs/common';
import { WorkflowDefinitionValidator } from './workflow-definition.validator';
import { registeredActions } from '../registry/subject-registry';

describe('WorkflowDefinitionValidator', () => {
  let validator: WorkflowDefinitionValidator;

  beforeEach(() => {
    validator = new WorkflowDefinitionValidator();
  });

  // ---------------------------------------------------------------------------
  // The documented screenshot-cleanup example (epic #138 / issue #139)
  // ---------------------------------------------------------------------------

  it('accepts a valid screenshot-cleanup definition', () => {
    const definition = {
      version: 1,
      subject: 'media_item',
      match: 'any',
      conditions: [
        { field: 'filename', op: 'contains', value: 'screenshot' },
        {
          match: 'all',
          conditions: [
            { field: 'mimeType', op: 'equals', value: 'image/png' },
            { field: 'missingCamera', op: 'is', value: true },
            { field: 'missingCapturedAt', op: 'is', value: true },
          ],
        },
      ],
      actions: [{ type: 'move_to_trash' }],
      options: { maxItems: 5000, requirePreview: true },
    };

    const result = validator.validate(definition);
    expect(result.subject).toBe('media_item');
    expect(result.match).toBe('any');
    expect(result.conditions).toHaveLength(2);
    expect(result.actions).toEqual([{ type: 'move_to_trash' }]);
  });

  it('accepts a definition with empty conditions (matches every item in the circle)', () => {
    const definition = {
      version: 1,
      subject: 'media_item',
      match: 'all',
      conditions: [],
      actions: [],
    };
    const result = validator.validate(definition);
    expect(result.conditions).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // version / subject requirements
  // ---------------------------------------------------------------------------

  describe('version and subject requirements', () => {
    it('rejects a definition missing version', () => {
      expect(() =>
        validator.validate({ subject: 'media_item', match: 'all', conditions: [], actions: [] }),
      ).toThrow(BadRequestException);
    });

    it('rejects a definition with a version other than 1', () => {
      expect(() =>
        validator.validate({
          version: 2,
          subject: 'media_item',
          match: 'all',
          conditions: [],
          actions: [],
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects a definition missing subject', () => {
      expect(() =>
        validator.validate({ version: 1, match: 'all', conditions: [], actions: [] }),
      ).toThrow(BadRequestException);
    });

    it('rejects an unregistered subject', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'duplicate_group',
          match: 'all',
          conditions: [],
          actions: [],
        }),
      ).toThrow(/Unknown workflow subject/);
    });

    it('rejects a missing match', () => {
      expect(() =>
        validator.validate({ version: 1, subject: 'media_item', conditions: [], actions: [] }),
      ).toThrow(BadRequestException);
    });

    it('rejects an invalid match value', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'xor',
          conditions: [],
          actions: [],
        }),
      ).toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown field rejected
  // ---------------------------------------------------------------------------

  describe('unknown field rejection', () => {
    it('rejects an unregistered field for media_item', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [{ field: 'doesNotExist', op: 'equals', value: 'x' }],
          actions: [],
        }),
      ).toThrow(/Unknown field "doesNotExist"/);
    });

    it('rejects an unregistered field nested inside a group', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [
            {
              match: 'all',
              conditions: [{ field: 'bogusNestedField', op: 'is', value: true }],
            },
          ],
          actions: [],
        }),
      ).toThrow(/Unknown field "bogusNestedField"/);
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-Subject / unregistered action rejected
  // ---------------------------------------------------------------------------

  describe('unregistered action rejection', () => {
    it('rejects an action type not in the media_item action catalog', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [],
          actions: [{ type: 'launch_rocket' }],
        }),
      ).toThrow(/Unknown action "launch_rocket"/);
    });

    /**
     * Valid params for each action that requires them. Actions absent from
     * this map take none.
     *
     * Enumerated by hand rather than derived, so adding an action with a
     * required param forces a deliberate entry here instead of silently
     * passing with `{}` — which is exactly what happened before issue #459
     * wired `paramsSchema` into the validator.
     */
    const VALID_PARAMS: Record<string, Record<string, unknown>> = {
      add_to_album: { createAlbumNamed: 'Trip' },
      remove_from_album: { albumId: '11111111-1111-4111-8111-111111111111' },
      add_tags: { names: ['beach'] },
      remove_tags: { names: ['beach'] },
      set_favorite: { value: true },
      set_captured_at: { mode: 'set', value: '2026-01-01T00:00:00.000Z' },
      move_to_circle: { targetCircleId: '22222222-2222-4222-8222-222222222222' },
      assign_person: { personId: '33333333-3333-4333-8333-333333333333' },
      remove_person: { personId: '33333333-3333-4333-8333-333333333333' },
      set_location: { lat: 9.93, lng: -84.08 },
      resolve_burst_group: { action: 'archive' },
      resolve_duplicate_group: { action: 'archive' },
      rerun_enrichment: { kinds: ['tagging'] },
    };

    it('accepts every action type actually registered for media_item', () => {
      // Driven off the REGISTRY rather than a hand-listed array, so a newly
      // registered action is covered automatically instead of being forgotten.
      const actionTypes = registeredActions('media_item').map((a) => a.type);
      expect(actionTypes.length).toBeGreaterThan(0);

      for (const type of actionTypes) {
        const params = VALID_PARAMS[type];
        expect(() =>
          validator.validate({
            version: 1,
            subject: 'media_item',
            match: 'all',
            conditions: [],
            actions: [{ type, ...(params ?? {}) }],
          }),
        ).not.toThrow();
      }
    });

    // -------------------------------------------------------------------------
    // Action params validation (epic #452, issue #459)
    //
    // `WorkflowActionDescriptor.paramsSchema` was declared on all 22 actions
    // and never invoked anywhere, so params were structurally unvalidated at
    // create and run time and the executor blind-cast them. A malformed value
    // reached the executor and failed at runtime, per item, inside a batch job.
    // -------------------------------------------------------------------------

    it('rejects an action whose required params are missing, at SAVE time rather than per item at run time', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [],
          actions: [{ type: 'add_tags' }],
        }),
      ).toThrow(/Invalid params for action "add_tags"/);
    });

    it('rejects a malformed rerun_enrichment kinds array — the exact value the executor used to blind-cast', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [],
          actions: [{ type: 'rerun_enrichment', kinds: [] }],
        }),
      ).toThrow(/Invalid params for action "rerun_enrichment"/);

      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [],
          actions: [{ type: 'rerun_enrichment', kinds: ['not_a_kind'] }],
        }),
      ).toThrow(/Invalid params for action "rerun_enrichment"/);
    });

    it('rejects unknown keys on a no-param action', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [],
          actions: [{ type: 'archive', surprise: true }],
        }),
      ).toThrow(/Invalid params for action "archive"/);
    });

    it('NORMALIZES params by applying the schema defaults the executor then reads', () => {
      const def = validator.validate({
        version: 1,
        subject: 'media_item',
        match: 'all',
        conditions: [],
        actions: [{ type: 'remove_tags', names: ['beach'] }],
      });

      // `sources` defaults to AI + system so a cleanup workflow never strips a
      // user's manually-applied tags. Params are FLAT siblings of `type` —
      // WorkflowExecuteBatchHandler rebuilds the executor's bag by
      // destructuring `const { type, ...params } = a`.
      expect(def.actions[0]).toEqual({
        type: 'remove_tags',
        names: ['beach'],
        sources: ['ai', 'system'],
      });
    });

    it('round-trips a no-param action byte-identically', () => {
      const def = validator.validate({
        version: 1,
        subject: 'media_item',
        match: 'all',
        conditions: [],
        actions: [{ type: 'archive' }],
      });

      // The normalized definition is persisted and snapshotted into
      // definition_snapshot, so it must not sprout keys the caller never sent.
      expect(def.actions[0]).toEqual({ type: 'archive' });
    });

    it('registers rerun_ai_tagging, the epic #452 shortcut, taking no params', () => {
      const types = registeredActions('media_item').map((a) => a.type);
      expect(types).toContain('rerun_ai_tagging');

      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [],
          actions: [{ type: 'rerun_ai_tagging' }],
        }),
      ).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Nesting depth > 1 rejected (structural — enforced by the Zod schema)
  // ---------------------------------------------------------------------------

  describe('nesting depth', () => {
    it('rejects a group nested inside another group (depth 2)', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [
            {
              match: 'all',
              conditions: [
                {
                  match: 'any',
                  conditions: [{ field: 'filename', op: 'contains', value: 'x' }],
                },
              ],
            },
          ],
          actions: [],
        }),
      ).toThrow(BadRequestException);
    });

    it('accepts exactly one level of nesting', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [
            {
              match: 'all',
              conditions: [{ field: 'filename', op: 'contains', value: 'x' }],
            },
          ],
          actions: [],
        }),
      ).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Operator/value type mismatches
  // ---------------------------------------------------------------------------

  describe('operator not valid for field', () => {
    it('rejects an operator the field does not declare', () => {
      // filename only supports contains/starts_with/ends_with/equals — not gt.
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [{ field: 'filename', op: 'gt', value: 'x' }],
          actions: [],
        }),
      ).toThrow(/Operator "gt" is not valid for field "filename"/);
    });
  });

  describe('operand type mismatches', () => {
    it('rejects a non-boolean value for a boolean "is" field', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [{ field: 'missingCamera', op: 'is', value: 'yes' }],
          actions: [],
        }),
      ).toThrow(/value must be a boolean/);
    });

    it('rejects a non-enum value for an enum "is" field (coordSource)', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [{ field: 'coordSource', op: 'is', value: 'gps_satellite' }],
          actions: [],
        }),
      ).toThrow(/value must be one of/);
    });

    it('accepts a valid enum value for coordSource', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [{ field: 'coordSource', op: 'is', value: 'exif' }],
          actions: [],
        }),
      ).not.toThrow();
    });

    it('rejects a non-numeric value for a gt/lt/gte operator', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [{ field: 'fileSize', op: 'gt', value: 'huge' }],
          actions: [],
        }),
      ).toThrow(/value must be a number/);
    });

    it('rejects an empty string for a contains operator', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [{ field: 'filename', op: 'contains', value: '' }],
          actions: [],
        }),
      ).toThrow(/non-empty string/);
    });

    it('rejects a non-ISO-date value for before/after', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [{ field: 'capturedAt', op: 'before', value: 'not-a-date' }],
          actions: [],
        }),
      ).toThrow(/ISO 8601 date string/);
    });

    it('rejects a non-positive-integer value for older_than_days', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [{ field: 'capturedAt', op: 'older_than_days', value: -5 }],
          actions: [],
        }),
      ).toThrow(/positive integer/);
    });

    it('rejects a between value with neither from nor to', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [{ field: 'capturedAt', op: 'between', value: {} }],
          actions: [],
        }),
      ).toThrow(/from\?, to\?/);
    });

    it('accepts a between value with only "from"', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [
            { field: 'capturedAt', op: 'between', value: { from: '2024-01-01T00:00:00.000Z' } },
          ],
          actions: [],
        }),
      ).not.toThrow();
    });

    it('rejects an empty array for has_any', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [{ field: 'tags', op: 'has_any', value: [] }],
          actions: [],
        }),
      ).toThrow(/non-empty array of strings/);
    });

    it('rejects a has_person value missing ids', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [{ field: 'people', op: 'has_person', value: { mode: 'all' } }],
          actions: [],
        }),
      ).toThrow(/non-empty ids array/);
    });

    it('rejects an invalid mode on a has_person value', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [
            {
              field: 'people',
              op: 'has_person',
              value: { ids: ['11111111-1111-1111-1111-111111111111'], mode: 'majority' },
            },
          ],
          actions: [],
        }),
      ).toThrow(/mode must be 'any' or 'all'/);
    });

    it('rejects a near value missing radiusKm', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [{ field: 'near', op: 'near', value: { lat: 1, lng: 2 } }],
          actions: [],
        }),
      ).toThrow(/lat, lng, radiusKm/);
    });

    it('accepts a valid near value', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [{ field: 'near', op: 'near', value: { lat: 9.9, lng: -84.0, radiusKm: 10 } }],
          actions: [],
        }),
      ).not.toThrow();
    });

    it('rejects a non-uuid string for in_album', () => {
      expect(() =>
        validator.validate({
          version: 1,
          subject: 'media_item',
          match: 'all',
          conditions: [{ field: 'album', op: 'in_album', value: '' }],
          actions: [],
        }),
      ).toThrow(/album UUID string/);
    });
  });

  // ---------------------------------------------------------------------------
  // Extra/unknown keys on a leaf are rejected by the strict Zod schema
  // ---------------------------------------------------------------------------

  it('rejects a leaf with unexpected extra keys (strict schema)', () => {
    expect(() =>
      validator.validate({
        version: 1,
        subject: 'media_item',
        match: 'all',
        conditions: [{ field: 'filename', op: 'contains', value: 'x', extra: 'nope' }],
        actions: [],
      }),
    ).toThrow(BadRequestException);
  });
});
