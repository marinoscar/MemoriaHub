import type { WorkflowActionInstance } from '../types/workflows';

// ---------------------------------------------------------------------------
// Client-side action metadata.
//
// The `GET /api/workflows/subjects` response strips action descriptors to
// `{ type, label, destructive? }`, so the advisory flags the builder UI needs
// (manual-trigger-only, high-impact) and the correct param-editor kind live
// here, keyed by action type. This mirrors the backend MEDIA_ITEM_ACTIONS
// catalog (apps/api/src/workflows/registry/media-item-fields.ts).
// ---------------------------------------------------------------------------

/** Actions that may only run on a manual trigger (backend rejects otherwise). */
export const MANUAL_ONLY_ACTIONS = new Set<string>(['hard_delete']);

/** Actions flagged high-impact (extra warning surface in the builder). */
export const HIGH_IMPACT_ACTIONS = new Set<string>([
  'hard_delete',
  'move_to_circle',
]);

/** Action type gated behind the admin `workflows.allowHardDelete` setting. */
export const ADMIN_GATED_ACTIONS = new Set<string>(['hard_delete']);

/** How to render an action's parameter editor. */
export type ActionParamKind =
  | 'none'
  | 'album' // add_to_album  → { albumId } XOR { createAlbumNamed }
  | 'albumId' // remove_from_album → { albumId }
  | 'tags' // add_tags / remove_tags → { names: string[] }
  | 'favorite' // set_favorite → { value: boolean }
  | 'capturedAt' // set_captured_at → { mode, value?, shiftMinutes? }
  | 'person' // assign_person / remove_person → { personId }
  | 'location' // set_location → { lat, lng }
  | 'circle' // move_to_circle → { targetCircleId }
  | 'rerunKinds' // rerun_enrichment → { kinds: string[] }
  | 'resolveAction'; // resolve_(burst|duplicate)_group → { action: 'archive'|'trash' }

export const ACTION_PARAM_KIND: Record<string, ActionParamKind> = {
  move_to_trash: 'none',
  hard_delete: 'none',
  archive: 'none',
  unarchive: 'none',
  add_to_album: 'album',
  remove_from_album: 'albumId',
  add_tags: 'tags',
  remove_tags: 'tags',
  set_favorite: 'favorite',
  set_captured_at: 'capturedAt',
  assign_person: 'person',
  remove_person: 'person',
  set_location: 'location',
  clear_location: 'none',
  move_to_circle: 'circle',
  rerun_enrichment: 'rerunKinds',
  resolve_burst_group: 'resolveAction',
  dismiss_burst_group: 'none',
  resolve_duplicate_group: 'resolveAction',
  dismiss_duplicate_group: 'none',
  accept_location_suggestion: 'none',
  reject_location_suggestion: 'none',
};

/** Enrichment kinds offered by the `rerun_enrichment` action. */
export const RERUN_KINDS = [
  'tagging',
  'faces',
  'metadata',
  'thumbnail',
  'duplicates',
] as const;

/** A fresh, minimally-valid instance for a newly-added action of `type`. */
export function defaultActionInstance(type: string): WorkflowActionInstance {
  switch (ACTION_PARAM_KIND[type]) {
    case 'tags':
      return { type, names: [] };
    case 'favorite':
      return { type, value: true };
    case 'capturedAt':
      return { type, mode: 'set' };
    case 'rerunKinds':
      return { type, kinds: [] };
    case 'resolveAction':
      return { type, action: 'trash' };
    default:
      return { type };
  }
}

export function paramKindFor(type: string): ActionParamKind {
  return ACTION_PARAM_KIND[type] ?? 'none';
}
