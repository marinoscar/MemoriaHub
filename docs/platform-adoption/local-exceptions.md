# Local exceptions to the platform

Every place where MemoriaHub deviates from `@marinoscar/platform-*` on purpose, and the issue that removes it. Introduced by RETRO-A1 (#568, epic [#555](https://github.com/marinoscar/MemoriaHub/issues/555)). An exception without a row here is a bug.

A4 (#579) added the first shim row; A5 (#587) added the database deviations and the `DefaultOrgId` shim.

## How to use this page

- **A shim in code** carries the comment `// PLATFORM-ADOPTION-SHIM(<issue>)`, where `<issue>` is the issue that removes it. List them all with `grep -rn "PLATFORM-ADOPTION-SHIM" apps/api/src apps/web/src apps/cli/src`.
- **A deviation in the database** is an entry under `deviations` in `apps/api/prisma/platform.lock` (created by A5).
- **The PR that removes an exception deletes its row here.** It also removes the marker and the lock deviation it names.
- A new exception adds a row in the same PR, with an issue that removes it. If no issue exists, file one.
- Platform code is never edited in this repository. A missing seam is a `seam_request.yml` in EnterpriseAppBase (app = MemoriaHub); if the work cannot wait, eject with a shim and a row below.

How the baseline treats the deviations: `docs/runbooks/database-baseline.md` in EnterpriseAppBase.

## Database deviations (declared in `platform.lock`)

| Deviation id | What differs from the platform | Where | Why | Removed by |
|---|---|---|---|---|
| `memoriahub:domain-schema` | 340 statements (in the A5 rehearsal): MemoriaHub domain tables, enums, foreign keys and indexes that platform `0001`/`0002` do not create. Not a change to a platform table. | The app-only migrations | The baseline diff prints them; the lock must declare them for `--through 2` to run clean. Also the record of the raw-SQL drift the Prisma diff cannot print: the `faces_sync_embedding_vec` trigger, the CHECK constraints (`media_shares` XOR, `review_run_items` exclusive arc, `media_sync_runs_counts_chk`, `media_sync_devices` name length) and the composite FK `review_run_items(run_id, subject_type)` | Not removed. A permanent record of what the app owns |
| `memoriahub:legacy-platform-tables` | 53 statements: the nine renamed tables (`mh_legacy_notifications`, `mh_legacy_push_subscriptions`, `mh_legacy_notification_deliveries`, `mh_legacy_notification_broadcasts`, `mh_legacy_job_stats_rollup`, `mh_legacy_worker_nodes`, `mh_legacy_node_credentials`, `mh_legacy_database_backup_runs`, `mh_legacy_android_app_releases`), the seven `MhLegacy*` enums and the foreign keys to `users` | Migration `20260817000000_rename_legacy_platform_tables`; `apps/api/prisma/fragments/platform-*.legacy.prisma` (`@@map`) | The platform migrations `0003`-`0040` create tables, types and indexes with the same names; the old ones were renamed so they apply onto an empty namespace. Platform tables exist empty beside the legacy tables until each slice moves its data | Piecewise, each slice dropping its legacy table and its statements: RETRO-C1 (`job_stats_rollup`), C2 (`worker_nodes`, `node_credentials`), D3 (`notifications`, `push_subscriptions`, `notification_deliveries`, `notification_broadcasts`), D4 (`database_backup_runs`), D5 (`android_app_releases`) |
| `memoriahub:users-avatar` | `users.avatar_source`, `avatar_storage_key`, `avatar_version`, `linked_person_id`, `users_linked_person_id_idx` and `users_linked_person_id_fkey` (3 statements) | Migration `20260810010000_add_user_avatar_source_and_person_link` | Profile-picture feature (issue #354) added columns to a platform table | RETRO-B2 (moves them to an app-owned side table) |
| Raw-SQL index list in `platform.lock` (`rawSqlIndexes`, 20 entries) | Partial, expression and HNSW indexes Prisma cannot declare | `apps/api/prisma/platform.lock` | B4 asserts them by name and definition; the list is the single source (CLAUDE.md invariant). The three `mh_legacy_*` entries leave with their slice (D3, D4, D5); `enrichment_jobs_*` entries with C1 | Per slice, as above |

## Code shims (`PLATFORM-ADOPTION-SHIM`)

| Shim | Where | What it does | Removed by |
|---|---|---|---|
| Platform-schema stub + legacy fragments (RETRO-A4) | `apps/api/prisma/platform-schema-stub/base.prisma`; `apps/api/prisma/fragments/platform-*.legacy.prisma` (header `PLATFORM-ADOPTION-SHIM`); `db:compose` passes `--platform-schema prisma/platform-schema-stub` | The stub holds only the `generator`/`datasource` blocks so no platform model is composed yet; the legacy fragments hold the models a platform slice will replace | Stub: RETRO-B2 (composes the real platform schema). Fragments: identity B2, settings B2/B3, credentials B4/E3, jobs C1, nodes C2, storage D1, notifications D3, db-backup D4, android D5 |
| Legacy argument translation (RETRO-F3) | `apps/cli/src/extensions/legacy-flags.ts` | One pure rule table: `--no-color`, `-V`, the `node` group, deploy env/default flags | `node-group` rule: RETRO-C10; the rest stays until the 1.3 spellings are retired |
| `node` command intercept and `node list` (RETRO-F3) | `legacy-flags.ts` (`node-group`), `apps/cli/src/run.ts` (`runLegacyNodeGroup`) | The platform `node` is a reserved built-in; `memoriahub node ...` runs the 1.3 command (which has `node list`, the platform lacks it) | RETRO-C10 (executors on the platform engine; `node list` upstream via seam request) |
| Legacy TUI bridge (RETRO-F3) | `apps/cli/src/extensions/legacy-tui*.ts(x)`, `apps/cli/src/commands/menu.ts` | "MemoriaHub menu" platform TUI screen and `memoriahub menu` open the 1.3 ink TUI | RETRO-F4 |
| Config shape bridge (RETRO-F3) | `apps/cli/src/extensions/config-compat.ts`, `apps/cli/src/config.ts` | `pat`/`patExpiresAt` migrated to `token`/`expiresAt`; app fields restored after the platform `login`; credentials copied to `MEMORIAHUB_STATE_DIR` | Platform honours `MEMORIAHUB_STATE_DIR` for `login`/`config`/`api` (seam request) |
| `DefaultOrgId` + `orgId` on the legacy storage models (RETRO-A5) | `apps/api/src/common/tenancy/default-org-id.ts`; `StorageObject.orgId` / `StorageObjectChunk.orgId` in `apps/api/prisma/fragments/platform-storage.legacy.prisma`; every `storageObject` / `storageObjectChunk` create or upsert in `src/` (marked `PLATFORM-ADOPTION-SHIM(RETRO-D1)`) | Platform migration `0025` made `storage_objects.org_id` and `storage_object_chunks.org_id` NOT NULL with forced row-level security. The legacy storage code stamps the default organization's id on every row it writes | RETRO-D1 (storage slice) |
| API connects as the bootstrap superuser (RETRO-A5) | `apps/api/src/config`, `infra/compose/postgres-init/10-app-role.sh`, [application-role.md](../runbooks/application-role.md) | Row-level security is inert for a superuser. The `memoriahub_app` role exists and is documented, but the API does not use it: the legacy storage service reads `storage_objects` without `app.org_id`, which returns 0 rows under RLS. Doctor `db.rls_role` fails until the switch | RETRO-D1 (brings `forOrg`/`runInOrg` for storage), then the switch in the A6/B-series release |
| Hidden `push_subscriptions` directory during the baseline (RETRO-A5) | [database-baseline.md](../runbooks/database-baseline.md) section 5 | `20260814000000_add_push_subscriptions` matches platform `0007` after comment stripping; the tool then refuses (`PLACEMENT_IMPOSSIBLE`) and would never create the platform table. The baseline is run against a temporary copy of `apps/api` without that directory | Not removed (a one-off procedure); the owner should file a `seam_request.yml` for a "leave this directory unmatched" `--map` entry |

## Infra deviations (RETRO-F2, #566)

These are not code shims and not database deviations: each is an overlay or a file in `infra/` that differs from the platform default on purpose. The reason is the important part; the removal condition says when the row can go.

| Deviation | Where | Why | Removed by |
|---|---|---|---|
| Production web container listens on 5173 (the platform's convention), not 80 | `infra/compose/app.prod.web-listen.compose.yml` | The generated `nginx.conf` proxies to `web:5173` in every mode; `apps/web/Dockerfile`'s production stage serves on 80. The overlay rewrites `listen 80;` at start-up and fails if the line changed. | Move `apps/web/nginx.conf` and the Dockerfile `EXPOSE` to 5173 (an `apps/` change; then delete the overlay). |
| `geolocation=(self)` in Permissions-Policy (platform default `()`) | `infra/nginx/app.d/permissions-policy.conf` | `LocationPickerMap` and `MapControls` call `navigator.geolocation`. | Not removed: this is the app's permission. |
| Server-level `client_max_body_size 10g` | `infra/nginx/app.d/server/body-size.conf` | `POST /api/storage/objects` (single-request upload) accepts up to `MAX_FILE_SIZE` = 10 GiB. A lower nginx default would cap it at 1 MB. The part-upload and APK routes narrow their own limits. | Retire the single-request upload path, then narrow the server limit to the two large routes. |
| Stack agent disabled | `infra/compose/app.vps.no-stack-agent.compose.yml` | The app does not use the Docker-socket holder; the hand-written VPS files never ran it. | Not removed: revisit if the admin UI needs to redeploy telemetry. |
| Worker variables renamed for the MemoriaHub CLI | `infra/compose/app.worker.memoriahub.compose.yml` | The generated `worker.compose.yml` names the platform engine's variables (`MEMORIAHUB_SERVER_URL`, `MEMORIAHUB_HEAP_LIMIT_MB`, ...). The worker CLI reads `MEMORIAHUB_URL`, `MEMORIAHUB_HEADLESS=1`, `MEMORIAHUB_STATE_DIR`, and so on. The bundle's service is named `worker`, not `memoriahub-worker`. | A seam request to the platform: the worker template takes the app's variable names from the identity. Until then, the overlay. |
| Worker build target `worker` | `infra/compose/app.worker.build.compose.yml` | The generated `worker.build.compose.yml` builds the `production` target; `apps/cli/Dockerfile` has only `worker`. | Add the platform target name to the app's Dockerfile, or a seam request. |
| `workerImage` set in the identity | `packages/shared/identity.json` | Without it the platform renders the `ghcr.io/OWNER/REPO-worker` placeholder. | Not removed: the identity value. |
| App environment variables restored in `app.env.example` | `infra/compose/app.env.example` | The generated template dropped about 40 MemoriaHub variables (`ENRICHMENT_*`, `FACE_*`, `GEO_*`, `DEVICE_PAT_TTL_DAYS`, the S3 keys, `DB_CONNECTION_LIMIT`, ...). The app reads them, not the platform's `JOBS_*` names. | Move the enrichment queue onto the platform jobs slice (then the `ENRICHMENT_*` names go). |
| Legacy deploy files kept | `infra/nginx/nginx.prod.conf`, root `docker-compose.worker.yml` and `docker-compose.worker.build.yml` | Existing VPS stacks created by `infra/deploy/install.sh` mount `repo/infra/nginx/nginx.prod.conf`, and fleet operators run the root worker bundle; deleting them would break the next `update.sh` / `git pull`. New installs use the generated files. | RETRO-F3 (`memoriahub deploy` replaces `infra/deploy/*.sh`), after production is migrated. |
| Uptrace stack removed | `infra/compose/otel.compose.yml` and `infra/otel/uptrace.yml` (deleted) | The generated collector config replaced the Uptrace exporter, so the Uptrace stack could not work any more. Telemetry is GreptimeDB through the platform telemetry fragment. | Not applicable: retired. |
| Memory limits and heap | `infra/compose/app.prod.memory-limits.compose.yml` | The platform's prod limit (512M) is too small for a bulk import. | Not removed: the app's sizing. |
| pgvector images for devdb and test | `infra/compose/app.devdb.pgvector.compose.yml`, `app.test.pgvector.compose.yml` | The platform images lack the `vector` extension the migrations need. | A platform choice of image per mode, or keep the overlays. |
| CompreFace and the models volume | `infra/compose/app.compreface.compose.yml`, `app.models-volume.compose.yml`, `app.worker.compreface.compose.yml` | Face recognition and the CLIP model are MemoriaHub services. | Not applicable: app services. |

## Standing constraints

Rules that hold for the whole program and are not exceptions:

- An installed migration is never edited or renamed; comments inside `migration.sql` count.
- Raw-SQL partial unique indexes (`jobs_active_dedup_uniq_idx`, `database_backup_runs_active_uniq_idx`, `notifications_review_queue_live_uniq_idx`, `android_app_releases_one_current_uniq_idx`, and the others the platform lists in `raw-sql-indexes.json`) are intentional schema drift and are never replaced by `@unique`.
- Job `type` strings, notification keys and storage key prefixes are permanent.
- Generated files (`prisma/schema/`, generated `infra/`, `.env.example`) are never hand-edited.
- At most one open PR carries a migration at a time (`migration-lock`).
