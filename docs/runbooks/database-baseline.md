# Runbook: Baseline the MemoriaHub Database onto the Platform Migration History

RETRO-A5 (issue [#587](https://github.com/marinoscar/MemoriaHub/issues/587), epic #564, program #555). Run **once per database**, as a deliberate operator action in a maintenance window, by RETRO-A6. This page is MemoriaHub's version of the platform runbook (EnterpriseAppBase `docs/runbooks/database-baseline.md`, tool `platform db baseline` of `@marinoscar/platform-db`). Read that page for the tool in general; this one records what MemoriaHub's transform does and how it was rehearsed.

> **Status.** The procedure below was rehearsed end to end on a **SYNTHETIC** database (section 9). The mandatory rehearsal on a **restored production backup has not been done**: see "Production-backup rehearsal: NOT YET DONE (required before RETRO-A6)" in section 10. Do not run RETRO-A6 until that section is filled in.

## 1. What the transform does

MemoriaHub has **81** migrations of its own (plus one added here). Only two are byte-identical to platform migrations: `20260124223146_initial` = `0001_initial` and `20260329151231_add_personal_access_tokens` = `0002_add_personal_access_tokens`. So the database equals the platform history **through 2**. Platform `0003` to `0040` (38 migrations) are installed after MemoriaHub's directories and applied by `prisma:migrate`.

Several platform migrations would fail with "already exists" because MemoriaHub built the same tables first. The transform therefore:

1. **Renames the colliding legacy objects** in one ordinary migration, `20260817000000_rename_legacy_platform_tables` (63 statements, one transaction, metadata only, no row is rewritten):
   - 9 tables: `notifications`, `push_subscriptions`, `notification_deliveries`, `notification_broadcasts`, `job_stats_rollup`, `worker_nodes`, `node_credentials`, `database_backup_runs`, `android_app_releases`, each to `mh_legacy_<name>`;
   - 7 enum types: `JobStatus`, `JobReason`, `NodeStatus`, `DatabaseBackupStatus`, `DatabaseBackupTrigger`, `NotificationBroadcastStatus`, `NotificationDeliveryStatus`, each to `MhLegacy<Name>`;
   - every index and constraint on those tables (22 constraints, 25 standalone indexes), prefixed `mh_legacy_`. The list was generated from `pg_constraint` / `pg_index` of the migrated database, not written by hand.

   `enrichment_jobs` was **not** renamed by this migration: the platform's table is called `jobs`, nothing collides (RETRO-C1 later moved its rows into `jobs` and renamed it `enrichment_jobs_legacy`, section 13). `NotificationType` is not renamed: the platform's `notifications.type` is text.
2. **Keeps the app working** with `@@map("mh_legacy_<table>")` and enum `@@map("MhLegacy<Name>")` in the `apps/api/prisma/fragments/platform-*.legacy.prisma` fragments. Prisma's default index and constraint names derive from the mapped table name, so they equal the renamed ones: no drift. Model names are unchanged, so app code compiles.
3. **Baselines `--through 2`** (section 5): installs `0003` to `0040` as byte copies, writes `platform.lock`.
4. **`prisma:migrate`** applies those 38 onto an empty namespace. Platform tables now exist **empty** beside the legacy tables.
5. **Data moves later, per slice**, each its own issue: C1 (`enrichment_jobs` + `mh_legacy_job_stats_rollup`), C2 (`mh_legacy_worker_nodes`, `mh_legacy_node_credentials`), D3 (notifications, push, deliveries, broadcasts), D4 (`mh_legacy_database_backup_runs`), D5 (`mh_legacy_android_app_releases`), B2 (avatar columns off `users`). Each drops its legacy table and removes its deviation statements.
6. **Interim mirror.** Platform `0025` made `storage_objects.org_id` and `storage_object_chunks.org_id` NOT NULL (with forced row-level security). The legacy fragment gains `orgId` on both models and a `DefaultOrgId` provider (`apps/api/src/common/tenancy/default-org-id.ts`, reads `organizations WHERE is_default` once) stamps every create/upsert. Marked `PLATFORM-ADOPTION-SHIM(RETRO-D1)`. Those two were the only NOT NULL columns without a default that the app writes (`prisma migrate diff` after step 4 lists `org_id` on `audit_events`, `device_codes`, `personal_access_tokens`, `refresh_tokens` as nullable, `roles.scope`, `permissions.scope`, `users.metadata` with defaults).

Rename vs `--map`: `--map` cannot express these (the SQL differs by far more than comments), so the rename is the only route.

### Things that changed in application code

Raw SQL that names a renamed object was updated in the same change: `NotificationsService` and `ShareExpiringService` (`mh_legacy_notifications`), `DatabaseRestoreService` (`mh_legacy_database_backup_runs`, `"MhLegacyDatabaseBackupStatus"`, `"MhLegacyDatabaseBackupTrigger"`, the required-tables list), and `ONE_CURRENT_RELEASE_INDEX` (`mh_legacy_android_app_releases_one_current_uniq_idx`, used to recognise the P2002 of the one-current-release index). OTEL database spans show the new `mh_legacy_*` table names.

Known limitation: restoring an archive taken **before** this change (it holds `database_backup_runs`, not `mh_legacy_database_backup_runs`) fails the restore verification's required-tables check and the catalog carry-over. Restore such an archive with the manual procedure ([database-restore.md](database-restore.md)) and run `prisma:migrate` afterwards. New backups are unaffected.

## 2. The raw-SQL index list

`platform.lock` `rawSqlIndexes` (20 entries; definitions copied verbatim from `pg_indexes` of the migrated database) is now the single list of Prisma-invisible indexes. B4 asserts each by name and definition. Never turn one into `@@unique` / `@@index`.

```
enrichment_jobs_attempts_gt1_idx            enrichment_jobs_succeeded_duration_idx
faces_embedding_vec_archive_hnsw_idx        faces_embedding_vec_assigned_hnsw_idx
faces_embedding_vec_hnsw_idx                idx_media_circle_device_captured
media_item_embedding_hnsw_idx               media_items_captured_md_idx
media_items_circle_captured_md_idx          media_items_circle_content_hash_active_key
media_items_gallery_idx                     media_items_map_locations_idx
media_visual_embedding_hnsw_idx             mh_legacy_android_app_releases_one_current_uniq_idx
mh_legacy_database_backup_runs_active_uniq_idx   mh_legacy_notifications_review_queue_live_uniq_idx
people_circle_id_hidden_at_idx              review_run_items_run_id_burst_group_id_key
review_run_items_run_id_duplicate_group_id_key   review_run_items_run_id_location_suggestion_id_key
```

`media_items_owner_content_hash_active_key` (named in the issue "if still present") is **gone**: `20260614170110_add_family_circles` dropped it. Confirm against the live copy with:

```sql
SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public'
  AND (indexdef ILIKE '% WHERE %' OR indexdef ILIKE '%USING hnsw%' OR indexdef ~ '\(\(|EXTRACT|lower\(');
```

The list must have 20 rows. The platform's own raw-SQL indexes (`jobs_*`, the platform `database_backup_runs_active_uniq_idx`) need no entry. Other raw-SQL drift (the `faces_sync_embedding_vec` trigger, CHECK constraints, the composite FK on `review_run_items`) is recorded in [local-exceptions.md](../platform-adoption/local-exceptions.md) under `memoriahub:domain-schema`.

## 3. Deviations

Declared in `platform.lock` by `apps/api/scripts/baseline-deviations.mjs`, which reads a **saved** dry-run report, proves every `BLOCKING:` statement and refuses the rest (exit 1; exit 2 on a usage error):

| Id | Statements | What | Removed by |
|---|---|---|---|
| `memoriahub:users-avatar` | 3 | `users.avatar_source`, `avatar_storage_key`, `avatar_version`, `linked_person_id`, its index and `users_linked_person_id_fkey` (each column must be added by an app-only migration) | RETRO-B2 |
| `memoriahub:legacy-platform-tables` | 53 | statements about `mh_legacy_*` tables and `MhLegacy*` enums; accepted when the **original** name (prefix removed) was created by an app-only migration | RETRO-C1, C2, D3, D4, D5, piecewise |
| `memoriahub:domain-schema` | 340 | every other statement; accepted only when it targets a table or enum an app-only migration creates | never (a record) |

Anything else touching a platform `0001`/`0002` table is a real difference and is refused. Proof, run during the rehearsal: a report with an added `ALTER TABLE "users" DROP COLUMN "email";` exits 1, and so does `ALTER TABLE "roles" ADD COLUMN ...`.

```bash
cd apps/api
node scripts/baseline-deviations.mjs ~/baseline-dry-run-1.txt                         # prove, print JSON
node scripts/baseline-deviations.mjs ~/baseline-dry-run-1.txt --lock prisma/platform.lock --write
```

"App-only" means every directory under `prisma/migrations` that the report does not show as matched to a platform migration (not the report's `app-only:` lines, which omit the hidden directory of section 5.1).

## 4. Before you start

- No other open PR carries `migration-lock`. Check before starting and before pushing.
- Work in the feature worktree. The image is `pgvector/pgvector:pg17` (the rehearsal used PostgreSQL 16 with pgvector and pg_trgm; the transform does not depend on the major version).
- Point `POSTGRES_*` at the **copy** and echo `POSTGRES_HOST` / `POSTGRES_DB` twice before every step that writes.
- `platform-env.js` must not log `DATABASE_URL`; never commit credentials. Backups downloaded for rehearsal hold user data: keep them on an encrypted volume and delete them afterwards.

## 5. The procedure

```bash
cd apps/api
npm run prisma:migrate                                     # 82 directories on the copy (81 + the rename)
node scripts/platform-env.js db baseline --through 2 --allow-rls 2>&1 | tee ~/baseline-dry-run-1.txt
node scripts/baseline-deviations.mjs ~/baseline-dry-run-1.txt --lock prisma/platform.lock --write
# add rawSqlIndexes (section 2), re-run until: dry run clean
node scripts/platform-env.js db baseline --through 2 --allow-rls --apply
npm run prisma:migrate                                     # applies 0003-0040
npm run prisma:seed
npm run db:check:database
npm run db:baseline                                        # no --through: nothing to do / dry run clean
node scripts/baseline-app-migrations.mjs                   # writes appMigrations (80)
npm run db:check
```

`--allow-rls` is required: platform `0025` to `0029` and `0039` enable row-level security and sit above `--through`. It only records that the operator knows the API connects as a superuser (section 8). The tool prints its report on **stderr**: redirect with `2>&1` and do not pipe into `head` (SIGPIPE kills `tee`).

### 5.1 Hiding `push_subscriptions` (a deviation from the issue)

The first dry run matched a third migration: `platform:0007_add_push_subscriptions -> 20260814000000_add_push_subscriptions [normalised, localSha256 recorded]` (the two files differ only in comments). The issue calls any `[normalised]` match a surprise to investigate. The finding:

- the tool then refuses with `PLACEMENT_IMPOSSIBLE` (the local directory sorts before the installed `0003`-`0006`), and
- it would be **wrong even if it did not refuse**: the matched directory's table is renamed to `mh_legacy_push_subscriptions` by the new migration, so the platform's `push_subscriptions` would never be created.

`proposeMapping` has no way to say "do not match this directory". The workaround used, and the one to repeat: run the baseline from a temporary copy of `apps/api` (`--root` is the directory holding `prisma/`) **without** `prisma/migrations/20260814000000_add_push_subscriptions`:

```bash
R=apps/.baseline-root   # untracked; delete afterwards
mkdir -p $R && cp -r apps/api/prisma apps/api/scripts apps/api/prisma.config.ts apps/api/package.json apps/api/tsconfig.json $R/
ln -s "$PWD/apps/api/node_modules" $R/node_modules
rm -rf $R/prisma/migrations/20260814000000_add_push_subscriptions
(cd $R && node scripts/platform-env.js db baseline --through 2 --allow-rls --apply)
cp -r $R/prisma/migrations/20261108* apps/api/prisma/migrations/ && cp $R/prisma/platform.lock apps/api/prisma/platform.lock
```

Consequences, all expected: B1 reports `2 matched, 38 unmatched` instead of 3 matched; B6 reports one problem (`prisma migrate status`: the ledger holds `20260814000000_add_push_subscriptions` which the temporary tree lacks). In the real tree `migrate status` is clean. The installed `..._add_push_subscriptions` is an exact byte copy of platform `0007`, so afterwards the real tree maps 0007 to it by sha256 and `20260814000000_...` is an ordinary app-only directory.

The installed directories are named from the **clock at apply time** (`20261108020409` to `20261108020446`). The names are committed with the PR; RETRO-A6 and any later rehearsal use the committed tree and never regenerate them.

## 6. Expected numbers

| Block | Value |
|---|---|
| `B1 map` (temporary tree) | `2 matched, 38 unmatched, 79 app-only`; both `[sha256]` |
| `B1 map` (committed tree, any later run `--through 2`) | `40 matched, 0 unmatched, 80 app-only` |
| `B2 ledger` | `managed by Prisma Migrate; 0 problem(s)` |
| `B3 diff` | first run `396 blocking, 0 declared`; after the deviations `0 blocking, 396 declared` |
| `B4 raw-SQL indexes` / `B4 row-level security` | `0 problem(s)` / `0 problem(s)` |
| `B5 act` | `0 to resolve, 38 to install only` (temporary tree); `0 to resolve, 0 to install only` (committed tree) |
| Last line | `REFUSED ... DIFF_BLOCKING` (first run), then `dry run clean: re-run with --apply to write the lock and resolve` |
| `prisma:migrate` | `All migrations have been successfully applied`; `120 migrations found` after the 38 (82 + 38) |
| `db:check` | `ok (40 installed platform migration(s))` |
| `db:check:database` | `ok (120 ledger row(s) match the files)` |
| Post-migrate `db:baseline` | `B1 40 matched, 0 unmatched, 80 app-only`, `0 blocking, 396 declared`, `nothing to do` |
| After `appMigrations` | `dry run clean: every package migration is mapped and recorded; --apply writes platform.lock only` (a pass; do not `--apply` again) |
| `platform.lock` | 40 `migrations` entries (2 mapped + 38 installed), 3 `deviations`, 20 `rawSqlIndexes`, 80 `appMigrations`, `platformVersion` `1.0.0` (written by the tool) |

`396 = 3 + 53 + 340`. The count changes only when a migration is added, so on a later run it must equal the committed lock's.

## 7. Fresh database proof

```bash
POSTGRES_DB=memoriahub_fresh npm run prisma:migrate     # 120 directories from nothing
POSTGRES_DB=memoriahub_fresh npm run prisma:seed
POSTGRES_DB=memoriahub_fresh npm run db:check:database  # ok (120 ledger row(s) match the files)
POSTGRES_DB=memoriahub_fresh npm run db:baseline        # 40 matched, 0 blocking, 396 declared
POSTGRES_DB=memoriahub_fresh npm run db:drift           # exits 1: expected drift below
```

**Expected `db:drift` output until RETRO-B2** (the schema composed from the stub knows no platform model): a `SCHEMA_DRIFT` listing of roughly 940 lines: 32 `DROP TABLE` (31 platform tables from migrations `0003`-`0040`: `ai_models`, `ai_runs`, `ai_usage_events`, `alert_*`, `credentials`, `grants`, `group*`, `jobs`, `job_node_secrets`, `memberships`, `org_*`, `organizations`, `user_ai_keys`, `user_credentials`, `webhook_*`, `worker_node_events`, plus the **empty platform twins** `notifications`, `push_subscriptions`, `notification_deliveries`, `notification_broadcasts`, `job_stats_rollup`, `worker_nodes`, `node_credentials`, `database_backup_runs`, `android_app_releases` that exist beside the `mh_legacy_*` tables; and the pre-existing `media_visual_embedding`, a raw-SQL pgvector table), 11 `DropEnum`, 132 `DropForeignKey` / 68 `AddForeignKey` (Prisma's usual re-add noise, present before A5 too) and 40 `AlterTable` (uuid default drops). Nothing in it is new MemoriaHub drift. The count must shrink to zero as B2 composes the platform schema; a statement about a `mh_legacy_*` object that is not an FK re-add is a defect in the fragment maps.

## 8. The application role

The role script (`infra/compose/postgres-init/10-app-role.sh`) and what was measured running as `memoriahub_app` are in [application-role.md](application-role.md). The API still connects as the bootstrap superuser (open decision 1 of the issue: until RETRO-D1 brings `forOrg` / `runInOrg` for storage). Doctor `db.rls_role` fails until then; it is a row in [local-exceptions.md](../platform-adoption/local-exceptions.md).

## 9. Rehearsal record (SYNTHETIC)

| | |
|---|---|
| Date | 2026-11-08 |
| Kind | **Synthetic.** No production backup was available. |
| Cluster | PostgreSQL 16.15 (Ubuntu), pgvector, throwaway cluster, trust auth |
| Database | `memoriahub_rehearsal`: all 81 existing migrations applied by `npm run prisma:migrate`, then `npm run prisma:seed` (31 tag labels, 3 roles, 43 permissions), then representative rows inserted |
| Packages | `@marinoscar/platform-db` `0.1.0-next.21`; platform manifest `0001`-`0040` |

Synthetic rows (invented placeholders only), inserted before the rename and compared after it. Row counts were identical before and after the rename migration and after `prisma:migrate` (`LEGACY-DATA-SURVIVES`):

| Table (legacy name after the rename) | Rows |
|---|---|
| `users`, `storage_objects`, `storage_object_chunks` | 2, 2, 1 |
| `mh_legacy_notifications` (one `review_queue_bursts` row exercising the partial unique index) | 3 |
| `enrichment_jobs` | 3 |
| `mh_legacy_job_stats_rollup`, `mh_legacy_worker_nodes`, `mh_legacy_node_credentials` | 1, 1, 1 |
| `mh_legacy_database_backup_runs` (completed + running), `mh_legacy_android_app_releases` (one current) | 2, 2 |
| `mh_legacy_push_subscriptions`, `mh_legacy_notification_deliveries`, `mh_legacy_notification_broadcasts` | 1, 1, 1 |

After `prisma:migrate` the platform twins `notifications`, `jobs`, `worker_nodes` held 0 rows, one default organization existed, and no `storage_objects.org_id` was null (platform `0025` back-filled the 2 rows).

Reports (full text kept with the PR author; the blocks):

- **Dry run 1** (temporary tree, `--through 2 --allow-rls`, exit 1): `B1 map: 2 matched, 38 unmatched, 79 app-only`; `B2 ledger: ... 0 problem(s)`; `B3 diff ...: 396 blocking, 0 declared`; `B4 raw-SQL indexes: 0 problem(s)`; `B4 row-level security: 0 problem(s)`; `B5 act: 0 to resolve, 38 to install only`; `REFUSED: DIFF_BLOCKING` (the first, unhidden run printed 3 matched and also `PLACEMENT_IMPOSSIBLE`, section 5.1; without `--allow-rls` also `RLS_OPT_IN_REQUIRED`).
- **Deviations**: `396 statement(s) proven (memoriahub:users-avatar: 3, memoriahub:legacy-platform-tables: 53, memoriahub:domain-schema: 340)`.
- **Dry run 2** (deviations + 20 rawSqlIndexes, exit 0): `B3 ... 0 blocking, 396 declared`; `B4 ...: 0 problem(s)` twice; `B5 act: 0 to resolve, 38 to install only`; `dry run clean: re-run with --apply to write the lock and resolve`.
- **`--apply`**: installed `20261108020409` to `20261108020446`, `action: write platform.lock (40 entries)`; `B6 verify: 1 problem(s)` (only the expected `prisma migrate status` complaint about the hidden directory, section 5.1).
- **`prisma:migrate`**: `All migrations have been successfully applied` (38 migrations). **`prisma:seed`**: completed. **`db:check:database`**: `ok (120 ledger row(s) match the files)`. **`db:check`**: `ok (40 installed platform migration(s))`.
- **Post-migrate `db:baseline`**: `B1 map: 40 matched, 0 unmatched, 80 app-only`; `B2 0 problem(s)`; `B3 ...: 0 blocking, 396 declared`; both `B4` `0 problem(s)`; `B5 act: 0 to resolve, 0 to install only`; `nothing to do: platform.lock maps every package migration and the database records them`.
- **Production-day dry run** (committed tree, `--through 2 --allow-rls`, against a copy of the database taken before the baseline, exit 0): `B1 40 matched, 0 unmatched, 80 app-only`; `B3 0 blocking, 396 declared`; `B5 0 to resolve, 0 to install only` with the note that the lock's 40 entries differ from the recomputed plan; `dry run clean: ... --apply writes platform.lock only`. This is what RETRO-A6 should see.
- **Fresh database** `memoriahub_fresh`: 120 directories migrated from nothing, seeded, `db:check:database` ok, `db:baseline` `0 blocking, 396 declared`, `db:drift` as in section 7.
- **Measured as `memoriahub_app`** (section 8): ownership of every table, enum and function transferred (0 objects not owned); with no `app.org_id`, `SELECT count(*) FROM storage_objects` returns **0** of 2 rows; `users` returns 2; inside a transaction with `app.org_id` set the 2 rows are visible; an INSERT into `storage_objects` without the setting is rejected by the row-level-security policy.

What a synthetic database cannot prove, and the reason section 10 exists: real data volumes (rename lock time on the largest tables), production-only index definitions or leftovers (an extra index, a manually created object), a ledger that differs from the files, and the pg_dump/pg_restore round trip of the real archive.

## 10. Production-backup rehearsal: NOT YET DONE (required before RETRO-A6)

The owner must run this on a **restored production backup**, on a non-production cluster, and fill in the table below. Do not skip it: kvox rehearsed on a synthetic copy and had to repeat.

```bash
# 1. Fresh production backup (admin Database Backup page, or POST /api/admin/db-backup/runs); download it.
createdb memoriahub_rehearsal
pg_restore -d memoriahub_rehearsal --no-owner --no-acl <archive>.dump       # image: pgvector/pgvector:pg17
export POSTGRES_HOST=... POSTGRES_PORT=... POSTGRES_USER=... POSTGRES_PASSWORD=... POSTGRES_DB=memoriahub_rehearsal
echo $POSTGRES_HOST $POSTGRES_DB; echo $POSTGRES_HOST $POSTGRES_DB         # echo twice

# 2. Record the "before" counts of every table the rename touches (and users, storage_objects, storage_object_chunks).
psql -c "select 'notifications',count(*) from notifications union all select 'enrichment_jobs',count(*) from enrichment_jobs ..."   # all 9 tables + the 3 above

# 3. Check the raw-SQL index list against the real database (expect 20 rows, owner index absent):
psql -c "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND (indexdef ILIKE '% WHERE %' OR indexdef ILIKE '%USING hnsw%' OR indexdef ~ '\(\(|EXTRACT|lower\(') ORDER BY 1"

# 4. Time the rename and prove the committed tree (in the PR) is clean against production's ledger:
cd apps/api
\timing on   # in psql: run the body of the rename migration to see the lock time on the largest table
npm run prisma:migrate                                                         # applies ONLY the rename (the 38 installed ones apply in step 6)
npm run db:baseline -- --through 2 --allow-rls 2>&1 | tee ~/baseline-prod-rehearsal-dry-run.txt

# 5. Apply exactly like production will (RETRO-A6): the committed lock already exists, so --force-remap is needed to rewrite it identically.
npm run db:baseline -- --through 2 --allow-rls --apply --force-remap
git diff --exit-code prisma/platform.lock prisma/migrations      # must show NO change

# 6. Migrate, seed, verify.
npm run prisma:migrate && npm run prisma:seed
npm run db:check && npm run db:check:database
npm run db:baseline                                                            # nothing to do / dry run clean
psql -f <the "after" counts, with mh_legacy_* names>                            # every count equals step 2

# 7. App smoke (start the API against the copy as the current superuser): sign in as an admin, open the gallery,
#    upload one photo (proves the org_id shim), run a job (admin jobs page), open Doctor.
```

Numbers to compare with the synthetic rehearsal (section 9). A difference in any line means production is not the database rehearsed: **stop and do not apply**.

| Check | Synthetic | Production backup |
|---|---|---|
| Migrations in ledger before the rename | 81 | |
| Migrations in ledger after the rename | 82 | |
| Rename migration | 63 statements, instant | time: |
| `B1 map` (committed tree) | `40 matched, 0 unmatched, 80 app-only` | |
| `B2 ledger` | `0 problem(s)` | |
| `B3 diff` | `0 blocking, 396 declared` | |
| `B4` (indexes, RLS) | `0 problem(s)` each | |
| `B5 act` | `0 to resolve, 0 to install only` | |
| `prisma:migrate` after the baseline | 38 applied | |
| `db:check:database` | `ok (120 ledger row(s) match the files)` | |
| Raw-SQL index query | 20 rows | |
| Row counts, all renamed tables + `users`, `storage_objects`, `storage_object_chunks` | equal before/after | |
| `storage_objects.org_id` null after `0025` | 0 | |
| App smoke (sign-in, gallery, upload, a job, Doctor) | not run (no browser) | |

If the production counts of `B3` differ, the likely causes are an object created by hand, an index renamed or dropped by an operator, or a migration applied out of the files' order. `LEDGER_CHECKSUM_MISMATCH` means a migration file was edited after it was applied: restore it from Git.

## 11. Release train, rollback

- **No production deploy between A5 and the series it gates.** A5 changes raw SQL to the `mh_legacy_*` names and the schema fragments; a binary built from this change cannot run on an unrenamed database, and an old binary cannot run on a renamed one. RETRO-A6 deploys the migration and the code together, in a maintenance window ([maintenance-mode.md](maintenance-mode.md)), after the section 10 rehearsal.
- **Before `--apply`**: nothing to undo; on the copy, drop the database.
- **After the window opened**: take a fresh backup first; roll back by restoring it ([database-restore.md](database-restore.md)) and reverting the PR. Never write down-migrations and never edit or rename an installed directory (the lock hashes the bytes, comments included).
- **Dry run on production** must print the numbers of section 10 exactly (committed tree, so `40 matched`).

## 12. Troubleshooting

| You see | Do |
|---|---|
| `PLACEMENT_IMPOSSIBLE` for `platform:0007_add_push_subscriptions` | You ran from the real tree before the baseline: use the temporary tree (section 5.1) |
| `RLS_OPT_IN_REQUIRED` | Add `--allow-rls` (see section 8 for what it records) |
| `DIFF_BLOCKING` and `baseline-deviations.mjs` exits 1 | A statement touches a platform table or an object no app-only migration creates. Stop and report it on #587; never declare it |
| `LOCK_NOT_EMPTY` | A lock already exists: use `--force-remap` only on a rehearsal copy, and confirm `git diff` shows no change |
| `B6 verify` prints only the `prisma migrate status` complaint about `20260814000000_add_push_subscriptions` | Expected from the temporary tree (section 5.1) |
| No output after piping into `head` | The report is on stderr; use `2>&1` and a file |
| `Connection terminated unexpectedly` from the tool | The cluster died (check its log); restart it and re-run: the dry run changes nothing |

## 13. Changes after RETRO-A5

**RETRO-C1 (#575), migration `20261108040000_cutover_enrichment_jobs_to_jobs`.** One more app-only directory, so a database now has 122 migration directories (82 app-only in `appMigrations`, 40 platform). The migration copies `enrichment_jobs` into the platform `jobs`, folds `mh_legacy_job_stats_rollup` into `job_stats_rollup` and drops it, and renames `enrichment_jobs` to `enrichment_jobs_legacy` (its three foreign keys and two partial indexes are dropped). Expected numbers on a migrated database: `B3 diff` `0 blocking, 391 declared` (61 `memoriahub:legacy-platform-tables`, 330 `memoriahub:domain-schema`), `B4 raw-SQL indexes` over 18 entries (the two `enrichment_jobs_*` partial indexes left the list), `db:check:database` `ok (122 ledger row(s) match the files)`. The deviation statements were regenerated with `scripts/baseline-deviations.mjs` (it now also accepts a table renamed to `<name>_legacy`). Procedure and rehearsal: [jobs-cutover.md](jobs-cutover.md).

**RETRO-A5b (#653), migration `20261108160000_rename_legacy_storage_migration_tables`, platform `0.1.0-next.27`.** Platform `0042_add_storage_migrations` creates `storage_migration_runs`, `storage_migration_items` and the enum `StorageMigrationItemStatus`, which MemoriaHub already had (`20260621030000_storage_provider_config`, a different shape). The A5 rename covered only `0003`-`0040`, so this second rename migration (10 statements, one transaction, metadata only) extends section 1's list:

- 2 tables: `storage_migration_runs`, `storage_migration_items`, each to `mh_legacy_<name>`;
- 2 enum types: `StorageMigrationItemStatus` (collides) and `StorageMigrationStatus` (does not collide, the platform's is `StorageMigrationRunStatus`; renamed so every legacy storage-migration object carries the prefix), each to `MhLegacy<Name>`;
- 4 constraints (both primary keys, both foreign keys) and 2 standalone indexes (`..._run_id_object_id_key`, `..._status_idx`), prefixed `mh_legacy_`, generated from `pg_constraint` / `pg_index` of a database after the 122 earlier migrations.

It sorts after `20261108040000` and **before** the installed `0041`/`0042`: `platform db sync` names installed directories from the clock, after the newest local directory, so the rename was committed first and the sync then installed `20261108163317_notifications_state_counted` (`0041`) and `20261108163318_add_storage_migrations` (`0042`). The models are `MhLegacyStorageMigrationRun` / `MhLegacyStorageMigrationItem` (`platform-storage.legacy.prisma`); the admin API `/api/storage-settings/migrate*` and the `storage_migration` job type keep working on the renamed tables until RETRO-D1. Proof: `apps/api/test/storage-settings/legacy-storage-migration-rename.db.spec.ts`.

Expected numbers on a database migrated from empty after A5b: `prisma:migrate` `125 migrations found`; `db:check` `ok (42 installed platform migration(s))`; `db:check:database` `ok (125 ledger row(s) match the files)`; `db:baseline` `B1 42 matched, 0 unmatched, 83 app-only`, `B3 ... to platform:0042_add_storage_migrations: 0 blocking, 391 declared` (69 `memoriahub:legacy-platform-tables`, 322 `memoriahub:domain-schema`: the eight storage-migration statements moved from the second to the first), both `B4` `0 problem(s)` (18 `rawSqlIndexes`, unchanged), `B5 0 to resolve, 0 to install only`, `dry run clean`. `platform.lock` holds 42 `migrations` entries, 2 `deviations`, 18 `rawSqlIndexes`, 83 `appMigrations` and `platformVersion` `0.1.0-next.27` (written by `db sync`). The deviations were regenerated with `scripts/baseline-deviations.mjs` from a dry run taken with the lock's `deviations` emptied (so every statement prints as `BLOCKING:`); the script replaces each deviation entry wholesale, so feeding it a report that already declares most statements would shrink an entry to the few still blocking. `db:drift` lists no statement about a `mh_legacy_storage_migration_*` object.
