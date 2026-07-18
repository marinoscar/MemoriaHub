/**
 * Unit tests for the per-Subject workflow registry (issue #139). Pure lookups
 * over the static MEDIA_ITEM_FIELDS / MEDIA_ITEM_ACTIONS catalogs — no I/O.
 */
import {
  getField,
  getFullRegistry,
  getSubjectRegistry,
  isRegisteredAction,
  isRegisteredSubject,
  registeredSubjects,
} from './subject-registry';
import { MEDIA_ITEM_ACTIONS, MEDIA_ITEM_FIELDS } from './media-item-fields';

describe('subject-registry', () => {
  describe('registeredSubjects / isRegisteredSubject', () => {
    it('registers exactly one Subject in v1: media_item', () => {
      expect(registeredSubjects()).toEqual(['media_item']);
    });

    it('isRegisteredSubject resolves media_item', () => {
      expect(isRegisteredSubject('media_item')).toBe(true);
    });

    it('isRegisteredSubject returns false for an unknown subject', () => {
      expect(isRegisteredSubject('duplicate_group')).toBe(false);
      expect(isRegisteredSubject('burst_group')).toBe(false);
      expect(isRegisteredSubject('')).toBe(false);
    });
  });

  describe('getSubjectRegistry', () => {
    it('resolves the media_item registry entry with its full field/action catalogs', () => {
      const entry = getSubjectRegistry('media_item');
      expect(entry).toBeDefined();
      expect(entry!.subject).toBe('media_item');
      expect(entry!.label).toBe('Media Item');
      expect(entry!.triggers).toEqual(['manual', 'on_media_enriched', 'scheduled']);
      expect(entry!.fields).toBe(MEDIA_ITEM_FIELDS);
      expect(entry!.actions).toBe(MEDIA_ITEM_ACTIONS);
    });

    it('returns undefined for an unregistered subject (no throw)', () => {
      expect(getSubjectRegistry('unassigned_face')).toBeUndefined();
      expect(getSubjectRegistry('person')).toBeUndefined();
    });
  });

  describe('getFullRegistry', () => {
    it('returns an array with exactly one Subject entry', () => {
      const registry = getFullRegistry();
      expect(registry).toHaveLength(1);
      expect(registry[0].subject).toBe('media_item');
    });
  });

  describe('getField', () => {
    it('resolves a known field for media_item', () => {
      const field = getField('media_item', 'filename');
      expect(field).toBeDefined();
      expect(field!.key).toBe('filename');
      expect(field!.group).toBe('File');
    });

    it('returns undefined for an unknown field key on a known subject', () => {
      expect(getField('media_item', 'nonexistent_field')).toBeUndefined();
    });

    it('returns undefined for any field key on an unregistered subject', () => {
      expect(getField('duplicate_group', 'filename')).toBeUndefined();
    });
  });

  describe('isRegisteredAction', () => {
    it('resolves a known action for media_item', () => {
      expect(isRegisteredAction('media_item', 'move_to_trash')).toBe(true);
      expect(isRegisteredAction('media_item', 'archive')).toBe(true);
    });

    it('returns false for an unknown action on a known subject', () => {
      expect(isRegisteredAction('media_item', 'teleport')).toBe(false);
    });

    it('returns false for any action on an unregistered subject (cross-Subject rejection)', () => {
      expect(isRegisteredAction('burst_group', 'move_to_trash')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Catalog integrity — every field/action is well-formed
  // ---------------------------------------------------------------------------

  describe('MEDIA_ITEM_FIELDS catalog integrity', () => {
    it('every field has a unique key', () => {
      const keys = MEDIA_ITEM_FIELDS.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('every field declares key, label, group, type, operators, valueType, dependency, buildWhere', () => {
      for (const field of MEDIA_ITEM_FIELDS) {
        expect(typeof field.key).toBe('string');
        expect(typeof field.label).toBe('string');
        expect(typeof field.group).toBe('string');
        expect(typeof field.type).toBe('string');
        expect(Array.isArray(field.operators)).toBe(true);
        expect(field.operators.length).toBeGreaterThan(0);
        expect(typeof field.valueType).toBe('string');
        expect(typeof field.dependency).toBe('string');
        expect(typeof field.buildWhere).toBe('function');
      }
    });

    it('includes the documented review-state descriptors', () => {
      const keys = MEDIA_ITEM_FIELDS.map((f) => f.key);
      expect(keys).toEqual(
        expect.arrayContaining([
          'inPendingBurstGroup',
          'burstGroupConfidence',
          'inPendingDuplicateGroup',
          'duplicateGroupConfidence',
          'hasPendingLocationSuggestion',
          'locationSuggestionConfidence',
          'locationSuggestionMethod',
        ]),
      );
    });

    it('every field with enumValues has a non-empty array', () => {
      for (const field of MEDIA_ITEM_FIELDS) {
        if (field.enumValues) {
          expect(field.enumValues.length).toBeGreaterThan(0);
        }
      }
    });

    it('every readTimeRefinement field is documented as such and buildWhere still returns a bounding predicate', () => {
      const refinementFields = MEDIA_ITEM_FIELDS.filter((f) => f.readTimeRefinement);
      expect(refinementFields.map((f) => f.key).sort()).toEqual(
        ['duplicateGroupConfidence', 'megapixels', 'orientationShape'].sort(),
      );
      for (const field of refinementFields) {
        expect(field.buildWhere('gt' as any, 1)).toBeDefined();
      }
    });
  });

  describe('MEDIA_ITEM_ACTIONS catalog integrity', () => {
    it('every action has a unique type', () => {
      const types = MEDIA_ITEM_ACTIONS.map((a) => a.type);
      expect(new Set(types).size).toBe(types.length);
    });

    it('every action declares type and label', () => {
      for (const action of MEDIA_ITEM_ACTIONS) {
        expect(typeof action.type).toBe('string');
        expect(typeof action.label).toBe('string');
      }
    });

    it('hard_delete is flagged destructive', () => {
      const hardDelete = MEDIA_ITEM_ACTIONS.find((a) => a.type === 'hard_delete');
      expect(hardDelete?.destructive).toBe(true);
    });

    it('move_to_trash is not flagged destructive', () => {
      const moveToTrash = MEDIA_ITEM_ACTIONS.find((a) => a.type === 'move_to_trash');
      expect(moveToTrash?.destructive).toBeUndefined();
    });
  });
});
