/**
 * Real-Postgres tier (RETRO-I5, #583). Proves pending circle invites survive the move to platform
 * group invites, and that an invitee who signs up AFTER the deploy still lands in the circle:
 *
 *   - on a scratch database migrated to the step BEFORE `20261109200000_i5_circle_invites_to_group_invites`
 *     (circles and members from the RETRO-I2 fixture), six `circle_invites` rows: a new address
 *     (collaborator), an address that already is a collaborator (invited as viewer), an existing
 *     viewer invited as circle_admin, an invite of a PERSONAL circle, a CLAIMED invite, and an
 *     upper-cased new address;
 *   - the migration imports exactly the three that can still change something as PENDING group
 *     invites (same id, mapped role, `invited_by_id`, `created_at`, no expiry), skips the member,
 *     the personal circle and the claimed one, drops `circle_invites`, and replays cleanly;
 *   - the imported invites appear in the invitee's `GET /api/groups/invites/mine`
 *     (`GroupInvitesService.mine`);
 *   - a NEW user signing up with an invited address (the slice's `InviteAutoAcceptListener` on
 *     `identity.user.created`, `groups.autoAcceptInvitesOnSignup`) is a group member immediately,
 *     with the mapped role (the circle tables are gone since RETRO-K2: no mirror to a circle_members row);
 *   - an existing member's next sign-in (`identity.login.succeeded`, `autoAcceptInvitesOnSignIn`)
 *     UPGRADES a lower role and never downgrades a higher one.
 *
 * The slice's services are built over a plain PrismaClient through the platform's `runInOrg` /
 * `runAsSystem` (the app's `SharingDataAdapter` does the same over PrismaService). Skips (reported
 * as skipped, never passed) when nothing listens on the port.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { runAsSystem, runInOrg, type UserPrincipal } from '@marinoscar/platform-api/core';
import {
  GroupInvitesService,
  GroupMembershipService,
  InviteAutoAcceptListener,
  MemberLookupThrottle,
  SharingEffects,
  resolveSharingModuleOptions,
  type SharingDataPort,
} from '@marinoscar/platform-api/sharing';
import { Client } from 'pg';

import { SHARING_MODULE_OPTIONS } from '../../src/platform/sharing/sharing.config';
import { SINGLE_TENANCY } from '../../src/platform/sharing/sharing-host.module';
import { isDatabaseReachable } from '../helpers/db-probe.helper';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const I2 = '20261108200000_i2_circles_to_groups_ownership';
const I5 = '20261109200000_i5_circle_invites_to_group_invites';
const SEED = join(__dirname, 'fixtures', 'circle-content.seed.sql');

type Row = Record<string, any>;

function connection(database: string) {
  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database,
  };
}

function url(database: string): string {
  const c = connection(database);
  return `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${database}`;
}

/** Applies one migration file the way `prisma migrate deploy` would (see ownership.db.spec.ts). */
async function applyMigration(client: Client, sql: string): Promise<void> {
  if (sql.includes('$$') || /^\s*BEGIN\s*;/im.test(sql)) {
    await client.query(sql);
    return;
  }
  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) await client.query(statement);
}

