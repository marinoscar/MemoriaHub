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
| A group member changed through `/api/groups/**` gains or loses access, but the circle's member list and the memories digest / review-queue notifications do not follow (RETRO-I3) | Access reads `group_members`; the background sweeps still read the mirrored `circle_members`, and the mirror is one-way (circle to group) | Change memberships through `/api/circles/:id/members` until RETRO-I5/I6. The list of sweeps and the equality test: [circles-to-groups.md §8](../platform-adoption/circles-to-groups.md#8-cross-circle-query-inventory) |
| Someone who is not a member opens a shared photo or album and it works (RETRO-I3) | A user or group grant on that record (`/api/grants`) | Expected: a grant adds access to that one record. Revoke it through `/api/grants` |

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

## 7. Public shares to link grants (RETRO-I4)

Release #578 makes every public share a platform link grant ([public-sharing spec](../specs/public-sharing.md)). The code no longer reads `media_shares`; the rows move with a TypeScript import (the platform's `importLegacyToken`, which hashes and encrypts each token), and only then does the contract migration drop the table. **Order matters: deploy, import, migrate. Never the reverse.** The migration refuses to run while any share is not imported, so applying it first fails loudly instead of destroying every public link.

Prerequisites: the platform baseline applied (the `grants` table exists; **RETRO-I2 is not required**: before I2 the import takes each share's organization from the default organization, the value I2 backfills, and the grants are identical either way), `SECRETS_ENCRYPTION_KEY` set (the same key the API uses), a fresh, verified database backup.

```bash
# 0. Backup (admin Database Backup page, or POST /api/admin/db-backup/runs), completed AND verified.
# 1. Count what exists (read-only, any time before the deploy):
#      SELECT target_type, count(*) FILTER (WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS active,
#             count(*) FILTER (WHERE revoked_at IS NULL AND expires_at <= now()) AS expired,
#             count(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked
#      FROM media_shares GROUP BY target_type;
# 2. Deploy the release WITHOUT running `prisma:migrate` (the deploy flow's migrate step must wait). The import below runs on the database as it is, before I2.
# 3. Dry run (counts, zero writes), then import, in the api container:
npm run sharing:import-media-shares --workspace=api               # "media_shares: N (active a, expired e, revoked r; ...)"
npm run sharing:import-media-shares --workspace=api -- --apply    # "imported N, already there 0, invalid 0, ... re-keyed K"
#    Re-running is safe: already imported shares are skipped. "invalid" lists rows whose token is
#    malformed or whose target is gone; the migration refuses until they are resolved (delete them).
# 4. Apply the migrations (I2 first, then this contract migration, which drops media_shares, ShareTargetType, shares:manage|manage_any):
npm run prisma:migrate --workspace=api
# 5. Smoke: open one old media link /s/<token>, one old album link and one revoked one; the first two
#    land on /s#lnk_<token> and show the item / grid, the revoked one says "This link is not available".
#    Create a new link from an album page; revoke it from /admin/settings/sharing.
```

Expected time: seconds (one grant per share; a library has hundreds of shares at most).

Rollback: **before step 4**, revert the release; `media_shares` is intact. Delete the imported grants if wanted: `DELETE FROM grants WHERE grantee_kind = 'link' AND link_token_hash IN (SELECT encode(sha256(convert_to('lnk_' || token, 'UTF8')), 'hex') FROM media_shares)` (as the table owner, inside `BEGIN; SELECT set_config('app.rls_bypass','on',true); ...; COMMIT;`). **After step 4**, restore the backup taken in step 0 and revert.

| Symptom | Cause | Action |
|---|---|---|
| Migration fails: `RETRO-I4: N media_shares row(s) are not imported as link grants yet` | Step 3 was skipped or reported invalid rows | Run step 3; delete the rows it lists as invalid; re-run the migration |
| Import fails: `SECRETS_ENCRYPTION_KEY` | The key is not in the script's environment | Run it in the api container (or export the API's key) |
| An old link shows "This link is not available" | It was revoked or expired before the cutover (imported as such), or its record is trashed | Expected; restore the record or re-share |
| A client calling `/api/public/shares/...` gets 410 `LEGACY_SHARE_ROUTE` | The retired API route | Use the web link; the API log counts these hits (no token logged) |

