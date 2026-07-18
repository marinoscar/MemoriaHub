// ---------------------------------------------------------------------------
// definitionToSentence — render a workflow draft as one plain-English sentence
// that updates live above the preview panel, e.g.
//   "When new media is enriched, if the filename contains 'screenshot' or it's
//    a PNG with no camera and no date, move it to Trash."
//
// Pure and defensive — never throws; unknown fields/operators/actions fall back
// to their raw keys/labels. Kept out of React so it is unit-testable.
// ---------------------------------------------------------------------------

import type {
  WorkflowDefinition,
  WorkflowLeafCondition,
  WorkflowTopCondition,
  WorkflowFieldDescriptor,
  WorkflowMatch,
  WorkflowActionInstance,
  WorkflowTriggerType,
  SubjectRegistryEntry,
} from '../types/workflows';
import { isWorkflowGroupCondition } from '../types/workflows';
import { cronToText } from './workflowFormat';

function lc(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function quote(v: unknown): string {
  return `“${String(v)}”`;
}

function joinList(parts: string[], conj: 'and' | 'or'): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} ${conj} ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} ${conj} ${parts[parts.length - 1]}`;
}

function conjFor(match: WorkflowMatch): 'and' | 'or' {
  return match === 'any' ? 'or' : 'and';
}

// ---- Leaf phrasing --------------------------------------------------------

function leafPhrase(
  leaf: WorkflowLeafCondition,
  field: WorkflowFieldDescriptor | undefined,
): string {
  if (!field) return '(incomplete condition)';
  const label = lc(field.label);
  const v = leaf.value;

  switch (leaf.op) {
    case 'contains':
      return `the ${label} contains ${quote(v)}`;
    case 'starts_with':
      return `the ${label} starts with ${quote(v)}`;
    case 'ends_with':
      return `the ${label} ends with ${quote(v)}`;
    case 'equals':
      return `the ${label} is ${field.type === 'enum' ? String(v) : quote(v)}`;
    case 'is': {
      // Boolean field: value true → the label reads as the state; false → negated.
      if (field.valueType === 'boolean') {
        return v === false ? `not ${label}` : label;
      }
      return `the ${label} is ${String(v)}`;
    }
    case 'is_set':
      return `the ${label} is set`;
    case 'gt':
      return `the ${label} is greater than ${String(v)}`;
    case 'lt':
      return `the ${label} is less than ${String(v)}`;
    case 'gte':
      return `the ${label} is at least ${String(v)}`;
    case 'between': {
      const range = (v ?? {}) as { from?: string; to?: string };
      if (range.from && range.to) return `the ${label} is between ${range.from} and ${range.to}`;
      if (range.from) return `the ${label} is on or after ${range.from}`;
      if (range.to) return `the ${label} is on or before ${range.to}`;
      return `the ${label} is in a date range`;
    }
    case 'before':
      return `the ${label} is before ${String(v)}`;
    case 'after':
      return `the ${label} is after ${String(v)}`;
    case 'older_than_days':
      return `the ${label} is older than ${String(v)} days`;
    case 'within_last_days':
      return `the ${label} is within the last ${String(v)} days`;
    case 'has_any':
      return `it has any of the tags ${tagList(v)}`;
    case 'has_all':
      return `it has all of the tags ${tagList(v)}`;
    case 'has_none':
      return `it has none of the tags ${tagList(v)}`;
    case 'has_person':
      return 'it includes the selected people';
    case 'not_has_person':
      return 'it excludes the selected people';
    case 'in_album':
      return 'it is in the selected album';
    case 'not_in_album':
      return 'it is not in the selected album';
    case 'near': {
      const geo = (v ?? {}) as { radiusKm?: number };
      return `it is within ${geo.radiusKm ?? '?'} km of the selected location`;
    }
    default:
      return `the ${label} ${leaf.op} ${v !== undefined ? quote(v) : ''}`.trim();
  }
}

function tagList(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return '(none)';
  return (v as unknown[]).map((t) => quote(t)).join(', ');
}

// ---- Conditions clause ----------------------------------------------------

function conditionsClause(
  def: WorkflowDefinition,
  fieldByKey: Map<string, WorkflowFieldDescriptor>,
): string {
  if (def.conditions.length === 0) return 'for every item';

  const topConj = conjFor(def.match);
  const parts = def.conditions.map((c: WorkflowTopCondition) => {
    if (isWorkflowGroupCondition(c)) {
      const groupConj = conjFor(c.match);
      const inner = c.conditions.map((leaf) =>
        leafPhrase(leaf, fieldByKey.get(leaf.field)),
      );
      return `(${joinList(inner, groupConj)})`;
    }
    return leafPhrase(c, fieldByKey.get(c.field));
  });

  return `if ${joinList(parts, topConj)}`;
}

// ---- Action phrasing ------------------------------------------------------

function actionPhrase(
  action: WorkflowActionInstance,
  labelByType: Map<string, string>,
): string {
  const a = action as Record<string, unknown>;
  switch (action.type) {
    case 'move_to_trash':
      return 'move it to Trash';
    case 'hard_delete':
      return 'permanently delete it';
    case 'archive':
      return 'archive it';
    case 'unarchive':
      return 'unarchive it';
    case 'add_to_album':
      return typeof a.createAlbumNamed === 'string' && a.createAlbumNamed
        ? `add it to a new album ${quote(a.createAlbumNamed)}`
        : 'add it to the selected album';
    case 'remove_from_album':
      return 'remove it from the selected album';
    case 'add_tags':
      return Array.isArray(a.names) && a.names.length
        ? `tag it ${(a.names as unknown[]).map(quote).join(', ')}`
        : 'add tags';
    case 'remove_tags':
      return Array.isArray(a.names) && a.names.length
        ? `remove the tags ${(a.names as unknown[]).map(quote).join(', ')}`
        : 'remove tags';
    case 'set_favorite':
      return a.value === false ? 'un-favorite it' : 'mark it a favorite';
    case 'set_captured_at':
      if (a.mode === 'clear') return 'clear its capture date';
      if (a.mode === 'shift') return `shift its capture date by ${String(a.shiftMinutes ?? 0)} minutes`;
      return 'set its capture date';
    case 'assign_person':
      return 'assign the selected person';
    case 'remove_person':
      return 'remove the selected person';
    case 'set_location':
      return 'set its location';
    case 'clear_location':
      return 'clear its location';
    case 'move_to_circle':
      return 'move it to another circle';
    case 'rerun_enrichment':
      return Array.isArray(a.kinds) && a.kinds.length
        ? `re-run enrichment (${(a.kinds as unknown[]).join(', ')})`
        : 're-run enrichment';
    case 'resolve_burst_group':
      return a.action === 'archive'
        ? 'keep the best shot and archive the rest of its burst'
        : 'keep the best shot and trash the rest of its burst';
    case 'dismiss_burst_group':
      return 'dismiss its burst group';
    case 'resolve_duplicate_group':
      return a.action === 'archive'
        ? 'keep the best copy and archive the duplicates'
        : 'keep the best copy and trash the duplicates';
    case 'dismiss_duplicate_group':
      return 'dismiss its duplicate group';
    case 'accept_location_suggestion':
      return 'accept its location suggestion';
    case 'reject_location_suggestion':
      return 'reject its location suggestion';
    default:
      return lc(labelByType.get(action.type) ?? action.type.replace(/_/g, ' '));
  }
}

// ---- Trigger clause -------------------------------------------------------

function triggerClause(
  trigger: WorkflowTriggerType | undefined,
  cronExpression: string | undefined,
): string {
  switch (trigger) {
    case 'on_media_enriched':
      return 'When new media is enriched';
    case 'scheduled': {
      const text = cronExpression ? cronToText(cronExpression) : '';
      return text ? text : 'On a schedule';
    }
    case 'manual':
    default:
      return 'When you run this workflow';
  }
}

// ---- Public entry ---------------------------------------------------------

export function definitionToSentence(
  def: WorkflowDefinition,
  subjectEntry?: SubjectRegistryEntry,
  trigger?: WorkflowTriggerType,
  cronExpression?: string,
): string {
  const fieldByKey = new Map<string, WorkflowFieldDescriptor>(
    (subjectEntry?.fields ?? []).map((f) => [f.key, f]),
  );
  const labelByType = new Map<string, string>(
    (subjectEntry?.actions ?? []).map((a) => [a.type, a.label]),
  );

  const when = triggerClause(trigger, cronExpression);
  const cond = conditionsClause(def, fieldByKey);
  const actions =
    def.actions.length === 0
      ? 'do nothing yet'
      : joinList(
          def.actions.map((a) => actionPhrase(a, labelByType)),
          'and',
        );

  return `${when}, ${cond}, ${actions}.`;
}
