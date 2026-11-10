// An `OwnerScopeSweepService` double (RETRO-K1) over the `circle.findUnique`-shaped fixtures older
// specs seed: `{ name, members: [{ userId }] }` (null = no such library). `summary` runs the lookup
// once; `membersOf` answers from the row it found, so a spec counting lookups counts one per library.
export function scopesOverCircleLookup(findUnique: jest.Mock) {
  let last: { name: string; members?: Array<{ userId: string }> } | null | undefined;
  return {
    summary: jest.fn(async (id: string) => {
      last = await findUnique({ where: { id } });
      return last ? { id, name: last.name, kind: 'group' as const, ownerId: null, createdById: null } : null;
    }),
    membersOf: jest.fn(async () => (last?.members ?? []).map((m) => ({ userId: m.userId, role: 'viewer' as const }))),
  };
}
