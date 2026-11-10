// =============================================================================
// Move actions: `move_to_owner` and its deprecated alias `move_to_circle`
// (RETRO-I6, #588)
// =============================================================================
//
// `move_to_owner` names its target as an owner scope:
//   { type: 'move_to_owner', target: { kind: 'me' } }
//   { type: 'move_to_owner', target: { kind: 'group', groupId } }
// `move_to_circle` ({ type: 'move_to_circle', targetCircleId }) stays valid for
// stored definitions, frozen run snapshots and queued batch payloads: both are
// resolved here to the ONE scope id the executor and the run-create checks use,
// so the two types can never behave differently.
//
// `me` resolves to the ACTING user's personal library at run time (the run's
// starter, or for an unattended run the user whose permissions authorize it).
// =============================================================================

import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { MemoriahubAccessPort } from '../../ports/index.js';

export const MOVE_TO_OWNER_ACTION = 'move_to_owner';
/** Deprecated name, accepted at validation and execution only. */
export const MOVE_TO_CIRCLE_ACTION = 'move_to_circle';

/** Whether an action type is one of the two move actions. */
export function isMoveAction(type: string): boolean {
  return type === MOVE_TO_OWNER_ACTION || type === MOVE_TO_CIRCLE_ACTION;
}

/** What a move action's params name, before `me` is resolved. */
export type MoveTargetRef = { kind: 'me' } | { kind: 'scope'; scopeId: string };

/**
 * Reads the target of a move action from its FLAT params (either type).
 * Throws 400 when neither `target` nor `targetCircleId` is usable.
 */
export function moveTargetRefOf(params: Record<string, unknown>): MoveTargetRef {
  const target = params['target'];
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const t = target as Record<string, unknown>;
    if (t['kind'] === 'me') return { kind: 'me' };
    if (t['kind'] === 'group' && typeof t['groupId'] === 'string' && t['groupId']) {
      return { kind: 'scope', scopeId: t['groupId'] };
    }
  }
  const legacy = params['targetCircleId'];
  if (typeof legacy === 'string' && legacy) return { kind: 'scope', scopeId: legacy };
  throw new BadRequestException('A move action requires a target');
}

/** The target scope id of a move action for `actorUserId`. 404 when `me` has no personal library. */
export async function resolveMoveTargetScope(
  params: Record<string, unknown>,
  actorUserId: string,
  access: Pick<MemoriahubAccessPort, 'personalLibraryOf'>,
): Promise<string> {
  const ref = moveTargetRefOf(params);
  if (ref.kind === 'scope') return ref.scopeId;
  const personal = await access.personalLibraryOf(actorUserId);
  if (!personal) throw new NotFoundException('No personal library');
  return personal;
}
