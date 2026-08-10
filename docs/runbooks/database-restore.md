# Runbook: PostgreSQL Disaster Recovery — Manual Restore

Issue: [#346](https://github.com/marinoscar/MemoriaHub/issues/346), epic [#339](https://github.com/marinoscar/MemoriaHub/issues/339)
Related: [Database Backup spec](../specs/database-backup.md), [Maintenance Mode runbook](maintenance-mode.md)

**Use this runbook when the application itself is broken, misconfigured, or unreachable.** The in-app restore (issue #344, epic #339) automates the same scratch-database-and-rename procedure documented here, but it requires a running API — which is exactly the thing disaster recovery cannot assume. Everything in this document is plain PostgreSQL: it works whether or not the API or the admin UI is currently reachable on your deployment.

> **Status note:** the in-app restore endpoints (`POST /api/admin/db-backup/runs/:id/restore`, `POST /api/admin/db-backup/runs/:id/rollback`) are issue #344 and have merged — see the [Database Backup spec §5](../specs/database-backup.md#5-restore-and-rollback-344) for the full API contract. The manual procedure in §3 remains equally authoritative: it is the ground truth the in-app path automates, it is code-independent, and it is the only path when the application itself is unreachable — nothing below has been softened or superseded by #344 landing.

## Table of Contents

1. [Obtaining the artifact](#1-obtaining-the-artifact)
2. [Environment gotchas](#2-environment-gotchas-that-will-otherwise-bite-mid-incident)
3. [Recommended procedure: scratch database + rename](#3-recommended-procedure-scratch-database--rename)
4. [Rollback (verbatim commands)](#4-rollback-verbatim-commands)
5. [Alternative: restoring into a fresh empty database](#5-alternative-restoring-into-a-fresh-empty-database-inspection--partial-recovery)
6. [Why not `pg_restore --clean --if-exists` against the live database](#6-why-not-pg_restore---clean---if-exists-against-the-live-database)
7. [Migration-state drift](#7-migration-state-drift)
8. [Deployment prerequisites](#8-deployment-prerequisites)
9. [Verification and bring-up](#9-verification-and-bring-up)
10. [Quick-reference: full incident sequence](#10-quick-reference-full-incident-sequence)

---

## 1. Obtaining the artifact

You need three things before you touch Postgres: the `.dump` file itself, its recorded `checksumSha256`, and proof that `pg_restore` can actually read it.

### 1.1 Via the admin UI (app is reachable)

If the API and admin UI are up, use the download action on the run's row at `/admin/settings/backup` (`GET /api/admin/db-backup/runs/:id/download?expiresIn=<seconds>`, `db_backup:read`). This returns a short-lived signed URL — download it with `curl`:

```bash
curl -sS -o db-backup.dump "<signed-url-from-the-admin-ui>"
```

### 1.2 Directly from the storage provider (app is down)

When the app itself is unreachable, go straight to the storage provider. Backups live under the `db-backups/` prefix, key format `db-backups/<utc-timestamp>-<runId>.dump` (e.g. `db-backups/2026-08-09T02-00-00-000Z-3f1a...dump`), so a raw bucket listing is chronologically sortable even with no database to query.

```bash
# AWS S3 example — list, then fetch the newest
aws s3 ls s3://<your-bucket>/db-backups/ --recursive | sort | tail -20
aws s3 cp s3://<your-bucket>/db-backups/<the-key-you-picked> ./db-backup.dump

# Cloudflare R2 (S3-compatible) — same aws-cli, pointed at the R2 endpoint
aws s3 --endpoint-url https://<account-id>.r2.cloudflarestorage.com \
  ls s3://<your-bucket>/db-backups/ --recursive | sort | tail -20
aws s3 --endpoint-url https://<account-id>.r2.cloudflarestorage.com \
  cp s3://<your-bucket>/db-backups/<the-key-you-picked> ./db-backup.dump

# Local-disk storage provider — the file is just sitting on the API host's disk
# under the configured local-storage root, same key path.
cp /path/to/local-storage-root/db-backups/<the-key-you-picked> ./db-backup.dump
```

If you still have DB access (even read-only, even a replica), the `database_backup_runs` row for the backup you picked has the `checksumSha256` and `storageKey` you need for the next step:

```sql
SELECT id, storage_key, size_bytes, checksum_sha256, db_version, migration_name, verified_at
FROM database_backup_runs
WHERE status = 'completed'
ORDER BY started_at DESC
LIMIT 10;
```

If the database is *also* unreachable (the actual worst case), you have no checksum to check against and must rely on `pg_restore --list` alone (§1.4) plus, if you kept it, an out-of-band record of the checksum (e.g. copied into an incident ticket or a separate secrets store when the backup completed).

### 1.3 Verify the checksum

```bash
sha256sum db-backup.dump
# Compare the output against the checksumSha256 you recorded above.
```

A mismatch means the download was truncated or corrupted in transit — re-download before doing anything else. Do not proceed to a restore attempt on a file whose checksum you have not confirmed.

### 1.4 Verify the archive is readable

Even with a correct checksum, confirm `pg_restore` can actually parse the archive's table of contents before you rely on it for anything:

```bash
pg_restore --list db-backup.dump | head -20
```

A clean listing (table/index/sequence entries, no error) means the archive header and TOC parsed. An error here (`pg_restore: [archiver] input file does not appear to be a valid archive`, or similar) means the file is not usable — go back to §1.1/§1.2 and get a different backup, or a different copy of this one. **Do this check before you start any of the procedures below, not after `pg_restore -d` has been running for twenty minutes.**

---

## 2. Environment gotchas that will otherwise bite mid-incident

Read this section in full before running any restore command. Each item below produces a confusing failure at the worst possible moment if skipped.

### 2.1 pgvector is REQUIRED on the target

The dump contains `CREATE EXTENSION vector` (and, for the `faces` table, a `vector(128)` column plus HNSW indexes; for `media_item_embedding`, `vector(1536)`; for `media_visual_embedding`, `vector(512)`). Restoring into a vanilla `postgres` Docker image or a managed Postgres instance without the pgvector extension **fails outright** on the `CREATE EXTENSION vector` statement, and `pg_restore` will report errors for every downstream object that depends on a `vector` column type.

**Your restore target must be `pgvector/pgvector:pg17` (the same image this repo's Docker Compose uses for its own database) or a managed Postgres offering that has pgvector pre-installed/enabled** (e.g. AWS RDS for PostgreSQL 17 with the `vector` extension allow-listed, Supabase, Neon with the pgvector add-on). Check before you start, not after a partial restore:

```bash
psql "<target-connection-string>" -c "SELECT * FROM pg_available_extensions WHERE name = 'vector';"
```

If that returns zero rows, stop — you have the wrong target image/instance.

### 2.2 Client version must be >= server version

The server is Postgres 17 (`pgvector/pgvector:pg17`). Use `pg_restore` from a **17.x or newer** client toolset. Restoring with an older client against a newer server is unsupported by Postgres and can fail in confusing, partial ways. Check your client version:

```bash
pg_restore --version
# Expect: pg_restore (PostgreSQL) 17.x or newer
```

If you're missing it, install `postgresql-client-17` (Debian/Ubuntu, via the PGDG apt repo — Debian's own archive only ever carries the current default major) or the equivalent for your OS, or run `pg_restore` from inside a `pgvector/pgvector:pg17` container against the target host.

### 2.3 The restore will take far longer than the backup did

`pg_dump` archives store `CREATE INDEX` statements, not index *data* — index data is not part of a logical dump. That means restore time is dominated by **rebuilding HNSW indexes** over however many embedding rows exist (potentially ~1M+ vectors across `media_item_embedding`, `media_visual_embedding`, and `faces.embedding_vec` at this project's projected scale), not by loading the row data itself. Expect the restore to take a multiple of the backup's own duration — plausibly hours on a large library, even though the dump itself took tens of minutes.

**The single biggest lever, and the one an admin is least likely to think of, is `pg_restore -j N`** — parallel restore across `N` worker jobs. `-Fc` (the custom archive format this feature always produces) is the only `pg_dump` output format `pg_restore` can reorder and parallelize, which is exactly why the backup engine always uses it. Do not run `pg_restore` without `-j` on anything but a tiny test database.

A sensible starting point for `-j`:
```bash
# N ≈ number of CPU cores available to the restore process, minus 1-2 for
# headroom (Postgres itself, plus whatever else is running on the host).
# On an 8-core host: -j 6
# On a 4-core host: -j 3
nproc   # see how many cores you actually have
```

See the worked commands in §3 and §5 below for exactly how `-j` fits into the full invocation.

---

## 3. Recommended procedure: scratch database + rename

This is the procedure issue #344's in-app restore automates. It keeps the application up and serving throughout the multi-hour index-rebuild phase — the only interruption is a seconds-long database rename plus a process restart. **Do this manually whenever the app itself is what's broken; do it as the mental model for what #344 does automatically once it is available.**

Placeholders used below: `<suffix>` — any short, unique string (a timestamp or incident ticket number works well, e.g. `20260810-1400`); `<file>` — the path to your verified `.dump` file; `<N>` — your chosen `pg_restore -j` parallelism from §2.3; `<db-host>`, `<db-port>`, `<db-user>` — your Postgres connection details.

### Step 1 — Create the scratch database

```bash
createdb -h <db-host> -p <db-port> -U <db-user> "memoriahub_restore_<suffix>"
```

(Equivalent SQL, if you prefer running it inside `psql` connected to the `postgres` maintenance database: `CREATE DATABASE memoriahub_restore_<suffix>;`)

This runs against a **new, empty database** — the live `memoriahub` database is completely untouched by this step. The application keeps serving normally.

### Step 2 — Restore into the scratch database, in parallel

```bash
pg_restore \
  -h <db-host> -p <db-port> -U <db-user> \
  -d "memoriahub_restore_<suffix>" \
  -j <N> \
  --no-owner --no-acl \
  <file>
```

- `-j <N>` — see §2.3. This is the step that legitimately takes hours on a large library; the app is unaffected while it runs.
- `--no-owner --no-acl` — the dump was produced with these same flags (see the [spec](../specs/database-backup.md)), so ownership and GRANTs are re-established by the restore target's own role rather than baked in from the source — required for a restore onto a different host/role than the one the backup was taken from, and harmless when restoring onto the same host.
- You will be prompted for a password unless you export `PGPASSWORD` first, or use a `~/.pgpass` file:
  ```bash
  export PGPASSWORD='<your-postgres-password>'
  ```

`pg_restore` will print progress as it works through the archive's table of contents. Non-fatal warnings about missing roles (if you're restoring onto a host where the original owner role doesn't exist) are expected and harmless given `--no-owner`.

### Step 3 — Verify the scratch database BEFORE doing anything destructive

Do not proceed to Step 4 until every check below passes.

```bash
psql -h <db-host> -p <db-port> -U <db-user> -d "memoriahub_restore_<suffix>" <<'SQL'
-- 1. pgvector extension present
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';

-- 2. Expected tables exist and have rows (adjust the list/threshold to what
--    you know is roughly right for your deployment size)
SELECT
  (SELECT count(*) FROM users)             AS users,
  (SELECT count(*) FROM media_items)       AS media_items,
  (SELECT count(*) FROM circles)           AS circles,
  (SELECT count(*) FROM database_backup_runs) AS backup_run_rows;

-- 3. Vector indexes actually built (not just declared) — this is the
--    expensive part of the restore, confirm it actually finished
SELECT indexname, tablename
FROM pg_indexes
WHERE indexname IN (
  'faces_embedding_vec_hnsw_idx',
  'media_item_embedding_hnsw_idx',
  'media_visual_embedding_hnsw_idx'
);

-- 4. Latest applied migration — compare this against what you expect for
--    the backup you chose (see §7 below on migration-state drift)
SELECT migration_name, finished_at
FROM _prisma_migrations
WHERE finished_at IS NOT NULL
ORDER BY finished_at DESC
LIMIT 1;
SQL
```

If any check fails — the extension is missing, a core table is empty when it shouldn't be, an expected index is absent, or `pg_restore` reported unresolved errors during Step 2 — **stop here**. Drop the scratch database (`dropdb "memoriahub_restore_<suffix>"`) and go back to §1 with a different backup or investigate the failure. Nothing about the live `memoriahub` database has been touched yet, so there is no cleanup needed on the production side.

### Step 4 — THE ONLY DESTRUCTIVE MOMENT: stop the API, terminate connections, rename

Everything before this line was non-destructive and reversible by simply dropping the scratch database. **This step is the one moment that changes what `memoriahub` — the live, in-use database name — points at.** Read the whole step before running any command in it.

**4a. Stop the API** (all replicas — see §8's single-replica note). With Docker Compose:
```bash
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml stop api
```
Or however your deployment stops the API process without stopping Postgres itself.

**4b. Terminate any remaining connections to the live database.** Even with the API stopped, a lingering connection pool, a leftover psql session, or a background cron process can hold connections that block the rename (Postgres cannot rename a database that has active connections). Connect to the `postgres` maintenance database (never to `memoriahub` itself for this step) and force-close everything:

```sql
-- Connect to the `postgres` database, NOT memoriahub, for this and the
-- rename statements below — you cannot rename a database you're connected to.
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'memoriahub' AND pid <> pg_backend_pid();
```

**4c. Rename.** Still connected to `postgres`:

```sql
ALTER DATABASE memoriahub RENAME TO memoriahub_old_<suffix>;
ALTER DATABASE "memoriahub_restore_<suffix>" RENAME TO memoriahub;
```

This pair of statements is fast (seconds) — it's a catalog metadata change, not a data copy. The instant the second statement commits, every new connection to `memoriahub` gets the restored data. `memoriahub_old_<suffix>` now holds everything the live database had immediately before this step — **this is your rollback, see §4 below.**

**4d. Start the API** back up:
```bash
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml up -d api
```

The API's connection pool reconnects fresh to `memoriahub` — which now serves the restored data. Continue to §9 for verification and bring-up checks.

---

## 4. Rollback (verbatim commands)

**Do not drop `memoriahub_old_<suffix>` until the restore has been validated in anger** — that is, until real traffic has hit the app for a meaningful window (hours, not minutes) with no data-integrity surprises. The rollback below only works while that database still exists.

If the restore turns out to be wrong — bad backup chosen, unexpected data loss, application errors traced to missing/incorrect data — reverse the Step 4 rename exactly:

```bash
# 1. Stop the API again
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml stop api

# 2. Connected to the `postgres` maintenance database, terminate connections
#    to the (now-live, restored) `memoriahub` and swap the names back:
psql -h <db-host> -p <db-port> -U <db-user> -d postgres <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'memoriahub' AND pid <> pg_backend_pid();

ALTER DATABASE memoriahub RENAME TO memoriahub_failed_restore_<suffix>;
ALTER DATABASE memoriahub_old_<suffix> RENAME TO memoriahub;
SQL

# 3. Start the API back up — it now reconnects to the ORIGINAL data, exactly
#    as it was before you ever started this incident.
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml up -d api
```

This reverses the entire operation in seconds, the same way the forward swap did. The failed restore attempt is preserved under `memoriahub_failed_restore_<suffix>` for later investigation (why did it fail?) rather than being immediately destroyed — drop it manually once you've extracted whatever you need from it:
```bash
dropdb -h <db-host> -p <db-port> -U <db-user> "memoriahub_failed_restore_<suffix>"
```

The in-app restore exposes this same rollback as a single API call (`POST /api/admin/db-backup/runs/:id/rollback`, `db_backup:restore`), doing programmatically exactly what the commands above do by hand, gated by the configured `databaseBackup.restoreRollbackMode` (see the [spec §5.7](../specs/database-backup.md#57-post-runsidrollback--the-two-rollback-modes) for the two modes and their tradeoff). That endpoint requires a reachable API, which is precisely what this runbook exists for the case where you don't have — so the commands above remain the procedure to use whenever the app itself is what's broken. Copy them into your incident notes before you ever run Step 4 of §3, so they're ready to paste the moment you need them.

---

## 5. Alternative: restoring into a fresh empty database (inspection / partial recovery)

Sometimes you don't want to swap anything into production — you just want to look at what's in a backup (confirm a specific record existed, extract one table's worth of data, compare two backups) without touching the live app at all. Use a permanently-named scratch database instead of the swap-and-rename dance:

```bash
createdb -h <db-host> -p <db-port> -U <db-user> memoriahub_inspect

pg_restore \
  -h <db-host> -p <db-port> -U <db-user> \
  -d memoriahub_inspect \
  -j <N> \
  --no-owner --no-acl \
  <file>

# Now query/export whatever you need, e.g.:
psql -h <db-host> -p <db-port> -U <db-user> -d memoriahub_inspect \
  -c "SELECT * FROM media_items WHERE id = '<some-uuid>';"
```

Drop it when you're done: `dropdb -h <db-host> -p <db-port> -U <db-user> memoriahub_inspect`. This database is never renamed into place and the live app never sees it — there is no destructive moment here at all, which is why this is the right choice whenever you don't specifically need the swap-in.

---

## 6. Why not `pg_restore --clean --if-exists` against the live database

It is tempting to skip the scratch-database dance and just restore straight over the live `memoriahub` database with `pg_restore --clean --if-exists -d memoriahub <file>` — `--clean` drops each object before recreating it, `--if-exists` suppresses errors for objects that don't exist yet. **Do not do this.** Two separate problems make it self-contradicting:

1. **It destroys the tool needed to recover from its own failure.** `--clean` drops *every object in the archive*, including `database_backup_runs` itself — so the moment the restore starts, the row-based history and catalog of your own backups is gone, replaced (if the restore succeeds) by the catalog as it existed at backup time. You cannot record this restore's own outcome inside the database being restored, because that table stopped existing partway through the operation. If the restore fails midway — a permissions issue, a disk-full condition, an interrupted connection — you're left with a partially-dropped, partially-recreated live database, **no working application** (tables the app depends on may not exist yet), **no admin UI** (the API can't start against a half-restored schema), and **no backup catalog** to even see what backups exist to try again.
2. **The destructive window is hours wide, not seconds.** Unlike the scratch-and-rename approach, where the only destructive step is a fast metadata rename, an in-place `--clean` restore holds the live database in a broken, half-dropped state for the entire multi-hour duration of the restore (see §2.3) — the app cannot boot for the whole window, not just for a rename's worth of seconds.

The scratch-database-and-rename procedure in §3 exists specifically to avoid both failure modes: the destructive step shrinks from "the whole restore duration" to "one rename," and the previous live database survives untouched (as `memoriahub_old_<suffix>`) as both a rollback path and, not incidentally, a working `database_backup_runs` table you can still query if something goes wrong.

---

## 7. Migration-state drift

The dump contains the `_prisma_migrations` table — Prisma's own record of which migrations have been applied. **Restoring a backup rewinds migration state along with the data.** If you restore a backup taken before some migrations were applied, the resulting database's `_prisma_migrations` table reflects that older state — but the application code you're about to run against it may be the *current* code, which expects the newer schema.

Running current application code against an older schema produces confusing, often silent-until-it-isn't failures: missing columns the code assumes exist, missing tables, enum values the code expects that the restored schema doesn't have. **Do not skip this step.**

**The correct sequence, always, when restoring anything other than the most recent backup:**

1. Complete the restore (§3 or §5).
2. Before starting the API against the restored database (or immediately after, before real traffic hits it), run:
   ```bash
   cd apps/api && npx prisma migrate deploy
   ```
   (Point `DATABASE_URL`/the individual `POSTGRES_*` env vars at the restored database — the same connection details you used for the restore itself.) This applies every migration that exists in your current codebase but not yet in the restored database's `_prisma_migrations` table, rolling the schema **forward** to match the code you're about to run.
3. Only then start (or resume traffic to) the API.

**Note on backup-catalog continuity:** the scratch-and-rename procedure in §3 swaps in the *entire* restored database, `database_backup_runs` included — so after a hand-run restore, your backup history table only contains rows up to the moment the restored backup was taken. Any backups that ran *after* that timestamp (and before the incident) are gone from the catalog, even though their files may still exist in storage under `db-backups/` (worth checking manually if you need them — see §1.2). This is a genuine information loss specific to the manual path: the in-app restore carries the backup catalog across the swap for exactly this reason (`DatabaseRestoreService.exportCatalog`/`reinsertCatalog` — see the [spec §5.8](../specs/database-backup.md#58-two-things-the-swap-introduces-both-handled)), which the manual procedure here cannot replicate — there is no code running server-side to do that bookkeeping when you're driving `pg_restore` and `psql` by hand.

---

## 8. Deployment prerequisites

Two structural assumptions this whole recovery model depends on — verify them before you need them, not during an incident.

### 8.1 `restart: unless-stopped` (or equivalent)

The in-app restore finishes its cutover by having the API process **exit itself** (`process.exit(0)`) and relying on the container orchestrator to restart it against the renamed database — the same reason the manual procedure's Step 4d above explicitly restarts the API rather than expecting it to notice the swap on its own. If the deployment does not restart a stopped/exited container automatically, the restore leaves the app down even though the database-side swap succeeded correctly.

This repository's `infra/compose/prod.compose.yml` already sets `restart: unless-stopped` on the `api`, `web`, and `nginx` services — confirmed current as of this writing. If you're running a different deployment topology (bare `docker run`, a different Compose override, a non-Compose orchestrator), verify the equivalent restart policy is in place:
```bash
grep -n "restart:" infra/compose/prod.compose.yml
```
For Kubernetes, this is the default Pod `restartPolicy: Always` behavior via the owning Deployment — verify your API Deployment doesn't override it to something narrower.

### 8.2 Single-API-replica constraint

The scratch-database-and-rename cutover — whether driven by hand (§3) or automated by the in-app restore (issue #344) — assumes a **single API replica**. The rename only meaningfully quiesces traffic if there is exactly one process holding connections to `memoriahub` at the moment of Step 4; a second replica that isn't also stopped would keep serving (and writing!) against whichever database name it currently has connections open to, defeating the whole point of the swap and risking split-brain writes across the old and new databases. If your deployment runs more than one API replica, **stop all of them** in Step 4a, not just one, and bring all of them back up in Step 4d. The in-app restore's pre-flight only WARNS about multiple replicas (`replicas.single`, a heuristic over distinct `pg_stat_activity` client addresses — see the [spec §5.3](../specs/database-backup.md#53-pre-flight-gates-precisely)); it does not and cannot stop other replicas for you. This is a documented v1 limitation of the restore design (see epic #339's out-of-scope list), not something either the manual procedure or the in-app path currently handles for you automatically across replicas.

---

## 9. Verification and bring-up

After Step 4d (or after the in-app restore's automated equivalent — `POST /api/admin/db-backup/runs/:id/restore` completing with `restoreStatus='completed'`), confirm the swap actually took:

```bash
# Sanity check row counts against what you verified in Step 3 — should match
# exactly, since nothing has been written to the (renamed) database since
# the restore completed.
psql -h <db-host> -p <db-port> -U <db-user> -d memoriahub <<'SQL'
SELECT
  (SELECT count(*) FROM users)       AS users,
  (SELECT count(*) FROM media_items) AS media_items,
  (SELECT count(*) FROM circles)     AS circles;

-- Confirm the vector indexes exist on the now-live database
SELECT indexname, tablename
FROM pg_indexes
WHERE indexname IN (
  'faces_embedding_vec_hnsw_idx',
  'media_item_embedding_hnsw_idx',
  'media_visual_embedding_hnsw_idx'
);
SQL

# Confirm the API is actually serving from the restored data
curl -sS https://<your-domain>/api/health/ready
```

Once the API is back up (after `prisma migrate deploy` if you restored an older backup — §7), give it a moment to reconnect its Prisma connection pool cleanly (a fresh process start already does this; if you did not restart the process for some reason, restart it now — an existing pool's connections were opened against the pre-rename database name and Postgres does not silently redirect them). Watch the API logs for successful startup and no database-connection errors:

```bash
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml logs -f --tail=100 api
```

Then exercise the app as a real user would — load the gallery, open a media item, run a search — before declaring the incident resolved. Keep `memoriahub_old_<suffix>` around per §4 until you're confident.

---

## 10. Quick-reference: full incident sequence

For an admin who has already read this document once and just needs the command sequence during an active incident:

```bash
# 0. Get and verify the artifact (§1)
sha256sum db-backup.dump   # compare to recorded checksumSha256
pg_restore --list db-backup.dump | head -20   # must succeed cleanly

# 1. Scratch database (§3 Step 1)
createdb -h <db-host> -p <db-port> -U <db-user> "memoriahub_restore_<suffix>"

# 2. Parallel restore (§3 Step 2) — the long step, hours on a large library
export PGPASSWORD='<your-postgres-password>'
pg_restore -h <db-host> -p <db-port> -U <db-user> \
  -d "memoriahub_restore_<suffix>" -j <N> --no-owner --no-acl db-backup.dump

# 3. Verify BEFORE touching the live database (§3 Step 3) — extension, tables,
#    row counts, indexes, migration name. Do not proceed on any failure.

# 4. THE DESTRUCTIVE MOMENT (§3 Step 4)
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml stop api
psql -h <db-host> -p <db-port> -U <db-user> -d postgres <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname = 'memoriahub' AND pid <> pg_backend_pid();
ALTER DATABASE memoriahub RENAME TO memoriahub_old_<suffix>;
ALTER DATABASE "memoriahub_restore_<suffix>" RENAME TO memoriahub;
SQL
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml up -d api

# 5. If restoring an older backup, roll the schema forward (§7)
cd apps/api && npx prisma migrate deploy

# 6. Verify (§9), then watch the app for a while before dropping
#    memoriahub_old_<suffix>.

# ROLLBACK, if needed (§4) — keep this pasted somewhere reachable during the
# incident, not just linked:
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml stop api
psql -h <db-host> -p <db-port> -U <db-user> -d postgres <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname = 'memoriahub' AND pid <> pg_backend_pid();
ALTER DATABASE memoriahub RENAME TO memoriahub_failed_restore_<suffix>;
ALTER DATABASE memoriahub_old_<suffix> RENAME TO memoriahub;
SQL
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml up -d api
```

---

## Verification status

**This procedure has NOT been executed end-to-end against a scratch database as of this writing** — the environment this runbook was authored in has no Docker and no PostgreSQL available to run it against. The commands above are written directly from the actual `pg_dump`/`pg_restore` invocations the backup engine uses (`apps/api/src/db-backup/pg-dump.util.ts` — see the [spec](../specs/database-backup.md) for the exact flags), standard documented PostgreSQL database-rename semantics, and this repository's actual `infra/compose/prod.compose.yml` restart policy — but they have not been run in anger. Before relying on this runbook for a real incident, run the full sequence in §10 at least once against a disposable/scratch environment and correct anything that doesn't work exactly as written.