Rehearsal: on a restored production backup, record the dry-run counts, the import output and the three sampled old URLs here before release. The real-Postgres proof of the procedure is `apps/api/test/sharing/media-shares-import.db.spec.ts` (five shares: active media, active album, expired, revoked, never-expiring; migration refused before the import, idempotent import, migration and replay after it); the same import on a database BEFORE I2, followed by every later migration, is `apps/api/test/sharing/media-shares-import-pre-i2.db.spec.ts`.

## 8. Circle invites to group invites (RETRO-I5)

Release #583 makes every circle invite a platform group invite. The code no longer reads `circle_invites`: the invite routes under `/api/circles/:id/invites` delegate to the sharing slice's `GroupInvitesService`, the slice sends `groups.invitation` (the notifier allowlists the invitee first), and the slice claims pending invites itself at sign-up and at every sign-in (`groups.autoAcceptInvitesOnSignup` / `autoAcceptInvitesOnSignIn`, upgrade-only). There is **no separate import script**: migration `20261109200000_i5_circle_invites_to_group_invites` copies the pending invites and drops `circle_invites` in ONE transaction, so no invite can be lost between the two, and an invitee who signs up after the deploy still joins the circle (proved by `apps/api/test/sharing/invites-autoclaim.db.spec.ts`). `circles`, `circle_members` and `CircleRole` stay until RETRO-I6.

What the migration imports: every unclaimed invite of a shared circle, as a pending invite of the circle's group with the same id, role `circle_admin`/`collaborator`/`viewer` -> `admin`/`editor`/`viewer`, `invited_by_id = added_by_id`, `created_at = added_at`, no expiry. Skipped: claimed invites (their member rows exist), invites of a personal circle (it has no group), invites to an address that is already a member with an equal or higher role (accepting would change nothing; an invite that outranks the member's role IS imported and upgrades at the next sign-in), and an address that already has a pending group invite. The counts are printed as a `NOTICE`.

Prerequisites: RETRO-I2 applied (shared circles are groups), RETRO-I4's migration applied or applied in the same run (it is earlier in the history), a fresh, verified database backup.

```bash
# 0. Backup (admin Database Backup page, or POST /api/admin/db-backup/runs), completed AND verified.
# 1. Dry run (read-only, any time before the deploy): what the migration will import and skip.
#      SELECT count(*) FILTER (WHERE ci.claimed_at IS NOT NULL)                        AS claimed_dropped,
#             count(*) FILTER (WHERE ci.claimed_at IS NULL AND c.is_personal)          AS personal_skipped,
#             count(*) FILTER (WHERE ci.claimed_at IS NULL AND NOT c.is_personal)      AS pending_shared
#      FROM circle_invites ci JOIN circles c ON c.id = ci.circle_id;
#      SELECT ci.role, count(*) FROM circle_invites ci JOIN circles c ON c.id = ci.circle_id
#      WHERE ci.claimed_at IS NULL AND NOT c.is_personal GROUP BY ci.role;
#    pending_shared minus the "already a member" skips is the number of pending group invites to expect.
# 2. Deploy the release and apply the migrations in the same window (the deploy flow's migrate step):
npm run prisma:migrate --workspace=api
#    The log shows: NOTICE RETRO-I5: circle_invites T (claimed C dropped; personal-circle P skipped;
#    already a member M skipped); imported N pending group invite(s)
# 3. Verify (as the table owner, RLS bypassed):
#      BEGIN; SELECT set_config('app.rls_bypass','on',true);
#      SELECT role, count(*) FROM group_invites WHERE accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL GROUP BY role;
#      COMMIT;
#    The counts match step 1 by role (circle_admin = admin, collaborator = editor, viewer = viewer).
# 4. Smoke: invite a test address from a circle's Invites tab (it is allowlisted and receives the
#    group invitation); sign in as a test account with a pending invite and land in the circle.
```

