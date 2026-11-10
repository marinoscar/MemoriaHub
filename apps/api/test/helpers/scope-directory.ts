// A real-database stand-in for `OwnerScopeSweepService` (RETRO-K1): the same answers, read with
// SQL on a superuser Prisma client instead of through the sharing slice (which needs the Nest
// container). Only for db specs that construct services by hand.
import type { PrismaClient } from '@prisma/client';

type Row = Record<string, unknown>;

export function sqlScopeDirectory(prisma: PrismaClient) {
  const personal = async (): Promise<Row[]> =>
    (await prisma.$queryRawUnsafe(
      `SELECT c.id, c.owner_id AS "ownerId", u.email, u.display_name AS "displayName"
         FROM circles c JOIN users u ON u.id = c.owner_id WHERE c.is_personal ORDER BY c.id`,
    )) as Row[];
  return {
    async allScopes() {
      const groups = (await prisma.$queryRawUnsafe(`SELECT id, name, created_by_id AS "createdById" FROM groups ORDER BY id`)) as Row[];
      return [
        ...groups.map((g) => ({ id: g.id as string, name: g.name as string, kind: 'group' as const, ownerId: null, createdById: g.createdById as string | null })),
        ...(await personal()).map((p) => ({
          id: p.id as string,
          name: `${(p.displayName as string) || (p.email as string)}'s Library`,
          kind: 'personal' as const,
          ownerId: p.ownerId as string,
          createdById: null,
        })),
      ];
    },
    async allScopeIds() {
      return (await this.allScopes()).map((s) => s.id);
    },
    async summary(id: string) {
      return (await this.allScopes()).find((s) => s.id === id) ?? null;
    },
    async exists(id: string) {
      return (await this.summary(id)) !== null;
    },
    async membersOf(id: string, roles?: readonly string[]) {
      const owner = (await personal()).find((p) => p.id === id);
      if (owner) return !roles || roles.length === 0 || roles.includes('admin') ? [{ userId: owner.ownerId as string, role: 'admin' }] : [];
      const rows = (await prisma.$queryRawUnsafe(`SELECT user_id AS "userId", role FROM group_members WHERE group_id = $1::uuid`, id)) as Row[];
      return rows
        .map((r) => ({ userId: r.userId as string, role: r.role as string }))
        .filter((r) => !roles || roles.length === 0 || roles.includes(r.role));
    },
  };
}
