# Runbook: The Application Database Role (`memoriahub_app`)

RETRO-A5 (issue #587). Creates and documents the ordinary Postgres role the API should eventually run as. **The API does not switch to it yet** (open decision 1 of the issue): it keeps connecting as the bootstrap superuser until RETRO-D1.

## Why

Platform migration `0025` forces row-level security on `storage_objects`, `storage_object_chunks`, `ai_runs` and `ai_usage_events` (policies on `org_id`). RLS is inert for a superuser or a `BYPASSRLS` role. Tenant isolation is only real when the API connects as a `NOSUPERUSER NOBYPASSRLS` role that owns the tables (`FORCE ROW LEVEL SECURITY` applies the policies to the owner). Doctor `db.rls_role` reports this; it fails while the API is a superuser (a row in [local-exceptions.md](../platform-adoption/local-exceptions.md)).

## The script

`infra/compose/postgres-init/10-app-role.sh` (idempotent; also valid as `/docker-entrypoint-initdb.d/10-app-role.sh` on an empty volume):

- as the bootstrap superuser, creates the extensions `uuid-ossp`, `vector`, `pg_trgm` (a non-superuser cannot create an untrusted extension);
- creates or updates `memoriahub_app` (`LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`; override the name with `APP_DB_USER`);
- makes it owner of the database, schema `public`, and every table, view, sequence, enum type and function in `public` (a per-object loop: `REASSIGN OWNED BY postgres` is refused because the role owns pinned system objects).

```bash
APP_DB_PASSWORD=... POSTGRES_DB=memoriahub PGHOST=... PGUSER=postgres sh infra/compose/postgres-init/10-app-role.sh
```

Run it on a **copy** first. Running it twice changes nothing.

## What was measured (synthetic rehearsal, 2026-11-08)

On a copy of the rehearsal database migrated to `0040`, after the script:

| Check | Result |
|---|---|
| Role flags | `rolsuper=f`, `rolbypassrls=f`, `rolcreatedb=f` |
| Tables / enums not owned by the role | 0 / 0 |
| Second run | no error, no change |
| `SELECT count(*) FROM storage_objects` as the role, no `app.org_id` | **0** (the table holds 2 rows) |
| `SELECT count(*) FROM users` as the role | 2 (`users` has no RLS) |
| Same count inside a transaction with `set_config('app.org_id', <org>, true)` | 2 |
| `INSERT INTO storage_objects` without `app.org_id` | rejected by the RLS policy |

So the legacy storage service (which reads `storage_objects` with no `app.org_id`) would see an empty library: it cannot run as this role until RETRO-D1 moves storage onto `forOrg` / `runInOrg`. The unit suite is fully mocked and does not exercise this; the real-database specs set no `app.org_id` either, so they also need the superuser until D1. The API process itself was not started as the role.

## When to switch

After RETRO-D1. Then: run the script on the production database in a maintenance window, set `POSTGRES_USER` / `POSTGRES_PASSWORD` for the API to the role (keep a bootstrap login for migrations that create extensions and for the restore flow, which needs `CREATEDB`), restart, run the Doctor. Rollback: point `POSTGRES_USER` back at the bootstrap login; ownership transfer is harmless to a superuser.
