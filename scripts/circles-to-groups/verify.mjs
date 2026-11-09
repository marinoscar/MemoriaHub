#!/usr/bin/env node
/**
 * verify.mjs - proves the RETRO-I2 migration (#569) on this database. READ-ONLY.
 * Run it AFTER `npm run prisma:migrate` (docs/runbooks/circles-to-groups.md):
 *
 *   node scripts/circles-to-groups/verify.mjs [--database <url>] [--json]
 *
 * Checks (each prints its counts; any failure exits 1):
 *   groups          one group per shared circle, same id, name, description,
 *                   created_by_id = owner_id, in the default organization; no
 *                   group for a personal circle
 *   members         every member of a shared circle is a group member with the
 *                   mapped role (circle_admin -> admin, collaborator -> editor,
 *                   viewer -> viewer); the only extra rows are a circle owner made
 *                   admin of a group that had no admin
 *   ownership       on all 21 content tables: 0 rows with NULL org_id, 0 rows
 *                   without exactly one owner, and the owner equals what circle_id
 *                   says (shared circle -> owner_group_id = circle_id, personal
 *                   circle -> owner_user_id = its owner)
 *   schema          every content table ENABLEs and FORCEs row-level security and
 *                   has its <table>_org_isolation policy and mh_owner_from_circle
 *                   trigger; the circles / circle_members mirror triggers exist
 *
 * Exit 0 when everything holds, 1 with the differences, 2 on a usage error.
 */
import { connect, CONTENT_TABLES, NO_CIRCLE_FK, ROLE_MAP } from './common.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');