describeMaybeDb('RETRO-I5 circle invites to group invites, auto-claimed at sign-in (DB_GATED: real PostgreSQL)', () => {
  const database = `i5_invites_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Client;
  let db: Client;
  let prisma: PrismaClient;
  let invites: GroupInvitesService;
  let autoAccept: InviteAutoAcceptListener;
  const events: Array<{ name: string; payload: any }> = [];

  let orgId: string;
  let alpha: Row;
  let beta: Row;
  let userA: Row;
  let userB: Row;
  let userC: Row;
  const newAddress = `person-e-${randomUUID().slice(0, 8)}@example.test`;
  const upperAddress = `Person-F-${randomUUID().slice(0, 8)}@Example.TEST`;
  const ids: Record<string, string> = {};

  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
  const principal = (userId: string, email: string): UserPrincipal => ({
    kind: 'user',
    userId,
    email,
    credential: 'session',
    roles: [],
    permissions: [],
    activeOrgId: orgId,
  });
  const memberRole = async (groupId: string, userId: string): Promise<string | null> =>
    (await q(`SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, userId]))[0]?.role ?? null;

  beforeAll(async () => {
    admin = new Client(connection(process.env.POSTGRES_DB || 'appdb'));
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    db = new Client(connection(database));
    await db.connect();

    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const dir of dirs) {
      if (dir === I5) break;
      if (dir === I2) {
        await q(readFileSync(SEED, 'utf8'));
        await q(`SELECT mh_i2_seed(1, false)`);
      }
      await applyMigration(db, readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
    }

    orgId = (await one(`SELECT id FROM organizations WHERE is_default`)).id;
    alpha = await one(`SELECT id, owner_id FROM circles WHERE name = 'Circle Alpha'`);
    beta = await one(`SELECT id, owner_id FROM circles WHERE name = 'Circle Beta'`);
    const memberOfAlpha = async (role: string) =>
      one(`SELECT u.id, u.email FROM circle_members m JOIN users u ON u.id = m.user_id WHERE m.circle_id = $1 AND m.role = $2`, [alpha.id, role]);
    userA = await memberOfAlpha('circle_admin');
    userB = await memberOfAlpha('collaborator');
    userC = await memberOfAlpha('viewer');
    const personalOfA = await one(`SELECT id FROM circles WHERE owner_id = $1 AND is_personal`, [userA.id]);

    const invite = async (key: string, circleId: string, email: string, role: string, claimed = false) => {
      ids[key] = randomUUID();
      await q(
        `INSERT INTO circle_invites (id, circle_id, email, role, added_by_id, added_at, claimed_by_id, claimed_at)
         VALUES ($1, $2, $3, $4::"CircleRole", $5, now() - interval '40 days', $6, $7)`,
        [ids[key], circleId, email, role, userA.id, claimed ? userB.id : null, claimed ? new Date() : null],
      );
    };
    await invite('newcomer', alpha.id, newAddress, 'collaborator');
    await invite('alreadyMember', alpha.id, userB.email, 'viewer');
    await invite('upgrade', alpha.id, userC.email, 'circle_admin');
    await invite('personal', personalOfA.id, `person-g-${randomUUID().slice(0, 8)}@example.test`, 'viewer');
    await invite('claimed', beta.id, userB.email, 'viewer', true);
    await invite('upper', beta.id, upperAddress, 'viewer');

    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url(database), max: 2 }) });
    const data: SharingDataPort = {
      runInOrg: (scope, fn) => runInOrg(prisma as never, scope, fn as never) as never,
      runAsSystem: (reason, fn) => runAsSystem(prisma as never, reason, fn as never) as never,
    };
    const options = resolveSharingModuleOptions(SHARING_MODULE_OPTIONS);
    const effects = new SharingEffects(
      { invalidateUsers: () => undefined } as never,
      { emit: (name: string, payload: unknown) => void events.push({ name, payload }) } as never,
    );
    const membership = new GroupMembershipService(data, options, new MemberLookupThrottle(), effects);
    invites = new GroupInvitesService(data, options, membership, effects, SINGLE_TENANCY);
    autoAccept = new InviteAutoAcceptListener(invites, options);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('imports the pending invites that can still change something, drops circle_invites, and replays cleanly', async () => {
    const sql = readFileSync(join(MIGRATIONS, I5, 'migration.sql'), 'utf8');
    await db.query(sql);

    const rows = await q(`SELECT * FROM group_invites ORDER BY email`);
    expect(rows.map((r) => r.id).sort()).toEqual([ids.newcomer, ids.upgrade, ids.upper].sort());
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[ids.newcomer]).toMatchObject({ group_id: alpha.id, org_id: orgId, email: newAddress, role: 'editor', invited_by_id: userA.id, expires_at: null, accepted_at: null, revoked_at: null });
    expect(byId[ids.upgrade]).toMatchObject({ group_id: alpha.id, email: userC.email.toLowerCase(), role: 'admin' });
    expect(byId[ids.upper]).toMatchObject({ group_id: beta.id, email: upperAddress.toLowerCase(), role: 'viewer' });
    // created_at is the circle invite's added_at.
    expect(Date.now() - new Date(byId[ids.newcomer].created_at).getTime()).toBeGreaterThan(39 * 86_400_000);
    expect((await one(`SELECT to_regclass('public.circle_invites') IS NULL AS gone`)).gone).toBe(true);

    await db.query(sql);
    expect((await one(`SELECT count(*)::int AS n FROM group_invites`)).n).toBe(3);
  });

  it('the invitee sees the imported invite in their pending list', async () => {
    const userId = randomUUID();
    await q(`INSERT INTO users (id, email, updated_at) VALUES ($1, $2, now())`, [userId, upperAddress.toLowerCase()]);

    const mine = await invites.mine(principal(userId, upperAddress.toLowerCase()));

    expect(mine.items.map((i: any) => i.id)).toEqual([ids.upper]);
  });

  it('a new user signing up with an invited address is a member at once, with the mapped role', async () => {
    const userId = randomUUID();
    await q(`INSERT INTO users (id, email, updated_at) VALUES ($1, $2, now())`, [userId, newAddress]);

    await autoAccept.onUserCreated({ userId, email: newAddress, source: 'google', orgId: null } as never);

    expect(await memberRole(alpha.id, userId)).toBe('editor');
    expect((await one(`SELECT accepted_by_id, accepted_at FROM group_invites WHERE id = $1`, [ids.newcomer]))).toMatchObject({
      accepted_by_id: userId,
    });
    expect(events.map((e) => e.name)).toEqual(
      expect.arrayContaining(['sharing.group.member_added', 'sharing.group.invite_auto_accepted']),
    );

  });

  it('an existing member\'s next sign-in upgrades a lower role', async () => {
    expect(await memberRole(alpha.id, userC.id)).toBe('viewer');

    await autoAccept.onLoginSucceeded({ userId: userC.id, provider: 'google', isNewUser: false } as never);

    expect(await memberRole(alpha.id, userC.id)).toBe('admin');
  });

  it('never downgrades: an editor invited as viewer stays editor', async () => {
    expect(await memberRole(alpha.id, userB.id)).toBe('editor');
    await runAsSystem(prisma as never, 'invite-claim', async (tx: any) =>
      tx.$executeRawUnsafe(
        `INSERT INTO group_invites (id, group_id, org_id, email, role, invited_by_id) VALUES ($1, $2, $3, $4, 'viewer', $5)`,
        randomUUID(),
        alpha.id,
        orgId,
        userB.email.toLowerCase(),
        userA.id,
      ),
    );

    await autoAccept.onLoginSucceeded({ userId: userB.id, provider: 'google', isNewUser: false } as never);

    expect(await memberRole(alpha.id, userB.id)).toBe('editor');
  });
});
