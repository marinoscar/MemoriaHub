// =============================================================================
// The RETRO-I2 circle -> group mirror, emulated over the mocked Prisma client
// (RETRO-I3, #573)
// =============================================================================
//
// In the database, `mh_circle_member_mirror` copies every `circle_members` row
// of a shared circle into `group_members` (same group id, role mapped
// collaborator -> editor, circle_admin -> admin), and owner-scope access reads
// the caller's role from `group_members` through the sharing slice's
// `SHARING_DATA` port. Mocked-Prisma suites seed circle membership the way
// they always did (`circle.findUnique` + `circleMember.findUnique`); this
// `SHARING_DATA` stand-in answers the slice's `groupMember.findMany` from
// those same mocks, so a suite exercises the real `OwnerAccessService` and the
// real `PrincipalGroupsProvider` without re-seeding every fixture twice.
//
// The scope a lookup is for is the id of the most recent `circle.findUnique`
// call: `OwnerAccessService` always resolves the scope (`circle.findUnique`)
// immediately before it asks for the caller's groups.
// =============================================================================

const ROLE_MAP: Record<string, string> = { viewer: 'viewer', collaborator: 'editor', circle_admin: 'admin' };

function lastLookedUpCircleId(prisma: any): string | undefined {
  // `OwnerAccessService` asks the PersonalLibraryStore (`personalLibrary.findUnique`, RETRO-K2) which
  // scope an id is; the most recent lookup names the scope (older suites seed `circle.*`, kept for them).
  let best: { order: number; id: string } | undefined;
  for (const [delegate, name] of [['personalLibrary', 'findUnique'], ['circle', 'findUnique'], ['circle', 'findFirst']] as const) {
    const mock = prisma[delegate]?.[name]?.mock;
    const calls: any[][] = mock?.calls ?? [];
    const orders: number[] = mock?.invocationCallOrder ?? [];
    for (let i = 0; i < calls.length; i += 1) {
      const id = calls[i]?.[0]?.where?.id;
      if (typeof id === 'string' && (!best || (orders[i] ?? 0) > best.order)) best = { order: orders[i] ?? 0, id };
    }
  }
  return best?.id;
}

/** A `groupMember` delegate whose `findMany` reflects the mocked circle membership. */
export function mirroredGroupMemberDelegate(prisma: any) {
  return {
    findMany: async (args: { where?: { userId?: string; orgId?: string } }) => {
      const userId = args?.where?.userId;
      const circleId = lastLookedUpCircleId(prisma);
      if (!userId || !circleId) return [];
      const row = await prisma.circleMember.findUnique({ where: { circleId_userId: { circleId, userId } } });
      const role = row?.role ? ROLE_MAP[row.role] ?? row.role : null;
      return role ? [{ groupId: circleId, role }] : [];
    },
  };
}

/**
 * A `SHARING_DATA` port over the mock, with `groupMember` mirrored from the
 * circle mocks. `runAsSystem` goes through `system` (the suite's
 * PrismaSystemService) when given, so a suite that seeds the bypass pool keeps
 * seeing its data.
 */
export function mirroredSharingData(
  prisma: any,
  system?: { runAsSystem: (reason: string, fn: (tx: unknown) => unknown) => unknown },
) {
  const tx = new Proxy(prisma, {
    get(target, key) {
      if (key === 'groupMember') return mirroredGroupMemberDelegate(prisma);
      // RETRO-I3: AccessPolicy / accessibleWhere read grants and record owners through this
      // port. An unseeded deep-mock answers `undefined`; read that as "no rows".
      if (key === 'grant' || key === 'mediaItem' || key === 'album') return orEmpty(target[key]);
      return target[key];
    },
  });
  return {
    runInOrg: (_scope: unknown, fn: (tx: unknown) => unknown) => fn(tx),
    runAsSystem: (reason: string, fn: (tx: unknown) => unknown) =>
      system ? system.runAsSystem(reason, fn) : fn(prisma),
  };
}

/** A delegate whose `findMany` / `groupBy` answer `[]` instead of an unseeded mock's `undefined`. */
function orEmpty(delegate: any) {
  return new Proxy(delegate, {
    get(target, key) {
      const fn = target[key];
      if (key !== 'findMany' && key !== 'groupBy') return fn;
      return async (...args: unknown[]) => (await fn(...args)) ?? [];
    },
  });
}