async function main() {
  const db = await connect(argv);
  const problems = [];
  const counts = {};
  try {
    const org = await db.one(`SELECT id FROM organizations WHERE is_default LIMIT 1`);

    // groups
    const g = await db.one(
      `SELECT (SELECT count(*)::int FROM circles WHERE NOT is_personal) AS shared_circles,
              (SELECT count(*)::int FROM circles c JOIN groups g ON g.id = c.id WHERE NOT c.is_personal
                 AND g.name = c.name AND g.description IS NOT DISTINCT FROM c.description
                 AND g.created_by_id IS NOT DISTINCT FROM c.owner_id AND g.org_id = $1) AS matching_groups,
              (SELECT count(*)::int FROM circles c JOIN groups g ON g.id = c.id WHERE c.is_personal) AS personal_with_group`,
      [org?.id ?? null],
    );
    counts.groups = g;
    if (g.matching_groups !== g.shared_circles) problems.push(`groups: ${g.shared_circles - g.matching_groups} shared circle(s) without a matching group`);
    if (g.personal_with_group > 0) problems.push(`groups: ${g.personal_with_group} personal circle(s) have a group`);

    // members
    const missing = await db.rows(
      `SELECT m.circle_id, m.user_id, m.role::text AS circle_role, gm.role AS group_role
       FROM circle_members m JOIN circles c ON c.id = m.circle_id AND NOT c.is_personal
       LEFT JOIN group_members gm ON gm.group_id = m.circle_id AND gm.user_id = m.user_id`,
    );
    let promoted = 0;
    let mismatched = 0;
    for (const r of missing) {
      const expected = ROLE_MAP[r.circle_role];
      if (r.group_role === expected) continue;
      if (r.group_role === 'admin') {
        const owner = await db.one(`SELECT owner_id FROM circles WHERE id = $1`, [r.circle_id]);
        if (owner?.owner_id === r.user_id) {
          promoted += 1;
          continue;
        }
      }
      mismatched += 1;
      if (mismatched <= 20) problems.push(`members: circle ${r.circle_id} user ${r.user_id} is ${r.circle_role}, group role ${r.group_role ?? 'MISSING'}`);
    }
    const extra = await db.rows(
      `SELECT gm.group_id, gm.user_id, gm.role, c.owner_id
       FROM group_members gm JOIN circles c ON c.id = gm.group_id
       WHERE NOT EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id = gm.group_id AND m.user_id = gm.user_id)`,
    );
    const extraBad = extra.filter((r) => !(r.role === 'admin' && r.user_id === r.owner_id));
    counts.members = { circleMembers: missing.length, ownersPromotedToAdmin: promoted + extra.length - extraBad.length, mismatched };
    if (mismatched > 20) problems.push(`members: ... ${mismatched - 20} more`);
    for (const r of extraBad.slice(0, 20)) problems.push(`members: group ${r.group_id} has ${r.user_id} (${r.role}) who is not a circle member`);
    const noAdmin = await db.one(
      `SELECT count(*)::int AS n FROM groups g JOIN circles c ON c.id = g.id
       WHERE NOT EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.id AND gm.role = 'admin')`,
    );
    if (noAdmin.n > 0) problems.push(`members: ${noAdmin.n} mirrored group(s) without an admin`);

    // ownership
    counts.tables = {};
    for (const table of CONTENT_TABLES) {
      const viaItem = NO_CIRCLE_FK.has(table)
        ? `LEFT JOIN media_items mi ON mi.id = t.media_item_id LEFT JOIN circles c2 ON c2.id = mi.circle_id`
        : `LEFT JOIN circles c2 ON false`;
      const row = await db.one(
        `WITH x AS (
           SELECT t.org_id, t.owner_group_id, t.owner_user_id, COALESCE(c.id, c2.id) AS cid,
                  COALESCE(c.is_personal, c2.is_personal) AS personal, COALESCE(c.owner_id, c2.owner_id) AS cowner
           FROM ${table} t LEFT JOIN circles c ON c.id = t.circle_id ${viaItem})
         SELECT count(*)::int AS rows,
                count(*) FILTER (WHERE org_id IS NULL)::int AS null_org,
                count(*) FILTER (WHERE org_id IS DISTINCT FROM $1)::int AS other_org,
                count(*) FILTER (WHERE num_nonnulls(owner_user_id, owner_group_id) <> 1)::int AS not_one_owner,
                count(*) FILTER (WHERE owner_group_id IS NOT NULL)::int AS group_owned,
                count(*) FILTER (WHERE owner_user_id IS NOT NULL)::int AS user_owned,
                count(*) FILTER (WHERE NOT (
                  (personal AND owner_user_id = cowner AND owner_group_id IS NULL) OR
                  (NOT personal AND owner_group_id = cid AND owner_user_id IS NULL)))::int AS wrong_owner
         FROM x`,
        [org?.id ?? null],
      );
      counts.tables[table] = row;
      for (const key of ['null_org', 'other_org', 'not_one_owner', 'wrong_owner']) {
        if (row[key] > 0) problems.push(`${table}: ${row[key]} row(s) ${key.replace(/_/g, ' ')}`);
      }
    }

    // schema
    const rls = await db.rows(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname = c.relname || '_org_isolation') AS policy,
              EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = c.oid AND tg.tgname = 'mh_owner_from_circle') AS trigger
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [CONTENT_TABLES],
    );
    for (const table of CONTENT_TABLES) {
      const r = rls.find((x) => x.relname === table);
      if (!r) problems.push(`schema: ${table} missing`);
      else if (!r.relrowsecurity || !r.relforcerowsecurity || !r.policy || !r.trigger) {
        problems.push(`schema: ${table} enabled=${r.relrowsecurity} forced=${r.relforcerowsecurity} policy=${r.policy} trigger=${r.trigger}`);
      }
    }
    const mirrors = await db.rows(
      `SELECT tgname FROM pg_trigger WHERE tgname IN ('mh_circle_mirror_group', 'mh_circle_member_mirror', 'mh_group_mirror_guard')`,
    );
    if (mirrors.length !== 3) problems.push(`schema: ${3 - mirrors.length} mirror trigger(s) missing`);
  } finally {
    await db.close();
  }

  if (json) process.stdout.write(`${JSON.stringify({ counts, problems }, null, 2)}\n`);
  else {
    console.log(`groups: ${JSON.stringify(counts.groups)}`);
    console.log(`members: ${JSON.stringify(counts.members)}`);
    console.log('table                       rows   group-owned  user-owned');
    for (const [table, r] of Object.entries(counts.tables ?? {})) {
      console.log(`${table.padEnd(27)} ${String(r.rows).padStart(7)} ${String(r.group_owned).padStart(12)} ${String(r.user_owned).padStart(11)}`);
    }
    console.log(problems.length === 0 ? 'OK: every check holds' : `FAILED:\n  ${problems.join('\n  ')}`);
  }
  return problems.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`verify failed: ${error.message}`);
    process.exit(2);
  },
);
