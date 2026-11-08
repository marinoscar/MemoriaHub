# Runbook: factory reset, user data deletion and offboarding (MemoriaHub)

The platform procedure is EAB's `docs/runbooks/factory-reset.md`; this page is MemoriaHub's version of it. Design and the full keep-or-delete table: [specs/user-data-deletion.md](../specs/user-data-deletion.md). Introduced by RETRO-H1 ([#591](https://github.com/marinoscar/MemoriaHub/issues/591)).

A factory reset deletes **every other user and every circle, photo, video, album, tag, person, face, memory, workflow and public link, with their stored files**. It cannot be undone from the application. The only way back is restoring the database backup taken before it, and the object storage as it was.

## 1. Before anything: back up

1. **Database.** Admin → Settings → Database Backup (`/admin/settings/db-backup`): run a manual backup and wait for `completed` with `verifiedAt` set. Download it, or confirm it lives on a provider the reset cannot touch (backups are never swept, but a copy off the deployment is the point).
2. **Object storage.** The reset deletes the bytes of every storage object outside `database-backups/`, `db-backups/` and `android-releases/`. If the photos must be recoverable, snapshot or version the bucket(s) first (S3 versioning, an R2 copy, a disk snapshot for the `local` provider). Every provider any object was ever written to is affected: files are deleted through the provider recorded on each row, not only the active one.
3. Record row counts to compare afterwards:

   ```sql
   SELECT 'users', count(*) FROM users UNION ALL
   SELECT 'circles', count(*) FROM circles UNION ALL
   SELECT 'media_items', count(*) FROM media_items UNION ALL
   SELECT 'storage_objects', count(*) FROM storage_objects UNION ALL
   SELECT 'tag_labels', count(*) FROM tag_labels UNION ALL
   SELECT 'location_groups', count(*) FROM location_groups;
   ```

## 2. Run the factory reset

1. Sign in as an administrator holding `system:factory_reset` (the Admin role; `system_settings:write` alone is not enough).
2. Admin → Settings → Danger Zone → Factory reset (`/admin/settings/factory-reset`). Read the "Deleted" and "Kept" lists; they come from the API and include MemoriaHub's lines.
3. Tick the acknowledgement, type `FACTORY RESET`, confirm. The page polls the `admin.factory_reset` job (30 minutes per attempt, 3 attempts). On a large library the content step can run for minutes; a timeout is retried and deletes what is left.
4. The job also appears in Admin → Settings → Jobs as `admin.factory_reset`.

Unavailable when `DEPLOYMENT_MODE=saas` (the API answers `FACTORY_RESET_DISABLED_IN_SAAS`).

## 3. Verify

- Only your account remains, with one personal circle and nothing in it.
- `media_items`, `albums`, `tags`, `people`, `faces`, `memories`, `workflows`, `media_sync_devices` are empty.
- `storage_objects` holds only database backup objects, if any.
- Kept and unchanged: `tag_labels`, `location_groups`, `location_group_aliases`, the provider credentials, system settings, roles, the audit log, `database_backup_runs` and `mh_legacy_database_backup_runs` (with their archives), `mh_legacy_android_app_releases` (with their APKs), the legacy worker nodes (now owned by you).
- The job's result (`GET /api/admin/factory-reset/:jobId`) carries the counts, including `step.memoriahub.storage.storageObjectsFailed`. A non-zero value means a provider refused some deletions; their rows were kept, and running the reset again retries them.
- Re-run the counts of section 1.

## 4. Recover

A wrongly executed reset is recovered only by restoring the backup from section 1: Admin → Settings → Database Backup → the run → Restore (or the manual procedure in [database-restore.md](database-restore.md) when the application is unreachable), and restoring the bucket snapshot. Restoring the database alone brings back rows whose files are gone (their photos answer 404).

## 5. A user's own data (Danger Zone)

Every user can delete their own data at Settings → Danger Zone (`/settings/danger-zone`): `LIBRARY` (empties their personal circle, files included), `SHARES` (public links), `DEVICES` (unpairs phones and deletes their tokens), or the built-in `DELETE MY CONTENT` / `DELETE MY DATA`. Their account, roles, circle memberships, the circles they share with others and everything they added there are kept. The circle purge runs as the `memoriahub.circle.purge` job; check it in Admin → Settings → Jobs if a user reports photos still visible.

## 6. Offboarding and deleting a user row

Organization offboarding (`orgs:offboard`) needs `TENANCY_MODE=multi`, which MemoriaHub does not use. When a user row is deleted (a factory reset's other users, or an offboarding that purges users), MemoriaHub's removal hook first deletes the user's own circles, reassigns what they added to other people's circles to each circle's owner, and **refuses** while the user owns a shared circle with other members. The job then fails with `user <id> owns N shared circle(s) with other members (...)`: transfer ownership of each circle (or remove its other members) and retry the job.

## 7. Rehearsal record

Issue #591 asks for a rehearsal on a restored production backup in a scratch database (a user purge for a test account and a factory reset, row counts before and after). Record the counts here or in the PR when it is run.
