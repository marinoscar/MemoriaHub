/**
 * Unit tests for WorkflowDefinitionValidator (issue #139).
 *
 * Pure — no NestJS module or DB dependency (constructed directly). Layers
 * registry-aware validation on top of the structural Zod schema.
 */
import { BadRequestException } from '@nestjs/common';
import { WorkflowDefinitionValidator } from './workflow-definition.validator';

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

    it('accepts every action type actually registered for media_item', () => {
      const actionTypes = [
        'move_to_trash',
        'hard_delete',
        'archive',
        'unarchive',
        'add_to_album',
        'remove_from_album',
        'add_tags',
        'remove_tags',
        'set_favorite',
        'set_captured_at',
        'move_to_circle',
        'assign_person',
        'remove_person',
        'set_location',
        'clear_location',
        'resolve_burst_group',
        'dismiss_burst_group',
        'resolve_duplicate_group',
        'dismiss_duplicate_group',
        'accept_location_suggestion',
        'reject_location_suggestion',
        'rerun_enrichment',
      ];
      for (const type of actionTypes) {
        expect(() =>
          validator.validate({
            version: 1,
            subject: 'media_item',
            match: 'all',
            conditions: [],
            actions: [{ type }],
          }),
        ).not.toThrow();
      }
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
