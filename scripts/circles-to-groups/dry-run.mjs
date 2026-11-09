#!/usr/bin/env node
/**
 * dry-run.mjs - what the RETRO-I2 migration (#569,
 * `20261108200000_i2_circles_to_groups_ownership`) will do to this database.
 * READ-ONLY (one READ ONLY transaction, rolled back). Run it on the restored
 * backup BEFORE `npm run prisma:migrate`, keep the output with the rehearsal log
 * (docs/runbooks/circles-to-groups.md).
 *
 *   node scripts/circles-to-groups/dry-run.mjs [--database <url>] [--json]
 *
 * Prints: the default organization; circles (personal / shared); the group and
 * member rows the migration will create, per role; shared circles with no
 * circle_admin (their owner becomes the group admin); circle members with no
 * active membership of the default organization (the group slice's
 * NOT_AN_ORG_MEMBER rule would refuse them later); and, per content table, the
 * rows that become group-owned / user-owned and the rows with NO owner, which
 * make the migration abort (it raises rather than guessing).
 *
 * Exit 0 when the migration can run, 1 when it would abort (a blocker is listed),
 * 2 on a usage or connection error.
 */
import { connect, CONTENT_TABLES, NO_CIRCLE_FK, ROLE_MAP } from './common.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');

async function main() {
  const db = await connect(argv);
  const blockers = [];
  try {
    const org = await db.one(`SELECT id FROM organizations WHERE is_default LIMIT 1`);
    const circles = await db.one(
      `SELECT count(*) FILTER (WHERE is_personal)::int AS personal, count(*) FILTER (WHERE NOT is_personal)::int AS shared FROM circles`,
    );
    if (!org && circles.personal + circles.shared > 0) blockers.push('no default organization (organizations.is_default)');

    const memberRoles = await db.rows(
      `SELECT m.role::text AS role, count(*)::int AS n FROM circle_members m JOIN circles c ON c.id = m.circle_id
       WHERE NOT c.is_personal GROUP BY 1 ORDER BY 1`,
    );
    const noAdmin = await db.rows(
      `SELECT c.id, c.owner_id,
              EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id = c.id AND m.user_id = c.owner_id) AS owner_is_member
       FROM circles c
       WHERE NOT c.is_personal
         AND NOT EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id = c.id AND m.role = 'circle_admin')
       ORDER BY c.id`,
    );
    const notOrgMembers = org
      ? await db.rows(
          `SELECT DISTINCT m.user_id FROM circle_members m JOIN circles c ON c.id = m.circle_id AND NOT c.is_personal
           WHERE NOT EXISTS (SELECT 1 FROM memberships ms WHERE ms.user_id = m.user_id AND ms.org_id = $1 AND ms.status = 'active')
           ORDER BY 1`,
          [org.id],
        )
      : [];

    const tables = [];
    for (const table of CONTENT_TABLES) {
      const fallback = NO_CIRCLE_FK.has(table)
        ? `LEFT JOIN media_items mi ON mi.id = t.media_item_id LEFT JOIN circles c2 ON c2.id = mi.circle_id`
        : '';
      const owner = NO_CIRCLE_FK.has(table) ? `COALESCE(c.id, c2.id)` : 'c.id';
      const personal = NO_CIRCLE_FK.has(table) ? `COALESCE(c.is_personal, c2.is_personal)` : 'c.is_personal';
      const row = await db.one(
        `SELECT count(*)::int AS rows,
                count(*) FILTER (WHERE ${owner} IS NOT NULL AND NOT ${personal})::int AS group_owned,
                count(*) FILTER (WHERE ${owner} IS NOT NULL AND ${personal})::int AS user_owned,
                count(*) FILTER (WHERE ${owner} IS NULL)::int AS no_owner
         FROM ${table} t LEFT JOIN circles c ON c.id = t.circle_id ${fallback}`,
      );
      tables.push({ table, ...row });
      if (row.no_owner > 0) blockers.push(`${table}: ${row.no_owner} row(s) with no circle to take an owner from`);
    }

    const report = {
      defaultOrganization: org?.id ?? null,
      circles,
      groupsToCreate: circles.shared,
      groupMembersToCreate: Object.fromEntries(memberRoles.map((r) => [ROLE_MAP[r.role] ?? 'viewer', r.n])),
      sharedCirclesWithoutAdmin: noAdmin.map((r) => ({ circleId: r.id, ownerBecomesAdmin: r.owner_id, ownerIsMember: r.owner_is_member })),
      circleMembersWithoutActiveOrgMembership: notOrgMembers.map((r) => r.user_id),
      tables,
      blockers,
    };
    if (json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      console.log(`default organization: ${report.defaultOrganization ?? 'NONE'}`);
      console.log(`circles: ${circles.personal} personal (no group), ${circles.shared} shared (one group each)`);
      console.log(`group members to create: ${JSON.stringify(report.groupMembersToCreate)}`);
      console.log(`shared circles with no circle_admin (owner becomes group admin): ${noAdmin.length}`);
      for (const r of report.sharedCirclesWithoutAdmin) console.log(`  ${r.circleId} owner ${r.ownerBecomesAdmin}${r.ownerIsMember ? '' : ' (not a member today)'}`);
      console.log(`circle members with no active default-organization membership: ${notOrgMembers.length}`);
      console.log('table                       rows   group-owned  user-owned  NO OWNER');
      for (const t of tables) {
        console.log(`${t.table.padEnd(27)} ${String(t.rows).padStart(7)} ${String(t.group_owned).padStart(12)} ${String(t.user_owned).padStart(11)} ${String(t.no_owner).padStart(9)}`);
      }
      console.log(blockers.length === 0 ? 'OK: the migration can run' : `BLOCKED:\n  ${blockers.join('\n  ')}`);
    }
  } finally {
    await db.close();
  }
  return blockers.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`dry-run failed: ${error.message}`);
    process.exit(2);
  },
);
