import { WorkflowSubject } from '@prisma/client';
import {
  SubjectRegistryEntry,
  WorkflowFieldDescriptor,
} from './field-descriptor.interface';
import { MEDIA_ITEM_ACTIONS, MEDIA_ITEM_FIELDS } from './media-item-fields';

/**
 * Per-Subject registry — the extension point for future Subjects (duplicate
 * group, burst group, location suggestion, unassigned face, person). v1
 * registers exactly `media_item`; the compiler, validator, and subjects API all
 * resolve their catalogs through this map so a new Subject slots in by adding an
 * entry here (plus its own field/action catalog) with no engine change.
 */
const REGISTRY: Record<string, SubjectRegistryEntry> = {
  [WorkflowSubject.media_item]: {
    subject: WorkflowSubject.media_item,
    label: 'Media Item',
    // Phase 1 registers the trigger vocabulary; execution/scheduling is Phase 2/4.
    triggers: ['manual', 'on_media_enriched', 'scheduled'],
    fields: MEDIA_ITEM_FIELDS,
    actions: MEDIA_ITEM_ACTIONS,
  },
};

/** All registered Subject keys. */
export function registeredSubjects(): string[] {
  return Object.keys(REGISTRY);
}

/** True when `subject` is a registered Subject. */
export function isRegisteredSubject(subject: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, subject);
}

/** Get a Subject's registry entry, or undefined if unknown. */
export function getSubjectRegistry(subject: string): SubjectRegistryEntry | undefined {
  return REGISTRY[subject];
}

/** Get the full registry (all Subjects). Used by GET /api/workflows/subjects. */
export function getFullRegistry(): SubjectRegistryEntry[] {
  return Object.values(REGISTRY);
}

/** O(1) field lookup within a Subject. Returns undefined for an unknown field. */
export function getField(
  subject: string,
  fieldKey: string,
): WorkflowFieldDescriptor | undefined {
  const entry = REGISTRY[subject];
  if (!entry) return undefined;
  return entry.fields.find((f) => f.key === fieldKey);
}

/** True when `actionType` is registered for the Subject. */
export function isRegisteredAction(subject: string, actionType: string): boolean {
  const entry = REGISTRY[subject];
  if (!entry) return false;
  return entry.actions.some((a) => a.type === actionType);
}
