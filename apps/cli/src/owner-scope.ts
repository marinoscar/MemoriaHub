// The library uploads go to (RETRO-I6, #588), shared by config.ts, `groups use` and the
// TUI's GroupManager. Kept out of config.ts so it has no file-system dependency.

/** The personal library (`me`), or one group. */
export type ActiveOwnerScope = { kind: 'me' } | { kind: 'group'; groupId: string };

/** Reads a stored `activeOwnerScope` defensively; a malformed value is "no choice". */
export function parseActiveOwnerScope(value: unknown): ActiveOwnerScope | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as { kind?: unknown; groupId?: unknown };
  if (v.kind === 'me') return { kind: 'me' };
  if (v.kind === 'group' && typeof v.groupId === 'string' && v.groupId) return { kind: 'group', groupId: v.groupId };
  return undefined;
}

/** The `activeOwnerScope` + legacy `activeCircleId` pair for a chosen library (what `groups use` writes). */
export function ownerScopeFields(scope: { id: string; isPersonal?: boolean }): { activeOwnerScope: ActiveOwnerScope; activeCircleId: string } {
  return {
    activeOwnerScope: scope.isPersonal ? { kind: 'me' } : { kind: 'group', groupId: scope.id },
    activeCircleId: scope.id,
  };
}

