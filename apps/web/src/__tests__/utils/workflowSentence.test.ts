/**
 * Unit tests for workflowSentence.ts (issue #141 — Workflows Phase 3 web UI).
 *
 * `definitionToSentence` renders a WorkflowDefinition as one plain-English
 * sentence for the live builder summary. It is pure, defensive, and never
 * throws — unknown fields/operators/actions fall back gracefully.
 */

import { describe, it, expect } from 'vitest';
import { definitionToSentence } from '../../utils/workflowSentence';
import { WORKFLOW_TEMPLATES } from '../../constants/workflowTemplates';
import type {
  WorkflowDefinition,
  WorkflowFieldDescriptor,
  SubjectRegistryEntry,
} from '../../types/workflows';

function field(
  key: string,
  label: string,
  overrides: Partial<WorkflowFieldDescriptor> = {},
): WorkflowFieldDescriptor {
  return {
    key,
    label,
    group: 'File',
    type: 'string',
    operators: ['contains', 'equals', 'is_set'],
    valueType: 'string',
    dependency: 'metadata',
    ...overrides,
  };
}

const SUBJECT: SubjectRegistryEntry = {
  subject: 'media_item',
  label: 'Media Items',
  triggers: ['manual', 'on_media_enriched', 'scheduled'],
  fields: [
    field('filename', 'Filename'),
    field('mimeType', 'Mime type', { type: 'enum', valueType: 'enum', enumValues: ['image/png'] }),
    field('missingCamera', 'Missing camera', { type: 'boolean', valueType: 'boolean', operators: ['is'] }),
    field('missingCapturedAt', 'Missing capture date', {
      type: 'boolean',
      valueType: 'boolean',
      operators: ['is'],
    }),
    field('socialMediaSource', 'Social media source', { operators: ['is_set'] }),
    field('capturedAt', 'Capture date', { group: 'Dates', type: 'date', valueType: 'date-range' }),
    field('country', 'Country', { group: 'Location' }),
    field('tags', 'Tags', { group: 'Tags', type: 'tag-set', valueType: 'string-list', operators: ['has_any', 'has_all', 'has_none'] }),
    field('inPendingDuplicateGroup', 'In a pending duplicate group', {
      group: 'Review',
      type: 'boolean',
      valueType: 'boolean',
      operators: ['is'],
    }),
    field('duplicateGroupConfidence', 'Duplicate group confidence', {
      group: 'Review',
      type: 'number',
      valueType: 'number',
      operators: ['gte'],
    }),
    field('nearLocation', 'Near a location', {
      group: 'Location',
      type: 'geo-radius',
      valueType: 'geo-radius',
      operators: ['near'],
    }),
  ],
  actions: [
    { type: 'move_to_trash', label: 'Move to Trash' },
    { type: 'archive', label: 'Archive' },
    { type: 'add_to_album', label: 'Add to album' },
    { type: 'add_tags', label: 'Add tags' },
    { type: 'resolve_duplicate_group', label: 'Resolve duplicate group' },
  ],
};

const BASE_DEF: WorkflowDefinition = {
  version: 1,
  subject: 'media_item',
  match: 'all',
  conditions: [],
  actions: [],
};

