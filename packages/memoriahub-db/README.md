# @marinoscar/memoriahub-db

The database side of the MemoriaHub domain: the Prisma schema fragments, the SQL migrations, the inventory of what Prisma cannot express, and the `memoriahub-db` command that installs them into an app and proves the installed copies unchanged. CommonJS.

## Purpose and scope

The domain Prisma fragments (`schema/memoriahub.<slice>.prisma` for `library`, `media`, `metadata`, `face`, `tagging`, `memories`, `workflows`, `review`, `dedup`, `location`, `enhancement`, `social`, `trash`, `mediasync`, `backup`, `insights`, plus `ownership` and `identity`, which hold the `extend model` back-relations onto the platform's `User`, `Organization`, `Group` and `StorageObject`), the migrations (`migrations/<id>/migration.sql` plus `migrations/manifest.json`), the inventories (`raw-sql-indexes.json`, `extensions.json`, `schema-objects.json`) and the `memoriahub-db` command: `sync` copies fragments (and, on a host with no MemoriaHub history, the baseline migration) into a host app and writes `prisma/memoriahub.lock`, `check` proves every copy byte-identical (`check --database` also checks a live database), `promote` moves a migration authored in the app into the package. It does not own the platform tables (`users`, `organizations`, `groups`, `storage_objects`, `worker_nodes`, `personal_access_tokens`, ...), which are `@marinoscar/platform-db`'s, nor the app-owned legacy and side tables (`mh_legacy_*`, `user_profiles`, the legacy credential tables), and it changes no table: this is a relocation.

Status: complete for the domain as it stands at RETRO-J3 (#606). The package is private (`UNLICENSED`) and nothing is published.

Why a command and not a plain import: `platform db compose` reads exactly one app fragment folder and `platform db sync` installs migrations only from the platform package, so a second fragment and migration source needs a bridge. `memoriahub-db sync` copies the fragments into the app's `prisma/fragments` and the migrations into `prisma/migrations`; the platform then sees them as app fragments and app migrations.

**The baseline.** The web app built the domain through 130 historic migrations (platform tables included) that are tangled with the legacy platform tables and with `circles`, which no longer exist, so replaying them on a new host would not work. The package therefore ships ONE migration, `20261110200000_domain_baseline`, that creates the whole domain in its final state (enums, four functions, 40 tables with their constraints, indexes, triggers and row-level-security policies). `sync` decides per host:

- A host whose `prisma/migrations` already holds `20260610000000_add_media_domain` (the web app, and any database that ran its history) **adopts** the baseline: it is recorded in `memoriahub.lock` as `{ adopted: true, installedDir: null }`, no directory is written and no database ever runs it, so existing deployments need no `migrate resolve` and no SQL.
- Any other host **installs** it as an ordinary migration (name policy below) and runs it after the platform's migrations.

`test/apply.db.test.ts` proves the two paths build the same domain schema (every column, constraint, index, trigger, policy, enum and function equal).

- `@marinoscar/memoriahub-db`: the package root, which re-exports every slice (the `memoriahub-db` bin runs the `bin` slice). Slice READMEs: [bin](src/bin/README.md), [sync](src/sync/README.md), [check](src/check/README.md), [promote](src/promote/README.md), [lock](src/lock/README.md), [manifest](src/manifest/README.md), [sql](src/sql/README.md).

## Install and peer dependencies

```bash
npm install --save-dev @marinoscar/memoriahub-db
```

| Package | Range | Needed by |
|---|---|---|
| `prisma` | `^7.8.0` | `bin` (required) |

`commander` is a dependency (the command line). `check --database` also needs `pg`, resolved at run time from the app; it is not declared as a peer because the offline commands never use it. The per-slice data is `packages/memoriahub-slice-peers.json`.

## Quick start

In a host that already composes the platform schema (`platform db sync`, `platform db compose`):

```bash
npx memoriahub-db sync                # fragments, the baseline (adopted or installed), prisma/memoriahub.lock, platform.lock
npx platform db compose               # the app's db:compose script runs both, in this order
npx memoriahub-db check               # every copy is byte-identical to the package
DATABASE_URL=postgres://... npx memoriahub-db check --database
```

## Configuration

| Command | Options |
|---|---|
| `memoriahub-db sync` | `--root <dir>` the app folder that holds `prisma/` (default: the current directory); `--fragments <dir>` and `--migrations <dir>` the package folders to install from; `--names original\|stable\|after-host` (`after-host` is deprecated); `--baseline auto\|adopt\|install`; `--dry-run` |
| `memoriahub-db check` | `--root <dir>`; `--database` also checks the database named by `DATABASE_URL` |
| `memoriahub-db promote <localDir>` | `--id <slug>` (required), `--slice <slice>` (required), `--root <dir>` |

Exit codes: 0 ok, 1 a failed check or a refusal (a host model is missing, an installed migration differs from the package, a lock entry disagrees), 2 a usage error or a missing `DATABASE_URL`.

What `sync` does:

- Copies each `schema/memoriahub.<slice>.prisma` to `<root>/prisma/fragments/memoriahub.<slice>.prisma` under the header `// GENERATED by memoriahub-db sync — do not edit` and `// source: @marinoscar/memoriahub-db:schema/<file>` (the header carries no version, so a version bump never makes a copy stale). Removes `memoriahub.*.prisma` files the package no longer has.
- Installs every manifest migration missing from `prisma/memoriahub.lock` into `prisma/migrations/` (adopting a directory that already exists under the original name when its bytes are identical, refusing it when they are not), or adopts the baseline as described above.
- Writes `prisma/memoriahub.lock` (`{ lockVersion: 1, memoriahubDbVersion, migrations: [{ originId: "memoriahub:<id>", installedDir, sha256, adopted? }] }`).
- Merges `raw-sql-indexes.json` into `prisma/platform.lock` `rawSqlIndexes` (adds missing names; refuses with exit 1 when a name is listed with another definition) and appends the installed directories to `appMigrations`.
- Refuses when the host schema lacks `User`, `Organization`, `Group`, `StorageObject`, `WorkerNode` or `PersonalAccessToken`.

## Extension-point catalog

None. The package has no host-implemented interface; a host consumes its files. One seam runs the other way: `Person` is marked `// @extensible`, so an app model that points at it (the web app's `user_profiles` side table) adds its back-relation with `extend model Person { ... }` in an app fragment instead of the domain naming an app model.

## Data

Tables the fragments declare (the baseline creates them; the host provides `users`, `organizations`, `groups`, `storage_objects`, `worker_nodes` and `personal_access_tokens`, which the foreign keys reference, and `organizations` must hold the default row `mh_default_org_id()` reads):

| Slice | Tables |
|---|---|
| `library` | `personal_libraries` |
| `media` | `media_items`, `media_item_embedding`, `media_visual_embedding` (SQL only), `albums`, `album_items`, `tags`, `media_tags` |
| `insights` | `insights_snapshots` |
| `metadata` | `media_metadata_status`, `media_geocode_status` |
| `face` | `people`, `faces`, `media_face_status` |
| `tagging` | `tag_labels`, `media_tag_status`, `media_transcripts` |
| `memories` | `memories`, `memory_items`, `memory_user_state` |
| `workflows` | `workflows`, `workflow_runs`, `workflow_run_items` |
| `review` | `review_runs`, `review_run_items` |
| `dedup` | `burst_groups`, `duplicate_groups` |
| `location` | `location_suggestions`, `location_groups`, `location_group_aliases` |
| `enhancement` | `media_enhancements`, `media_enhancement_batches` |
| `social` | `media_social_status` |
| `trash` | `trash_empty_runs`, `trash_empty_run_items` |
| `mediasync` | `media_sync_devices`, `media_sync_runs`, `media_sync_diagnostic_reports` |
| `backup` | `node_backup_configs`, `node_backup_runs` |

Extensions (`extensions.json`; the bootstrap superuser creates them, this package never does): `vector` (0.5.0 or newer; `face`, `media`). A database without `vector` must fail loudly at the baseline, not get it created silently by a role that may lack the privilege; `memoriahub-db check --database` prints the exact `CREATE EXTENSION IF NOT EXISTS vector;` for an operator to run as a superuser.

Raw-SQL objects (`raw-sql-indexes.json`: 15 indexes with the `pg_indexes.indexdef` text `platform db drift` asserts; `schema-objects.json`: the rest). They exist only in `migration.sql`, are intentional schema drift, and are never declared in a fragment (no `@@unique`, `@@index` or `@unique` under their name or, for a unique one, on their columns):

| Kind | Objects |
|---|---|
| HNSW (`vector_cosine_ops`) | `faces_embedding_vec_hnsw_idx`, `faces_embedding_vec_archive_hnsw_idx`, `faces_embedding_vec_assigned_hnsw_idx`, `media_item_embedding_hnsw_idx`, `media_visual_embedding_hnsw_idx` |
| Partial and expression b-trees | `media_items_gallery_idx`, `media_items_map_locations_idx`, `idx_media_circle_device_captured`, `media_items_captured_md_idx`, `media_items_circle_captured_md_idx`, `people_circle_id_hidden_at_idx` |
| Partial unique indexes | `media_items_circle_content_hash_active_key`, `review_run_items_run_id_burst_group_id_key`, `review_run_items_run_id_duplicate_group_id_key`, `review_run_items_run_id_location_suggestion_id_key` |
| Functions | `face_embedding_to_vector`, `faces_sync_embedding_vec`, `mh_default_org_id`, `mh_content_owner_from_scope` |
| Triggers | `faces_sync_embedding_vec_insert_trigger`, `faces_sync_embedding_vec_update_trigger` (keep `faces.embedding_vec` in step with `embedding`), and `mh_owner_from_scope` on each of 21 content tables (calls `mh_content_owner_from_scope`, which derives the owner columns from the scope id) |
| CHECK constraints | the `<table>_one_owner_check` constraints (exactly one of `owner_group_id` and `owner_user_id`), the `review_run_items` exclusive-arc constraints, and `media_sync_devices_name_length_chk` / `media_sync_runs_counts_chk` |

Row-level security: every content table forces RLS on `org_id` with a `<table>_org_isolation` policy; the policies are part of the baseline and are listed in the app's `platform.lock` `rlsPolicies`.

Files in the app: `prisma/fragments/memoriahub.<slice>.prisma` (generated copies), any installed migration directories, `prisma/memoriahub.lock`, and the merged entries of `prisma/platform.lock`.

## Permissions and settings

None. The package declares no permission string and no settings key.

## UI

None.

## Infra

None. The package creates no database role and no extension; the bootstrap superuser creates `vector`, and the application role must own the tables the migrations create (it is never a superuser, so row-level security applies).

## Observability

None. The command prints one line per action and one `CODE  message` line per problem on standard error.

## Security notes

`sync` and `check` read and write files only; `check --database` runs `SELECT`s against catalogs (`pg_extension`, `pg_indexes`, `pg_trigger`, `pg_proc`, `pg_constraint`, `information_schema.columns`) and never creates, drops or renames anything. A missing extension is reported, never created. An installed migration is never edited, renamed or overwritten: `sync` refuses a directory whose bytes differ from the package, and comments count toward the hash, so exclude `**/migration.sql` from any formatter or comment clean-up. No fragment or migration holds a secret. Do not run `prisma format` on the generated `memoriahub.*.prisma` copies: they must stay byte-identical to the package.

## Conformance suite

`memoriahub-db check` is the executable proof that the installed copies match the package; `memoriahub-db check --database` proves the database holds the extension and the raw-SQL objects. The package tests (`npm run test:run -w @marinoscar/memoriahub-db`) cover the manifest hashes, the raw-SQL index tripwire, `sync` into a fixture host (history host and fresh host, both naming policies), `check` failing on a one-byte change, and `promote`; `test/apply.db.test.ts` runs only when `DATABASE_URL` names a PostgreSQL 16 server with pgvector and a role that may create databases: it builds the platform history plus the baseline on one database and the web app's whole history on another, runs `check --database` on both and compares the two domain schemas object by object (`scripts/memoriahub-packages/compare-domain-schema.mjs`).

## Upgrade notes

Naming policy, chosen per host by `--names` or by the rule below:

- `original` keeps the package directory name. It is for a host whose databases already ran the migrations under those names, such as the web app: production databases have the original names in `_prisma_migrations`, so an installed migration is never renamed. Default when `prisma/memoriahub.lock` records original names or only an adopted baseline, or when the host already holds the history the baseline is adopted by.
- `stable` names a migration `<the id's 14-digit timestamp>_memoriahub_<slug>` (`20261110200000_domain_baseline` becomes `20261110200000_memoriahub_domain_baseline`), a pure function of the package migration id. Default on a host with no MemoriaHub history. The package ids are dated November 2026, so such a host pins `platform db sync --timestamp 2024-01-01T00:00:00Z` to put the platform tables first.
- `after-host` (deprecated) names a migration one second after the newest directory in `prisma/migrations`; its names shift when a platform upgrade adds a migration, so a host with a lock keeps the policy the lock records.

Rule: an installed migration's folder name is a pure function of the migration; upgrades only append names, never rename one.

Adopting the web app: run `memoriahub-db sync`. The baseline is adopted, so no migration directory is written; the command creates `prisma/memoriahub.lock`, the generated fragments and (when the lock lacks them) the `platform.lock` index entries. A later package migration is installed under its original name and recorded in the lock. A migration already in the lock is never changed: a fix is a new migration (see [the runbook](../../docs/runbooks/memoriahub-domain-migration.md)).

## Troubleshooting

- `Cannot find module '../dist/bin/index.js'`: the package was not built; run `npm run build -w @marinoscar/memoriahub-db`.
- `FRAGMENT_MODIFIED`: someone edited or formatted a generated copy; run `memoriahub-db sync` to restore it and edit the package's `schema/` file instead.
- `INSTALLED_MODIFIED`: an installed `migration.sql` differs from `memoriahub.lock`, comments included. Restore it from version control; never edit an installed migration.
- `NOT_INSTALLED` or `LOCK_MISSING`: run `memoriahub-db sync`.
- `EXTENSION_MISSING`: ask a database superuser to run the `CREATE EXTENSION IF NOT EXISTS` statement the message prints.
- `the host schema does not declare model User`: run `platform db sync` and `platform db compose` first; the domain references `users`, `organizations`, `groups`, `storage_objects`, `worker_nodes` and `personal_access_tokens`.
- `platform.lock rawSqlIndexes already lists <name> with a different definition`: the app listed an index of that name itself; reconcile the lock with the package's `raw-sql-indexes.json`.

## Links

- [Package documentation standard and checks](../../docs/PACKAGES.md): how this README, the TSDoc and the catalog are checked
- [Authoring a domain migration](../../docs/runbooks/memoriahub-domain-migration.md): edit a fragment, create the migration, `memoriahub-db promote`
- [Release runbook](../../docs/runbooks/release-memoriahub-packages.md): versions and the (closed) publish gate
- [DEVELOPMENT.md](../../docs/DEVELOPMENT.md): build, test and lint commands
