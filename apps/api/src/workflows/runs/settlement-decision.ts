import { WorkflowDependency } from '../registry/field-descriptor.interface';

/**
 * Media Workflow Automation — on_media_enriched settlement decision (issue #142).
 *
 * A pure predicate over a media item's per-dependency "settled" snapshot. An
 * item is evaluable for an on_media_enriched workflow only once EVERY enrichment
 * dependency the workflow's conditions read has reached a terminal state.
 *
 * "Terminal" deliberately includes the negative/absent terminal outcomes
 * (failed / no_faces / no-group-formed / feature-disabled) so a workflow whose
 * conditions depend on an enrichment that produced nothing is never stranded —
 * the listener that builds the DependencyState encodes those rules.
 */
export interface DependencyState {
  metadata: boolean;
  tags: boolean;
  faces: boolean;
  bursts: boolean;
  duplicates: boolean;
  locationSuggestions: boolean;
}

/** True iff every dependency in `deps` is settled in `state`. */
export function isFullySettled(
  deps: Set<WorkflowDependency>,
  state: DependencyState,
): boolean {
  for (const dep of deps) {
    if (!state[dep]) return false;
  }
  return true;
}
