# Local exceptions to the platform

Every place where MemoriaHub deviates from `@marinoscar/platform-*` on purpose, and the issue that removes it. Introduced by RETRO-A1 (#568, epic [#555](https://github.com/marinoscar/MemoriaHub/issues/555)). An exception without a row here is a bug.

A4 (#579) adds the first shim row; A5 (#587) adds the first database deviation.

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
| (none yet) | | | | |

## Code shims (`PLATFORM-ADOPTION-SHIM`)

| Shim | Where | What it does | Removed by |
|---|---|---|---|
| Platform-schema stub + legacy fragments (RETRO-A4) | `apps/api/prisma/platform-schema-stub/base.prisma`; `apps/api/prisma/fragments/platform-*.legacy.prisma` (header `PLATFORM-ADOPTION-SHIM`); `db:compose` passes `--platform-schema prisma/platform-schema-stub` | The stub holds only the `generator`/`datasource` blocks so no platform model is composed yet; the legacy fragments hold the models a platform slice will replace | Stub: RETRO-B2 (composes the real platform schema). Fragments: identity B2, settings B2/B3, credentials B4/E3, jobs C1, nodes C2, storage D1, notifications D3, db-backup D4, android D5 |

## Standing constraints

Rules that hold for the whole program and are not exceptions:

- An installed migration is never edited or renamed; comments inside `migration.sql` count.
- Raw-SQL partial unique indexes (`jobs_active_dedup_uniq_idx`, `database_backup_runs_active_uniq_idx`, `notifications_review_queue_live_uniq_idx`, `android_app_releases_one_current_uniq_idx`, and the others the platform lists in `raw-sql-indexes.json`) are intentional schema drift and are never replaced by `@unique`.
- Job `type` strings, notification keys and storage key prefixes are permanent.
- Generated files (`prisma/schema/`, generated `infra/`, `.env.example`) are never hand-edited.
- At most one open PR carries a migration at a time (`migration-lock`).
