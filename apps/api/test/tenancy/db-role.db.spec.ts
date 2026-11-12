/**
 * Real-Postgres tier (RETRO-I3, #573): the DB tier runs as an ORDINARY role.
 *
 * Row-level security is inert for a superuser and for a role with BYPASSRLS, so a suite run as one proves
 * nothing about tenant isolation. The CI job `api-db-test` connects as `memoriahub_app` (NOSUPERUSER
 * NOBYPASSRLS, owner of the tables) and sets `REQUIRE_ORDINARY_DB_ROLE=1`; with it, this spec fails the job
 * if the connected role is a superuser or holds BYPASSRLS, and if a forced-RLS table does not hide its rows
 * from a connection with no organization scope. Without the variable (a developer's local superuser) the
 * spec only reports the role and skips the assertions.
 */
import { Client } from 'pg';

import { isDatabaseReachable } from '../helpers/db-probe.helper';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;
const enforce = process.env.REQUIRE_ORDINARY_DB_ROLE === '1';
const itEnforced = enforce ? it : it.skip;

describeMaybeDb('the DB tier connects as an ordinary role (DB_GATED: real PostgreSQL)', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      user: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
      database: process.env.POSTGRES_DB || 'appdb',
    });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  itEnforced('is neither a superuser nor BYPASSRLS', async () => {
    const { rows } = await client.query(
      `SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  itEnforced('owns the tables, so FORCE ROW LEVEL SECURITY applies to it', async () => {
    const { rows } = await client.query(
      `SELECT c.relname, c.relforcerowsecurity, pg_get_userbyid(c.relowner) = current_user AS owned
         FROM pg_class c WHERE c.relname IN ('media_items', 'groups', 'storage_objects') AND c.relkind = 'r'`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toMatchObject({ relforcerowsecurity: true, owned: true });
  });

  itEnforced('a forced-RLS row is invisible without an organization scope and visible under the explicit bypass', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.rls_bypass', 'on', true)`);
      const org = (await client.query(`SELECT id::text AS id FROM organizations WHERE is_default`)).rows[0].id as string;
      await client.query(
        `INSERT INTO groups (id, org_id, name, version, created_at, updated_at) VALUES (gen_random_uuid(), $1::uuid, 'db-role probe', 1, now(), now())`,
        [org],
      );
      expect((await client.query(`SELECT count(*)::int AS n FROM groups WHERE name = 'db-role probe'`)).rows[0].n).toBe(1);

      // Still inside the transaction: drop the bypass and the row is gone, as it is for the API.
      await client.query(`SELECT set_config('app.rls_bypass', 'off', true)`);
      expect((await client.query(`SELECT count(*)::int AS n FROM groups WHERE name = 'db-role probe'`)).rows[0].n).toBe(0);

      // And the organization scope alone shows it.
      await client.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
      expect((await client.query(`SELECT count(*)::int AS n FROM groups WHERE name = 'db-role probe'`)).rows[0].n).toBe(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