describe('definitionToSentence', () => {
  it('renders the "Clean up screenshots" template exactly (OR of a leaf and a nested AND group)', () => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.id === 'clean-up-screenshots')!;
    const sentence = definitionToSentence(
      template.definition,
      SUBJECT,
      template.suggestedTrigger,
      template.suggestedCron ?? undefined,
    );

    expect(sentence).toBe(
      'When new media is enriched, if the filename contains “screenshot” or ' +
        '(the mime type is image/png, missing camera and missing capture date), move it to Trash.',
    );
  });

  it('renders a nested group with an internal OR, combined with a top-level AND', () => {
    const def: WorkflowDefinition = {
      ...BASE_DEF,
      match: 'all',
      conditions: [
        { field: 'country', op: 'equals', value: 'Italy' },
        {
          match: 'any',
          conditions: [
            { field: 'missingCamera', op: 'is', value: true },
            { field: 'missingCapturedAt', op: 'is', value: true },
          ],
        },
      ],
      actions: [{ type: 'archive' }],
    };
    const sentence = definitionToSentence(def, SUBJECT, 'manual');
    expect(sentence).toBe(
      'When you run this workflow, if the country is “Italy” and ' +
        '(missing camera or missing capture date), archive it.',
    );
  });

  it('renders the "Archive social-media videos" template with a scheduled trigger and is_set operator', () => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.id === 'archive-social-videos')!;
    const sentence = definitionToSentence(
      template.definition,
      SUBJECT,
      template.suggestedTrigger,
      template.suggestedCron ?? undefined,
    );
    expect(sentence).toBe(
      'Daily at 3:00 AM, if the social media source is set, archive it.',
    );
  });

  it('renders a between date range condition with both bounds', () => {
    const def: WorkflowDefinition = {
      ...BASE_DEF,
      conditions: [
        { field: 'capturedAt', op: 'between', value: { from: '2025-06-01', to: '2025-06-14' } },
      ],
      actions: [{ type: 'add_to_album', createAlbumNamed: 'Italy 2025' }],
    };
    const sentence = definitionToSentence(def, SUBJECT, 'manual');
    expect(sentence).toBe(
      'When you run this workflow, if the capture date is between 2025-06-01 and 2025-06-14, ' +
        'add it to a new album “Italy 2025”.',
    );
  });

  it('renders a from-only and a to-only date range distinctly', () => {
    const fromOnly = definitionToSentence(
      { ...BASE_DEF, conditions: [{ field: 'capturedAt', op: 'between', value: { from: '2025-01-01' } }] },
      SUBJECT,
      'manual',
    );
    expect(fromOnly).toContain('the capture date is on or after 2025-01-01');

    const toOnly = definitionToSentence(
      { ...BASE_DEF, conditions: [{ field: 'capturedAt', op: 'between', value: { to: '2025-01-01' } }] },
      SUBJECT,
      'manual',
    );
    expect(toOnly).toContain('the capture date is on or before 2025-01-01');
  });

  it('renders has_any tag-list phrasing', () => {
    const def: WorkflowDefinition = {
      ...BASE_DEF,
      conditions: [{ field: 'tags', op: 'has_any', value: ['WhatsApp', 'Screenshot'] }],
      actions: [{ type: 'add_tags', names: ['WhatsApp'] }],
    };
    const sentence = definitionToSentence(def, SUBJECT, 'manual');
    expect(sentence).toContain(
      'it has any of the tags “WhatsApp”, “Screenshot”',
    );
    expect(sentence).toContain('tag it “WhatsApp”');
  });

  it('renders a "near" geo-radius condition', () => {
    const def: WorkflowDefinition = {
      ...BASE_DEF,
      conditions: [{ field: 'nearLocation', op: 'near', value: { lat: 1, lng: 2, radiusKm: 25 } }],
      actions: [{ type: 'archive' }],
    };
    const sentence = definitionToSentence(def, SUBJECT, 'manual');
    expect(sentence).toContain('it is within 25 km of the selected location');
  });

  it('renders the "Clean up duplicates" template with gte and boolean-true review conditions', () => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.id === 'clean-up-duplicates')!;
    const sentence = definitionToSentence(
      template.definition,
      SUBJECT,
      template.suggestedTrigger,
      template.suggestedCron ?? undefined,
    );
    expect(sentence).toBe(
      'Weekly on Sunday at 4:00 AM, if in a pending duplicate group and ' +
        'the duplicate group confidence is at least 0.9, keep the best copy and trash the duplicates.',
    );
  });

  it('renders "for every item" when there are no conditions', () => {
    const sentence = definitionToSentence(
      { ...BASE_DEF, conditions: [], actions: [{ type: 'archive' }] },
      SUBJECT,
      'manual',
    );
    expect(sentence).toContain('for every item');
  });

  it('renders "do nothing yet" when there are no actions', () => {
    const sentence = definitionToSentence(
      { ...BASE_DEF, conditions: [{ field: 'country', op: 'equals', value: 'Italy' }], actions: [] },
      SUBJECT,
      'manual',
    );
    expect(sentence).toContain('do nothing yet');
  });

  it('falls back to "When you run this workflow" for a manual/undefined trigger', () => {
    const sentence = definitionToSentence(BASE_DEF, SUBJECT, undefined);
    expect(sentence.startsWith('When you run this workflow,')).toBe(true);
  });

  it('is defensive against an incomplete condition (missing field descriptor)', () => {
    const def: WorkflowDefinition = {
      ...BASE_DEF,
      conditions: [{ field: 'unknownField', op: 'contains', value: 'x' }],
      actions: [{ type: 'archive' }],
    };
    expect(() => definitionToSentence(def, SUBJECT, 'manual')).not.toThrow();
    expect(definitionToSentence(def, SUBJECT, 'manual')).toContain('(incomplete condition)');
  });

  it('is defensive when subjectEntry is undefined (registry not yet loaded)', () => {
    const def: WorkflowDefinition = {
      ...BASE_DEF,
      conditions: [{ field: 'country', op: 'equals', value: 'Italy' }],
      actions: [{ type: 'archive' }],
    };
    expect(() => definitionToSentence(def, undefined, 'manual')).not.toThrow();
  });

  it('negates a false boolean value ("not <label>")', () => {
    const def: WorkflowDefinition = {
      ...BASE_DEF,
      conditions: [{ field: 'missingCamera', op: 'is', value: false }],
      actions: [{ type: 'archive' }],
    };
    const sentence = definitionToSentence(def, SUBJECT, 'manual');
    expect(sentence).toContain('not missing camera');
  });

  it('falls back to a prettified label for an unknown action type', () => {
    const def: WorkflowDefinition = {
      ...BASE_DEF,
      conditions: [],
      actions: [{ type: 'some_future_action' }],
    };
    // Exercise via the public entry with a subject entry whose action catalog
    // includes the label, so the fallback path (labelByType lookup) is hit.
    const subjectWithFutureAction: SubjectRegistryEntry = {
      ...SUBJECT,
      actions: [...SUBJECT.actions, { type: 'some_future_action', label: 'Some Future Action' }],
    };
    const sentence = definitionToSentence(def, subjectWithFutureAction, 'manual');
    // `lc()` only lowercases the FIRST character of the fallback label, so
    // "Some Future Action" becomes "some Future Action" (not fully lowercase).
    expect(sentence).toContain('some Future Action');
  });
});