Expected time: seconds (one row per pending invite).

Between the code deploy and the migration (keep it short), a new user whose only invite is still in `circle_invites` signs up without joining; their next sign-in after the migration claims it (`autoAcceptInvitesOnSignIn`), or they accept it from the pending list.

Rollback: the migration is the point of no return for `circle_invites`. Before it, revert the release. After it, restore the backup taken in step 0 and revert; or, to keep the data written since, revert the release and recreate the table from `group_invites` by hand (the ids are the same).

| Symptom | Cause | Action |
|---|---|---|
| Inviting returns 409 `INVITE_PENDING` | The address already has a pending invite to the group (it used to update the role) | Revoke it, then invite again with the new role |
| Inviting returns 409 `ALREADY_A_MEMBER` | The address belongs to a member | Change the member's role instead |
| An invitee signed in but is not in the circle list | The circle list reads `circle_members`, mirrored from the group a moment after the claim (`GroupMemberMirrorListener`) | Reload; if it persists, check the API log for "Mirroring the membership of group ... failed" |
| An invitee cannot sign in ("not authorized") | The allowlist upsert failed when the invite was sent (logged "Allowlisting an invited address failed") | Add the address on the Allowlist tab |

## 9. Dropping the circle tables (RETRO-K2)

Issues [#588](https://github.com/marinoscar/MemoriaHub/issues/588), [#583](https://github.com/marinoscar/MemoriaHub/issues/583), [#573](https://github.com/marinoscar/MemoriaHub/issues/573). One migration, `apps/api/prisma/migrations/20261110100000_k2_drop_circles`, in ONE transaction under `app.rls_bypass`. **Run it after RETRO-K1 is deployed** (no code of the release before K1 can run on the migrated database: it reads `circles`).

What it does, in order:

1. **Refuses before changing anything** when a user has two personal circles (the second one's content would lose its scope id), a shared circle has no group of the same id, or any of the 21 content tables holds a row whose `circle_id` is neither a group nor a personal circle. It also records, per content table, the row count and a hash of the ordered `(circle_id, org_id, owner_group_id, owner_user_id)` tuples.
2. Creates `personal_libraries (id, user_id UNIQUE)` with **one row per personal circle and the same id**, so no content row's `circle_id` changes.
3. Replaces the mirror trigger on the 21 content tables (`mh_owner_from_circle` -> `mh_owner_from_scope`, function `mh_content_owner_from_scope`): `owner_group_id` when `circle_id` is a group, `owner_user_id` when it is a personal library, and SQLSTATE `23503` for anything else (what the dropped foreign key guaranteed). The application still writes `circle_id`; the owner columns still follow it.
4. Drops the mirror triggers and functions (`mh_circle_mirror_group`, `mh_circle_member_mirror`, `mh_group_mirror_guard`, `mh_circle_role_to_group_role`, `mh_content_owner_from_circle`), every foreign key that names `circles`, the tables `circle_members` and `circles`, and the enum `CircleRole`.
5. **Proves nothing changed**: it recomputes the fingerprint of every content table and aborts the whole transaction on any difference in row count or owner columns.

`circle_id` stays a plain UUID column (a group id or a personal library id) without a foreign key. Dropping the column was rejected: 20 tables, their composite uniques (`media_items_circle_content_hash_active_key`), the gallery, map and KNN indexes, job payloads, the Android phone's `targetCircleId` and every queued job name it. Replacing it by the owner columns alone would rewrite those indexes for no gain.

### Procedure

```bash
# 0. Backup, completed AND verified (admin Database Backup page). Release K1 is deployed and healthy.
# 1. Rehearse on a copy restored from it (database-restore.md): apply the migration, then the verification below.
# 2. Maintenance mode on; stop the worker fleet; then
cd apps/api && npm run prisma:migrate      # applies 20261110100000_k2_drop_circles
npm run db:check:database
# 3. Verification (read-only, safe to repeat; run it as the application owner, rows are under RLS):
```

```sql
BEGIN; SELECT set_config('app.rls_bypass','on',true);
SELECT to_regclass('public.circles') IS NULL AS circles_gone,
       to_regclass('public.circle_members') IS NULL AS members_gone,
       NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CircleRole') AS enum_gone,
       (SELECT count(*) FROM personal_libraries) AS personal_libraries,
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'mh_owner_from_scope') AS scope_triggers,      -- 21
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'mh_owner_from_circle') AS old_triggers;        -- 0
-- every content row names a scope that exists (all 21 tables return 0):
SELECT count(*) FROM media_items x
 WHERE NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = x.circle_id)
   AND NOT EXISTS (SELECT 1 FROM personal_libraries p WHERE p.id = x.circle_id);
-- and every row's owner matches its scope:
SELECT count(*) FROM media_items x
 WHERE (x.owner_group_id IS DISTINCT FROM (SELECT g.id FROM groups g WHERE g.id = x.circle_id))
    OR (x.owner_user_id IS DISTINCT FROM (SELECT p.user_id FROM personal_libraries p WHERE p.id = x.circle_id));
COMMIT;
```

`personal_libraries` equals the number of personal circles before (the migration refuses otherwise). The same four queries per content table are in `apps/api/test/circles/drop-circles.db.spec.ts`, which migrates a seeded scratch database to the step before, applies the migration and compares row counts and owner columns of all 21 tables.

```bash
# 4. Smoke: sign in, open the gallery, upload one photo into a shared library and one into "My library",
#    create a library at /settings/groups and upload into it at once, then disable maintenance mode.
```

Time: seconds plus the fingerprint pass (one scan of each content table, about the cost of the I2 backfill's read side; no row is rewritten and no index is rebuilt).

### Rollback

**One-way.** There is no down migration. Restore the backup taken in step 0 and run the release before K1 (it reads `circles`). Rows written after the migration are lost with the restore; to keep them, export what matters first (data export) and re-import.

### Behaviour changes to tell users about

- **Deleting a library with content is refused.** `DELETE /api/circles/:id` and `DELETE /api/groups/:id` answer 409 (`details.reason: LIBRARY_NOT_EMPTY` on the circle route) while the library holds media, albums, tags, people, memories, workflows or review history, because a group's content keys are `ON DELETE RESTRICT`. Before, the circle's foreign keys cascaded the rows away (the stored files stayed, orphaned). Delete or move the content first; the data-removal flow of a user purges their own libraries' content before the group goes.
- **A factory reset keeps libraries.** It empties every library's content and removes nothing else: groups and their members stay (the platform keeps groups through a reset), personal libraries stay, the actor gets one if they have none.
- A member row of `GET /api/circles/:id/members` has the id `<circleId>:<userId>` (the sharing slice has no member row id).

### Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| The migration aborts with `RETRO-K2: N user(s) have more than one personal circle` | A hand-made second personal circle | Move its content to the first (`UPDATE ... SET circle_id`) and delete it, then rerun |
| It aborts with `N row(s) of <table> name a scope that is neither a group nor a personal circle` | A content row from before the I2 foreign keys, or a circle deleted by hand | List the ids (`SELECT DISTINCT circle_id ...`), restore the circle or delete the rows, rerun |
| An insert fails with `scope <id> is neither a group nor a personal library` (23503) | The scope id names nothing: a deleted group, or a client sending a made-up `circleId` | Expected refusal (it was the foreign key); the API maps an unknown scope to 404 before the insert |
| `DELETE /api/groups/:id` returns 500 | The group still owns rows in a table the 409 guard does not know (the slice's own check covers its resources only) | Same as above: empty the library first; the circle route answers 409 |
