# Runbook: circles to groups and content ownership (RETRO-I2)

Issue [#569](https://github.com/marinoscar/MemoriaHub/issues/569), epic [#556](https://github.com/marinoscar/MemoriaHub/issues/556). The mapping and its decisions: [circles-to-groups.md](../platform-adoption/circles-to-groups.md) (§0b is what I2 did). This page is the operator procedure.

## 1. What the migration does

One app migration, `apps/api/prisma/migrations/20261108200000_i2_circles_to_groups_ownership`, in ONE transaction under `app.rls_bypass`:

1. One `groups` row per shared (non-personal) circle, **with the circle's id**, in the default organization (`name`, `description`, `created_by_id = owner_id`, timestamps kept). A personal circle gets no group.
2. One `group_members` row per member of a shared circle: `circle_admin` -> `admin`, `collaborator` -> `editor`, `viewer` -> `viewer`. A group left with no admin gets its circle owner as admin (added, or promoted when already a member): the sharing slice refuses a group without an admin.
3. `org_id`, `owner_group_id`, `owner_user_id` on 21 tables (`media_items`, `albums`, `tags`, `people`, `faces`, `memories`, `media_item_embedding`, `media_visual_embedding`, `media_geocode_status`, `media_metadata_status`, `media_tag_status`, `media_transcripts`, `burst_groups`, `duplicate_groups`, `location_suggestions`, `media_enhancements`, `media_enhancement_batches`, `review_runs`, `trash_empty_runs`, `workflows`, `workflow_runs`), backfilled from `circle_id`: a shared circle's row gets `owner_group_id = circle_id`, a personal circle's row `owner_user_id = circles.owner_id`; `org_id` is the default organization. The two embedding tables have no key on `circle_id`; a row whose circle is gone takes its media item's circle.
4. `org_id` NOT NULL (default `mh_default_org_id()`), `CHECK (num_nonnulls(owner_user_id, owner_group_id) = 1)`, `(owner_group_id, org_id) -> groups (id, org_id) ON DELETE RESTRICT`, `owner_user_id -> users ON DELETE RESTRICT`, `org_id -> organizations`, btree indexes on both owner columns, `ENABLE` + `FORCE ROW LEVEL SECURITY` and `<table>_org_isolation`.
5. Triggers that keep it all equal to the circles while the application still writes circles (`PLATFORM-ADOPTION-SHIM(#573)`, [local-exceptions.md](../platform-adoption/local-exceptions.md)).

**Nothing is dropped or rewritten in place**: `circles`, `circle_members`, `circle_invites`, every `circle_id` column and its indexes stay, and circles keep deciding access. JSON references to circle ids (`user_settings.activeCircleId`, `media_sync_devices.config.targetCircleId`, `node_backup_configs.circle_ids`, workflow definitions, job payloads, notification data) are left as they are: every one still names an existing circle, and a shared circle's id is now also its group's id.

The file is re-runnable (every statement guarded); replaying it changes nothing. A row it cannot give an owner (no circle, not even through its media item) aborts the whole transaction with a message naming the table: nothing is changed and the dry run below lists such rows first.

**API and behaviour**: no route, response or permission changes. New: `media_item` and `album` are registered sharing resource types, so `/api/grants` accepts them (nothing reads grants yet); `DELETE /api/groups/:id` refuses a group that owns content (409 `GROUP_OWNS_RESOURCES`) or that mirrors an existing circle (a database error, 500). The org-data export lists no content table (all are export-excluded).

## 2. Expected time

**Plan a maintenance window of about 30 minutes for ~80k media items** (measured 23 minutes on a shared, memory-constrained test host, §6; a dedicated database host is faster). The API cannot serve meanwhile: the transaction holds `ACCESS EXCLUSIVE` locks on the content tables.

Almost all of it is the five HNSW indexes (`faces` x3, `media_item_embedding`, `media_visual_embedding`). Rewriting a row re-inserts it into every HNSW graph, so the migration drops them before the backfill (only when there is something to backfill) and rebuilds them after with the exact `platform.lock` definitions. A build is much faster when the graph fits in `maintenance_work_mem`; the migration raises it to 256MB for its own transaction when the server's is lower and keeps a larger value. On a host with memory to spare, raise it for the window (new sessions pick it up; `prisma migrate deploy` opens one):

```sql
ALTER DATABASE "<POSTGRES_DB>" SET maintenance_work_mem = '1GB';   -- before; RESET after the migration
ALTER DATABASE "<POSTGRES_DB>" RESET maintenance_work_mem;
```

The rest (groups, members, the backfill `UPDATE`s, keys, indexes) takes seconds: the `media_items` backfill of 80,500 rows took 10 s.

## 3. Procedure

```bash
# 0. A fresh database backup, completed AND verified (admin Database Backup page, or POST /api/admin/db-backup/runs).
# 1. Rehearse on a copy restored from it (docs/runbooks/database-restore.md), then on production:
node scripts/circles-to-groups/dry-run.mjs --database "$COPY_URL" | tee dry-run.txt   # exit 0 = can run
#    Read: shared circles without an admin (their owner becomes group admin), circle members without an
#    active default-organization membership (informational), and any table with NO OWNER rows (a blocker).
# 2. Enable maintenance mode (PUT /api/admin/maintenance {"enabled":true}); stop the worker fleet.
cd apps/api && npm run prisma:migrate          # applies 20261108200000_i2_circles_to_groups_ownership
node ../../scripts/circles-to-groups/verify.mjs --database "$URL" | tee verify.txt     # exit 0 = every check holds
npm run db:check:database && npm run db:baseline      # expected numbers: database-baseline.md §13 (RETRO-I2)
# 3. Smoke: sign in, open the gallery, upload one photo into a shared circle and one into "My library",
#    open an album, then disable maintenance mode.
```

Keep `dry-run.txt`, `verify.txt` and the backup for 7 days.

`verify.mjs` proves: groups = shared circles (same id, name, description, creator, default organization), no group for a personal circle; every shared-circle member is a group member with the mapped role, the only extra rows being owners made admin; on all 21 tables zero NULL `org_id`, zero rows without exactly one owner, and every owner equal to what `circle_id` says; RLS enabled and forced, the policy and the owner trigger on every table, the three mirror triggers present. Both scripts are read-only (one `READ ONLY` transaction, rolled back).

## 4. Rollback

There is no down migration. Before RETRO-I3 the change is additive, so the application of the previous release runs on the migrated database unchanged (it never names the new columns; the triggers fill them). To return the schema itself: restore the pre-migration backup. Rows written after the migration are then lost, which is why the backup is taken in the same window.

## 5. Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `RETRO-I2: N row(s) of <table> have no circle to take an owner from` | A content row whose `circle_id` names no circle (only possible on the two embedding tables, and then only when the media item's circle is gone too) | The transaction rolled back. Inspect the rows the dry run lists; they are orphans the next re-embed recreates: delete them on the copy, re-run the dry run |
| `circles exist but no default organization` | The identity migrations did not run | Run every earlier migration first (`prisma:migrate` applies them in order) |
| `group ... mirrors a circle; delete the circle instead` | Someone deleted a mirrored group through `/api/groups/:id` | Expected: until RETRO-I3 a circle's group goes with the circle |
| `circle ... cannot change is_personal` | Code flipped a circle's kind | Not done by any shipped code path; ownership would diverge, so it is refused |
| Doctor `db.rls_role` fails | The API still connects as the superuser (an existing exception) | Unchanged by I2; the 21 tables join the switch tracked in local-exceptions.md |

## 6. Rehearsal record (SYNTHETIC)

No production backup was available to the implementing session; the numbers below are synthetic and must be replaced by the production-copy rehearsal (§3) before release.

Data: `apps/api/test/sharing/fixtures/circle-content.seed.sql`, `SELECT mh_i2_seed(11500, true)` on a database at the previous head: 7 circles (4 personal, 3 shared with the three membership edge cases), 80,500 media items with random vectors (128-d face, 1536-d text, 512-d visual embeddings) and every other content table.

| Step | Result |
|---|---|
| `dry-run.mjs` before | `OK: the migration can run`; 3 groups to create, 5 members, 2 shared circles without an admin (one owner not a member), 0 rows without an owner |
| `prisma:migrate` (incremental HNSW, the first version of the file) | 32 min 45 s |
| `prisma:migrate` (HNSW dropped and rebuilt, the committed file) | **22 min 53 s** |
| One HNSW build, `media_visual_embedding`, 80,500 x 512-d | 8 min 06 s at `maintenance_work_mem` 64MB (graph spilled after 23,042 tuples); 1 min 36 s at 512MB |
| Re-writing `media_visual_embedding` with its HNSW index in place | over 10 min (cancelled) |
| `verify.mjs` after | `OK: every check holds` (0.6 s): 34,500 group-owned and 46,000 user-owned rows on each per-item table |
| Gallery keyset query (`circle_id`, `deleted_at IS NULL AND archived_at IS NULL`, `ORDER BY captured_at DESC, id DESC LIMIT 60`) | `Index Only Scan using media_items_gallery_idx` (unchanged: the index and the query still use `circle_id`) |
| Replay of the file on the migrated database | no change (fingerprint of every owner, group and member identical; `test/sharing/ownership.db.spec.ts`) |

Host: PostgreSQL 16.15 with pgvector, default configuration (`maintenance_work_mem` 64MB, raised to 256MB by the migration), shared with other databases.
