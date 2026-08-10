# PostgreSQL Database Backup & Restore

Epic: [#339](https://github.com/marinoscar/MemoriaHub/issues/339)
Code: `apps/api/src/db-backup/` (issues #340–#344), `apps/api/src/common/maintenance/` (issue #348)
Runbook: [Database Restore](../runbooks/database-restore.md)

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Architecture](#2-architecture)
3. [Data Model](#3-data-model)
4. [Backup Engine](#4-backup-engine)
5. [Restore and Rollback (#344)](#5-restore-and-rollback-344)
6. [API](#6-api)
7. [RBAC](#7-rbac)
8. [Settings Reference](#8-settings-reference)
9. [Gotchas](#9-gotchas)
10. [Document History](#10-document-history)

---

## 1. Overview and Goals

This feature gives admins a reliable, schedulable, retained backup of MemoriaHub's own PostgreSQL database — a full logical `pg_dump`, separate from the app's existing media-file backup features, stored through the same storage-provider abstraction media objects use.

**In scope (v1):**
- Full-database logical backups via `pg_dump -Fc`, on a configurable schedule (daily/weekly/monthly + time-of-day + timezone) or triggered on demand
- Configurable retention (keep the newest N completed backups; older ones auto-pruned)
- Streaming upload through the existing storage-provider abstraction, defaulting to the active provider with an optional explicit override
- Post-upload verification (`pg_restore --list` against the uploaded bytes) before a run is marked `completed`
- Admin API: config, trigger, list/detail, download, delete, cancel
- A dedicated `docs/runbooks/database-restore.md` for manual disaster recovery when the app itself is unreachable
- In-app restore via scratch database + atomic rename swap (issue #344 — see §5)
- Admin-controlled maintenance mode (issue #348), built as a general platform feature but a hard prerequisite for #344's traffic-quiescing cutover

**Explicitly deferred (v1):**
- Point-in-time recovery / continuous WAL archiving — periodic full snapshots only
- Physical (`pg_basebackup`) backups
- Cross-region / secondary replication of backup files
- Table-level or partial restore, or selective exclusion of recomputable embedding tables
- Automated periodic restore-verification into a scratch database (cheap archive-integrity verification via `pg_restore --list` IS in scope; scheduled *test-restores* are not)
- Multi-replica-safe swap — the restore cutover assumes a single API replica (see §5.5 and §9)

**Sizing, and why it drives the whole design:** at MemoriaHub's projected scale (~240k media items), the dump is dominated not by media metadata rows but by embedding vectors — `media_item_embedding` (1536-d, ~6.2 KB/row), `media_visual_embedding` (512-d, ~2.1 KB/row), and `faces` (128-d embedding, ~1.6 KB/row, multiple rows per item). Estimated dump size: **~3–5 GB**, compressing poorly (high-entropy float vectors are near-incompressible). Two consequences fall out of this directly and explain almost every design decision below: a backup run takes **tens of minutes**, and a restore — dominated by rebuilding HNSW indexes over the restored vector data, since a logical dump stores `CREATE INDEX` statements, not index bytes — takes **far longer than the backup did**, plausibly hours.

---

## 2. Architecture

```
┌─────────────────────┐        ┌──────────────────────────┐
│ DatabaseBackupSchedule│──cron──▶│ DatabaseBackupRunnerService│
│ Task (#342)          │        │ (#341)                    │
│  - releases stale runs│        │  - claims the single-run  │
│  - fires due backups  │        │    slot (INSERT + P2002)  │
└──────────┬────────────┘        │  - spawns pg_dump          │
           │                     │  - pipes stdout → sha256    │
   POST /api/admin/db-backup/    │    metering Transform →     │
   runs (manual trigger, #343)   │    provider.upload()         │
           └────────────────────▶│  - verifies via pg_restore   │
                                 │    --list on the uploaded    │
                                 │    bytes                     │
                                 │  - writes DatabaseBackupRun  │
                                 └──────────┬────────────────┘
                                            │
                                 ┌──────────▼────────────────┐
                                 │ DatabaseBackupRetentionSvc │
                                 │ (#342) — prunes oldest      │
                                 │ completed runs past N,      │
                                 │ pre_restore runs past age   │
                                 └────────────────────────────┘

Storage: provider.upload(key, stream, opts) — S3 / R2 / local disk,
resolved via StorageProviderResolver, same abstraction as media objects.
Key convention: db-backups/<utc-timestamp>-<runId>.dump
```

### 2.1 Why NOT an `enrichment_jobs` job type

An earlier draft of this feature proposed a `database_backup` job type on the shared `enrichment_jobs` queue, following the `trash_purge`/`storage_insights` precedent used everywhere else in this codebase for background work. **That precedent is wrong for a job of this duration**, for three concrete, load-bearing reasons:

1. **`jobs.stuckThresholdMinutes` defaults to `3`** (see CLAUDE.md's Job History Retention settings). `EnrichmentAdminService.stuckRunningWhere()` flags any `running` job whose `startedAt` is older than that threshold. A 30-minute `pg_dump` is "stuck" after three minutes on default settings.
2. **A flagged job is reset to `pending` and re-claimed** by `EnrichmentStuckResetTask` (runs every 10 minutes) — starting a **second concurrent `pg_dump`** against the same database plus a second partial upload racing the first. `attempts` is charged at claim time, so this also burns `ENRICHMENT_MAX_ATTEMPTS` and can land the "job" permanently `failed` with multiple partial dumps left in flight.
3. **`ENRICHMENT_LEASE_MS` defaults to 30 minutes**, and the in-process worker has **no lease-renewal path** — only remote worker nodes renew, via `POST /api/nodes/:id/jobs/:jobId/renew`. A backup running longer than 30 minutes (routine at this feature's sizing) would trip the lease-expiry branch of the stuck-job check unconditionally, independent of the `stuckThresholdMinutes` problem above.

Raising `jobs.stuckThresholdMinutes` globally to accommodate backups is not a fix — that setting is app-wide, so tuning it to (say) 120 minutes for backups means a genuinely stuck `face_detection` job now takes two hours to auto-recover, and the 30-minute lease-expiry branch would still fire regardless. Actually fixing it would mean adding in-process lease heartbeats to `EnrichmentJobWorker` — modifying the app's most load-bearing shared service for the sake of one job type whose entire purpose is reliability.

### 2.2 The right precedent: `NodeBackupRun`, not `trash_purge`

This codebase already solved *exactly this problem* once — a long-running background task needing a single-active-run guard that must survive a crash without either duplicating work or blocking forever — and deliberately did **not** put it on the enrichment queue: `NodeBackupRun` (Local Media Backup, epic #308) uses a dedicated run table with a `lastAckAt` heartbeat, a `backup.runStaleMinutes` staleness window, and `NodeBackupStaleTask` (a 10-minute cron) whose whole purpose is releasing the single-active-run guard a crashed process would otherwise hold forever.

- **Short, bounded, global sweeps** (`trash_purge`, `storage_insights`, `notification_purge`) → the `enrichment_jobs` queue. They finish in seconds to a few minutes and the queue's retry/backoff machinery is the right fit.
- **Long-running work needing its own progress and concurrency guard** (`NodeBackupRun`/`NodeBackupStaleTask`, and now `DatabaseBackupRun`/`DatabaseBackupScheduleTask`) → **its own dedicated run table**, deliberately outside the queue.

Further precedent for self-driven work living outside the queue entirely: `NotificationReconcileTask` and `ShareExpiringTask` both also do their work in-process rather than enqueuing a job row.

**Resulting architecture:** `DatabaseBackupRunnerService` (invoked by `DatabaseBackupScheduleTask`'s cron or the manual `POST /api/admin/db-backup/runs` endpoint) drives the run; `DatabaseBackupRun` is the state machine. A raw-SQL partial unique index on `(status) WHERE status IN ('pending','running')` is the multi-replica-safe concurrency guard (§3.2); a `lastHeartbeatAt` liveness clock distinguishes "slow but alive" from "dead," which a fixed timeout alone cannot do; and `DatabaseBackupScheduleTask`'s 10-minute staleness sweep releases orphaned runs. The tradeoff, documented and accepted: run history for database backups does not appear in the shared `/admin/settings/jobs` dashboard — this feature gets its own admin API surface instead (`/api/admin/db-backup/*`, §6), with a dedicated admin UI page still pending (issue #345, not covered by this document). Note `/admin/settings/backup` is already taken by the unrelated Local Media Backup feature — see [CLAUDE.md's disambiguation table](../../CLAUDE.md) for how the three similarly-named backup features are kept apart.

### 2.3 Storage

Resolved via `StorageProviderResolver` — **never** hardcoded to local disk, unlike the older media-backup feature (`apps/api/src/jobs/backup/`, which always writes to `BACKUP_LOCAL_PATH` on the API server's own disk). Database backups default to the **active** storage provider, with an optional explicit override (`databaseBackup.storageProvider`): when the active provider is `local`, an admin can point database backups at S3/R2 instead so the dump doesn't land on the same disk as the database it's protecting.

Key convention: `db-backups/<utc-timestamp>-<runId>.dump` (see `buildStorageKey` in `database-backup-runner.service.ts`). The leading timestamp makes a raw bucket listing chronologically sortable without the database — which matters specifically during disaster recovery, when the app (and its `database_backup_runs` table) may be unavailable; see the [runbook §1.2](../runbooks/database-restore.md#12-directly-from-the-storage-provider-app-is-down).

**Streaming is a hard requirement, not an optimization.** `pg_dump` writes its archive to stdout (no `-f` flag); that stream is piped, with backpressure, straight into `provider.upload(key, stream, options)`. The archive is **never materialized in memory or on local disk** — see §4.2 for the exact mechanism.

---

## 3. Data Model

### 3.1 `DatabaseBackupRun`

One row per backup **or restore** attempt — the restore-audit fields (below) live on the same row as the backup they describe, rather than a separate table, because a restore is always defined in terms of exactly one backup; a join would buy nothing a nullable column group doesn't already give for free.

```
model DatabaseBackupRun {
  id      Uuid
  status  DatabaseBackupStatus   // pending | running | completed | failed | stale
  trigger DatabaseBackupTrigger  // manual | scheduled | pre_restore

  startedAt / finishedAt / lastHeartbeatAt   DateTime?

  bytesWritten  BigInt @default(0)   // live progress, updated by the heartbeat
  sizeBytes     BigInt?              // final size, set once at completion

  storageProvider / storageKey / bucket / format / checksumSha256   // where + what

  dbVersion / appVersion / migrationName   String?   // audit: what produced this dump

  verifiedAt   DateTime?   // set only after pg_restore --list succeeds
  lastError    String?

  createdById   User?   // who triggered a manual run; null for scheduled/system

  // Restore-audit fields — populated ONLY once this backup is later used to
  // drive a restore (#344). Nullable; absent on an ordinary backup row.
  restoreStatus / restoreError / restoredAt / restoredById
  restoreScratchDb / restoreOldDb / swappedAt
  preRestoreBackupId   DatabaseBackupRun?   // self-relation, see §3.3
}
```

**Byte fields are Prisma `BigInt`.** Every response maps `sizeBytes`/`bytesWritten` explicitly to strings before returning them — a raw Prisma row thrown straight into a JSON response throws `Do not know how to serialize a BigInt` at runtime, while an object-comparison unit test that never actually serializes the response would pass anyway. See the BigInt gotcha in CLAUDE.md's Gotchas section; the admin service's specs JSON-serialize a real response specifically to catch this class of bug.

### 3.2 The single-active-run guard: heartbeat + partial unique index, not enrichment-queue recovery

Two mechanisms work together, and both exist for the reason detailed in §2.1 — the enrichment queue's stuck-job recovery is actively wrong for a job of this duration, so this feature builds its own equivalent from scratch:

1. **The partial unique index**, `database_backup_runs_active_uniq_idx` on `(status) WHERE status IN ('pending','running')` (raw SQL — not representable in Prisma's schema DSL, the same precedent as `notifications_review_queue_live_uniq_idx` and `media_items_gallery_idx`). Claiming a run is an `INSERT ... status='running'`; if another run already holds the slot, Postgres itself rejects the second insert with a `P2002` conflict — **the database, not a process-local flag, decides who wins**, which is what makes the guard hold across replicas without any coordination protocol. `DatabaseBackupRunnerService.claimRun` catches the P2002 and rethrows it as the typed `DatabaseBackupAlreadyRunningError`, carrying the id of whichever run is already holding the slot; `db-backup.controller.ts` turns that into an HTTP 409.

2. **The `lastHeartbeatAt` liveness clock.** While the dump streams, `DatabaseBackupRunnerService.startHeartbeat` refreshes `lastHeartbeatAt` and `bytesWritten` on a timer (`DB_BACKUP_HEARTBEAT_MS`, default 20s) — kept well under `databaseBackup.runStaleMinutes`'s minimum (5 minutes) so a genuinely alive run is never mistakenly swept. Every 10 minutes, `DatabaseBackupScheduleTask.releaseStaleRuns` marks any `running` row whose `lastHeartbeatAt` (or, for a zombie row that never got a first heartbeat, `startedAt`) has fallen outside `databaseBackup.runStaleMinutes` as `stale`, best-effort deletes its partial storage object, and — critically — **releases the partial-unique-index slot** so the schedule can fire the next backup.

**Why a fixed timeout alone cannot do this job:** a fixed threshold has to pick between "too short" (kills a legitimately-still-running 40-minute dump, exactly the enrichment-queue failure mode this whole feature exists to avoid) and "too long" (a genuinely dead run blocks every future backup for that long). A heartbeat sidesteps the tradeoff entirely: a run gets to run as long as it needs to, as long as it keeps proving it's alive every 20 seconds; only genuine silence — the process died, the connection dropped, an OOM kill — trips the staleness sweep. This is the identical design `NodeBackupRun`/`NodeBackupStaleTask` already uses for exactly the same class of problem (see §2.2).

**A stale run is deliberately terminal, never auto-requeued.** Unlike the enrichment queue's stuck-reset (which resets a job back to `pending` for automatic re-claim), a stale database backup is left `stale` and is *not* automatically restarted. Automatically re-running a multi-GB dump that just silently died — quite possibly because it OOM-killed the API process — is not obviously the right thing to do without a human looking at why it died first; the next regularly scheduled backup is the natural, bounded retry.

### 3.3 The two rollback modes and their tradeoff

`databaseBackup.restoreRollbackMode` (`retain_database` | `pre_restore_dump`) governs what #344's restore keeps around as an undo path — see §5.4 for the mechanics. The tradeoff, stated once here since it's referenced from both the setting and the runbook:

| Mode | What survives a restore | Rollback time | Extra disk cost |
|---|---|---|---|
| `retain_database` (default) | The pre-restore live database, renamed to `memoriahub_old_<suffix>` (never dropped automatically — an admin/operator drops it manually once satisfied) | Seconds — a rename pair, identical to the forward swap | ~2× the live database's Postgres storage, for as long as the old database is kept |
| `pre_restore_dump` | A fresh `pg_dump` taken immediately before the restore begins (`trigger='pre_restore'`, tracked via `preRestoreBackupId` on the run being restored FROM — see §3.1's self-relation) | Hours — a full restore of that pre-restore dump, the same cost profile as any other restore | None beyond ordinary backup-artifact storage; no second live Postgres database ever exists at once |

`pre_restore` runs are retained on their own age-based clock (`databaseBackup.oldDatabaseRetentionHours`), **exempt** from the ordinary count-based retention rule (§4.3) — evicting a rollback dump because seven nightly backups happened to run since the restore it protects would silently destroy a recovery path while the restore is still fresh.

---

## 4. Backup Engine

### 4.1 `pg_dump` invocation

`buildPgDumpArgs` (`apps/api/src/db-backup/pg-dump.util.ts`):

```
pg_dump -Fc --no-owner --no-acl -Z <compressionLevel> \
  -h <host> -p <port> -U <user> -d <database>
```

- **`-Fc`** — the custom archive format. This is the *only* `pg_dump` output format `pg_restore` can reorder and parallelize (`-j N`) on restore, and it produces a single file rather than a directory (`-Fd`) — both properties the backup engine and the restore runbook depend on.
- **`--no-owner --no-acl`** — ownership and GRANTs are re-established by whatever role owns the restore target, not baked in from the source; without this a cross-host restore (a different Postgres instance, a different role name) fails outright.
- **`-Z <compressionLevel>`** — `databaseBackup.compressionLevel`, defaulting to **1**, deliberately low. Float embedding vectors dominate the dump's bytes (§1) and are near-incompressible high-entropy data; a high zlib compression level burns real CPU time on the dump for negligible size reduction.
- No `-f` (output file) — with none given, `pg_dump` writes the archive to **stdout**, which is precisely what allows it to be piped straight into storage rather than written to a local file first.

**Security: `PGPASSWORD` is passed via the child process's environment, never as an argv element.** Process argv is world-readable via `ps`/`/proc/<pid>/cmdline` to every other user on the host; a `--password=...`-style flag would leak the database credential locally. This is enforced as an actual assertion in `pg-dump.util.spec.ts`, not just a comment.

### 4.2 Streaming contract: never buffered

The load-bearing property of `DatabaseBackupRunnerService.dumpAndUpload` is that the archive is **never materialized in memory** — no `.toBuffer()`, no chunk array, no `await streamToString`. The pipeline is:

```
pg_dump (stdout)
  → Transform (pass-through: hash.update(chunk) + bytes += chunk.length, then re-emits the chunk unmodified)
  → provider.upload(key, stream, options)   // backpressure-respecting
```

The sha256 checksum and the total byte count are both computed on this **same single pass** through a pass-through `Transform` stream — the checksum costs no second read of a multi-gigabyte archive. `Promise.all([uploadPromise, dump.done])` waits on both the upload finishing *and* the `pg_dump` process exiting cleanly — either one failing (a truncated stream the upload accepted, or a non-zero `pg_dump` exit after the last byte was already accepted) tears the other down and fails the run.

### 4.3 Verification before completion: `pg_restore --list` on the UPLOADED bytes

Before a run is ever marked `completed`, `verifyUploadedArchive` **downloads the object it just uploaded** and streams it through `pg_restore --list`, reading stdin. A clean exit (with a non-empty table-of-contents listing) proves the *uploaded* bytes — not the local `pg_dump` stream, which already succeeded by definition if execution reached this point — parse as a complete, well-formed custom-format archive. This is deliberately checking the round-trip through storage, not `pg_dump` itself: the failure mode being guarded against is corruption or truncation **in transit or at rest**, which a check on the local stream alone cannot catch. "A backup that silently isn't restorable is worse than no backup" — the whole point of this step, worth a rounding-error's cost next to producing the multi-GB dump in the first place.

Only after verification succeeds does the run write `status='completed'`, `verifiedAt`, `sizeBytes`, `checksumSha256`, `dbVersion` (`SELECT version()`), and `migrationName` (the latest applied migration from `_prisma_migrations` — recorded specifically so a later restore attempt can be checked against the schema version the running application code actually expects; see the runbook's [migration-state-drift section](../runbooks/database-restore.md#7-migration-state-drift)).

### 4.4 Retention pruning

`DatabaseBackupRetentionService.pruneAfterSuccessfulRun` runs immediately after each successful backup completes — not on a separate schedule — which is what keeps the storage high-water mark at `retentionCount + 1` rather than letting it drift. Two independent rules, as detailed in §3.3:

1. **Count-based**, over `completed` runs excluding `trigger='pre_restore'`: keep the newest `databaseBackup.retentionCount` (default 7), delete the rest, oldest-first (so a partial failure partway through pruning still leaves the newest N-ish backups intact).
2. **Age-based**, over `completed` `trigger='pre_restore'` runs only: delete once older than `databaseBackup.oldDatabaseRetentionHours` (default 168h / 7 days).

Both rules delete the storage object **before** the database row, never the reverse — a failure between the two steps must leave an orphaned *row* (visible in the admin UI, still prunable next run) rather than an orphaned multi-GB *object* nothing points at and nobody can find. Pruning is entirely best-effort and never throws into the calling backup run: the backup already exists and is verified by the time pruning runs, so a missed prune costs storage, not correctness.

### 4.5 Scheduling

`DatabaseBackupScheduleTask` ticks every 10 minutes (`@Cron(CronExpression.EVERY_10_MINUTES)`), independent of `ENRICHMENT_WORKER_MODE` (it is not a queue worker and must keep running even under `ENRICHMENT_WORKER_MODE=off`); its own kill-switch is the `DB_BACKUP_SCHEDULE_ENABLED` env var, following the `THUMBNAIL_REPAIR_ENABLED`/`NOTIFICATIONS_RECONCILE_ENABLED` precedent. Each tick, in order:

1. **Release stale runs first** (§3.2) — so a run orphaned by a crash doesn't cost the schedule an extra 10-minute tick before it can resume, and so the slot is free before step 2 tries to claim it.
2. **Fire a due backup, if any.** The friendly `databaseBackup.frequency`/`dayOfWeek`/`dayOfMonth`/`timeOfDay`/`timezone` fields translate to a cron expression (`buildCronExpression`, `schedule.util.ts`); the task computes the most recent fire boundary at or before "now" (`previousFireBoundary`, a bounded backward walk since `nextCronDate` only walks forward) and starts a run **unless a run has already started at or after that boundary** — comparing against the latest run's own `startedAt`, not a separate "did we already fire" flag, is what makes exactly one run happen per boundary statelessly, with nothing to drift after a restart.

A `DatabaseBackupAlreadyRunningError` racing the schedule's own attempt to fire (another replica, or a concurrent manual trigger, won the claim) is treated as a **non-error, expected outcome** — the guard did exactly its job, and the backup this tick wanted is already happening elsewhere.

---

## 5. Restore and Rollback (#344)

`DatabaseRestoreService` (`apps/api/src/db-backup/database-restore.service.ts`), `pg-restore.util.ts`, and `admin-connection.util.ts` are merged. This section describes the shipped implementation. The [runbook](../runbooks/database-restore.md) documents the equivalent manual procedure — still the only path when the app itself is unreachable, and the ground truth this feature automates.

### 5.1 Why in-place restore is rejected

`pg_dump` archives store `CREATE INDEX` statements, not index data — restore time is dominated by rebuilding HNSW indexes over the restored vector rows (§1), plausibly hours. That single fact rules out any restore strategy that holds the live database in a broken state for the restore's full duration.

An earlier design draft proposed `pg_restore --clean --if-exists` directly against the live database. Rejected outright, and the code contains no path that does this: `--clean` drops every object in the archive, **including `database_backup_runs` itself** — the restore would destroy the row-based record of its own progress and then replace the whole table with the catalog as it existed at backup time. You cannot record a restore's outcome inside the database currently being restored. Its failure mode compounds this: fail partway through the object-drop-and-recreate cycle, and the app can't boot (tables it needs may not exist yet), there's no admin UI (same reason), and there's no backup catalog to even see what to try next — the tool needed to recover from the failure would itself have been destroyed by the failure. See the [runbook §6](../runbooks/database-restore.md#6-why-not-pg_restore---clean---if-exists-against-the-live-database) for the full argument in operator-facing form.

### 5.2 `POST /runs/:id/restore` — pre-flight, then a detached background restore

There is **no separate, read-only pre-flight endpoint.** `POST /api/admin/db-backup/runs/:id/restore` runs the cheap pre-flight gates synchronously and returns their full report in the same response — a `guided` or `blocked` outcome (below) creates nothing: no scratch database, no rename, live data completely untouched. Only a `running` outcome starts real work, and even then the multi-hour restore is detached from the HTTP request (`void this.executeRestore(...).catch(...)`) so the caller gets an immediate response and polls `GET /runs/:id` → `restoreStatus` for progress.

Three outcomes, keyed by the response's `mode`:

- **`running`** — every gate passed (or the schema gate was explicitly overridden). The restore is now proceeding in the background: `restoreStatus` walks `restoring` → `verifying` → `swapping` → `completed` (or `failed` at any step). The response also carries `scratchDatabase`, `oldDatabase`, and the `rollbackMode` actually in force.
- **`guided`** — a **capability** gate failed: no `CREATEDB` privilege, no `vector` extension available in the cluster, or the API couldn't even open an admin connection to the maintenance database. Not an error state — the app genuinely cannot drive the restore (common on managed Postgres with a restricted role), so the response carries a ready-to-paste, fully parameterized command block (`GuidedRestorePayload.commands`) plus a link to this runbook, instead of either failing outright or proceeding unsafely. `restoreStatus` is persisted as `'guided'`.
- **`blocked`** — the schema-compatibility gate failed (the archive's recorded `migrationName` differs from the live database's latest applied migration, in either direction) and `overrideSchemaCheck` was not set. Re-send with `overrideSchemaCheck: true` for the restore-then-`prisma migrate deploy` path. `restoreStatus` is persisted as `'blocked'`. A capability gate can **never** be overridden this way — no amount of admin intent conjures a `CREATEDB` privilege the cluster doesn't grant.

**`restoreStatus` is a plain string column** (`DatabaseBackupRun.restoreStatus`, `String?`), not a Prisma enum, and moves through: `null` (never attempted) → `'guided'` | `'blocked'` | `'restoring'` → `'verifying'` → `'swapping'` → `'completed'` | `'failed'`. `guided` and `blocked` are terminal for that attempt (nothing runs in the background); `restoring`/`verifying`/`swapping` are the three non-terminal states that hold the single-active-restore slot (`assertNoRestoreInProgress` — a second `POST /runs/:id/restore` while one of these three is set throws `DatabaseRestoreAlreadyRunningError`, mapped to 409).

### 5.3 Pre-flight gates, precisely

Evaluated in `DatabaseRestoreService.preflight`, all against the CHEAP-to-check subset — artifact bytes are downloaded and verified only once the restore is already `running` (§5.5), so a bad archive costs time, never a wasted pre-flight):

| Gate | Checks | On failure |
|---|---|---|
| `capability.createdb` | `pg_roles.rolcreatedb OR rolsuper` for the connecting role — **probed, never assumed** | `guided` |
| `capability.pgvector` | `vector` extension present in `pg_available_extensions` (the archive issues `CREATE EXTENSION vector`) | `guided` |
| `capability.admin_connection` | The admin connection to the maintenance database (`postgres` by default) itself succeeds | `guided` (implies every other capability check below it did not run) |
| `disk.free` | Free space on the Postgres data directory's filesystem (`statfs`) covers ~1× the live database for the scratch copy, plus another ~1× when `rollbackMode='retain_database'`, plus the artifact's own size, with 20% headroom | Never blocks — degrades to a `warning` when the data directory isn't visible from the API container (managed Postgres), or **automatically downgrades `rollbackMode` from `retain_database` to `pre_restore_dump`** (reported as a separate `rollback.downgraded` warning check) when disk is short in `retain_database` mode |
| `replicas.single` | Counts distinct `pg_stat_activity.client_addr` values connected to the live database — a heuristic, not a guarantee | Never blocks — `warning` only |
| `schema.compatible` | Archive's `migrationName` vs. the live database's latest applied `_prisma_migrations` row | `blocked` unless `overrideSchemaCheck: true` was passed (then `warning`); also `warning` (not `blocked`) when either migration name is unknown |
| `artifact.recorded` | Metadata-only placeholder — always `ok`; the real checksum + `pg_restore --list` check runs against the actually-downloaded bytes as the first phase of the async run, described in the check's own message | Never blocks |

Overall `status` is `guided` if ANY capability gate failed (this wins over everything else — even a schema mismatch is moot if the app can't create a scratch database at all), else `blocked` if any check is `blocked` (currently only `schema.compatible`), else `ok`.

### 5.4 Scratch database + atomic rename swap

Once pre-flight passes (`ok` or an overridden `blocked`), the restore itself is: restore into a fresh `<db>_restore_<suffix>` database in the same Postgres cluster **while the live application stays fully up and serving**, verify the restored data, then briefly quiesce traffic (via maintenance mode, §5.6) and swap the new database into place with a rename pair:

```
ALTER DATABASE memoriahub RENAME TO memoriahub_old_<suffix>;
ALTER DATABASE memoriahub_restore_<suffix> RENAME TO memoriahub;
```

Blue-green deployment needs only a second *database* here, not a second running instance. This shrinks the destructive window from "the entire multi-hour restore" to "a rename pair plus a process restart" — seconds, not hours — and the previous live database survives, renamed rather than dropped, as the rollback path (§5.7 for `retain_database` mode). This is exactly the procedure documented step-by-step, with verbatim commands, in the [runbook §3](../runbooks/database-restore.md#3-recommended-procedure-scratch-database--rename), which `DatabaseRestoreService` automates end to end, including the pre-flight capability checks the manual procedure asks a human to verify by eye.

`verifyScratchDatabase` runs four checks against the scratch database before the swap is even attempted — the `vector` extension is present, the `REQUIRED_TABLES` list (`users`, `circles`, `media_items`, `database_backup_runs`, `_prisma_migrations`) all exist, `users` has at least one row (guards against an apparently-empty restore), and no index in `pg_index` is `indisvalid = false` (a build that didn't finish — exactly the failure `--exit-on-error` should have already caught, checked again defensively). Any failure here throws before the swap runs, so the live database is never touched.

### 5.5 The restore phases, in order

`executeRestore` runs these steps sequentially, updating `restoreStatus` as it goes:

1. **Download + verify the artifact** — streams the backup object to a local temp file (`pg_restore -j N` needs a seekable file, so this cannot be a pipe like the backup side), hashing on the same pass and comparing against `checksumSha256`, then runs `pg_restore --list` against the downloaded bytes and requires a non-empty table of contents. This re-verifies what #341's backup-time check already proved once — the failure being guarded against here (bit-rot, a truncated download, a provider-side lifecycle rule) can only have happened *since* the upload.
2. **Pre-restore dump**, only when `rollbackMode='pre_restore_dump'` — reuses `DatabaseBackupRunnerService.runBackup` wholesale (`trigger='pre_restore'`) rather than a second dump implementation, and records the resulting run id on `preRestoreBackupId`.
3. **`CREATE DATABASE <scratch>`.**
4. **`pg_restore` into the scratch database** (`restoreStatus='restoring'`) — the long phase, hours on a large library.
5. **Verify** (`restoreStatus='verifying'`) — §5.4's four checks.
6. **Swap** (`restoreStatus='swapping'`) — §5.6.

A failure at any point before the swap is caught, recorded (`restoreStatus='failed'`, `restoreError` truncated to 4000 chars), and the scratch database is best-effort dropped — the live database is never touched by any of these failure paths.

### 5.6 The swap itself, and why maintenance mode is a prerequisite

The swap (`DatabaseRestoreService.swap`) is the one seconds-long destructive window, and its ordering is the whole design:

1. **Export the backup catalog** (`exportCatalog`) while the live database still answers — see §5.8.
2. **Enable maintenance mode** via the in-memory override, `allowAdmins: false`. Issue #348's `MaintenanceModeService.enable()` gained exactly this optional `{ allowAdmins?: boolean }` second-argument for the swap window: the persisted flag lives in `system_settings`, i.e. inside the database about to be renamed, so it is unreadable at exactly this moment — which is why #348 has two layers (persisted setting + in-memory override) and not one. `allowAdmins: false` is deliberate too: even an admin request would hit a database that momentarily does not exist between the two renames. #348 was built as an independent, general-purpose platform feature — separately useful for any planned upgrade requiring downtime — that #344 consumes rather than rebuilding; the dependency runs one direction only.
3. **Disconnect the Prisma pool, then `pg_terminate_backend` whatever is left** — a rename fails while any session holds the database open.
4. **Rename live → old, then scratch → live.** Between the two statements there is no `<live>`-named database at all, which is exactly why traffic must already be stopped by step 2. If the SECOND rename fails, the service renames the original back into place rather than leaving the cluster with no database under the expected name — the one genuinely dangerous moment in the whole design, handled explicitly.
5. **Re-insert the carried-over catalog** into the newly-renamed live database (§5.8).
6. **`process.exit(0)`** — the orchestrator restarts the process with a fresh connection pool. See §5.9's `restart: unless-stopped` requirement.

### 5.7 `POST /runs/:id/rollback` — the two rollback modes

`RollbackDatabaseRestoreDto` requires the literal confirmation string `"ROLLBACK"`, mirroring the restore endpoint's `"RESTORE"` requirement. Response `mode` says which of three things happened:

- **`renamed`** (`rollbackMode='retain_database'`, the default) — renames the retained `restoreOldDb` back into place with the same two-step rename-with-recovery pattern as the forward swap, enables maintenance mode the same way, and exits. **Seconds** — the entire justification for paying ~2× the Postgres volume during `oldDatabaseRetentionHours`.
- **`restore_started`** (`rollbackMode='pre_restore_dump'`, i.e. `restoreOldDb` is null but `preRestoreBackupId` is set) — there is no database to rename, only the safety dump taken before the swap, so rolling back delegates straight back into `startRestore(preRestoreBackupId, { overrideSchemaCheck: true })` — a full restore, **hours** again. The schema check is force-overridden here because the pre-restore dump was taken from the exact schema the running code was using moments earlier, so a compatibility block would be spurious.
- **`unavailable`** — neither a retained database nor a pre-restore dump exists (e.g. the retained database already aged out past `oldDatabaseRetentionHours` and was manually dropped). Nothing to roll back to.

Rollback is only callable when `run.restoreStatus === 'completed'` (`DatabaseRestoreNotAllowedError` otherwise) — it undoes a *finished* restore, not an in-flight or failed one.

**On the response shape:** a successful restore's response (and `GET /runs/:id`) surfaces `swappedAt` and `restoreOldDb` (when `retain_database` mode retained one), but there is **no server-computed expiry field** — an admin who needs to know how much longer the retained database will survive computes it themselves from `swappedAt + databaseBackup.oldDatabaseRetentionHours`, the same way `oldDatabaseRetentionHours`-based pruning (§4.4 rule 2) is evaluated. Nothing persists a precomputed `oldDatabaseExpiresAt`.

### 5.8 Two things the swap introduces, both handled

- **Catalog carry-over.** The restored database holds `database_backup_runs` as of BACKUP time, so this restore's own record — and every backup taken since, including any that ran between the backup being restored and the moment the swap fires — would vanish at the rename. `exportCatalog` snapshots every row from the live database (with this run's own restore-audit fields already patched to their post-swap values) immediately before maintenance mode is enabled; `reinsertCatalog` re-inserts them into the newly-renamed live database via `INSERT ... ON CONFLICT (id) DO UPDATE`, over its own short-lived admin connection (never Prisma — the pool was just disconnected and is bound to a database name whose meaning just changed). User FKs (`createdById`, `restoredById`) are resolved through `(SELECT id FROM users WHERE id = $n)`, which yields `NULL` rather than aborting the whole carry-over when the referenced user was created after the archive was taken; the self-FK `preRestoreBackupId` is applied in a second pass since the row it points at may not exist yet during the first. A single unrepresentable row logs a warning and is skipped rather than failing the entire carry-over.
- **Migration roll-forward.** `_prisma_migrations` also comes from the backup, so restoring an older archive can leave the schema behind the running code — exactly what the `schema.compatible` pre-flight gate (§5.3) detects and BLOCKS by default; `overrideSchemaCheck: true` plus `prisma migrate deploy` after the swap is the documented remedy.

### 5.9 Deployment prerequisites the cutover depends on

Both documented as v1 limitations, not silently assumed, and both still true of the merged implementation:

- **`restart: unless-stopped` (or equivalent).** The swap ends in `process.exit(0)`, relying on the container orchestrator to bring the process back up against the renamed database. `infra/compose/prod.compose.yml` already sets this on `api`/`web`/`nginx`. See the [runbook §8.1](../runbooks/database-restore.md#81-restart-unless-stopped-or-equivalent).
- **Single API replica.** The rename only meaningfully quiesces traffic if exactly one process holds connections to the live database name at swap time; a second untouched replica would keep writing against whichever database name it still has open, defeating the swap. The pre-flight only WARNS (`replicas.single`, §5.3) since distinct client addresses are a heuristic, not a guarantee. Multi-replica-safe restore is explicitly out of scope for v1 (epic #339's scope list) — see the [runbook §8.2](../runbooks/database-restore.md#82-single-api-replica-constraint).

---

## 6. API

Full endpoint-by-endpoint reference — parameters, response shapes, permission requirements — lives in the "Admin: Database Backup" section of [CLAUDE.md](../../CLAUDE.md), kept there rather than duplicated here since CLAUDE.md is the canonical, always-current API surface for this whole codebase. Summary:

| Endpoint | Permission | Purpose |
|---|---|---|
| `GET /api/admin/db-backup/config` | `db_backup:read` | Read settings + computed `nextRunAt` + `activeRunId` |
| `PUT /api/admin/db-backup/config` | `db_backup:write` | Partial update; validates `timezone` and `storageProvider` up front |
| `POST /api/admin/db-backup/runs` | `db_backup:write` | Trigger a manual run; returns immediately, dump continues detached |
| `GET /api/admin/db-backup/runs` | `db_backup:read` | Paginated run history |
| `GET /api/admin/db-backup/runs/:id` | `db_backup:read` | Single run detail / progress poll |
| `GET /api/admin/db-backup/runs/:id/download` | `db_backup:read` | Signed download URL, resolved against the RUN's recorded provider |
| `DELETE /api/admin/db-backup/runs/:id` | `db_backup:write` | Delete object then row; refuses a `pending`/`running` row |
| `POST /api/admin/db-backup/runs/:id/cancel` | `db_backup:write` | Cooperative abort — routes through the same failure path as any other failed run |

`POST /api/admin/db-backup/runs/:id/restore` and `POST /api/admin/db-backup/runs/:id/rollback` (`db_backup:restore`, issue #344) live on this same `DatabaseBackupController`, at its bottom — see §5 for the full request/response contract, the three pre-flight outcomes, and the two rollback modes.

---

## 7. RBAC

Three permissions, all Admin-only, added in issue #340 (all three already exist in `apps/api/prisma/seed.ts` regardless of #344's merge status, since RBAC scaffolding was part of the data-model issue, not the restore issue):

- **`db_backup:read`** — view configuration, run history/detail, and download backup artifacts
- **`db_backup:write`** — change configuration, trigger manual runs, delete runs, cancel in-flight runs
- **`db_backup:restore`** — drive a restore or rollback (`POST /runs/:id/restore`, `POST /runs/:id/rollback`); kept as its own permission distinct from `db_backup:write` because a restore is destructive to the running database in a way ordinary backup configuration is not — an admin trusted to schedule and prune backups is not automatically trusted to swap the live database out from under the app

No per-circle role interacts with this feature at all — database backup/restore is inherently app-wide, unlike every circle-scoped feature elsewhere in this codebase.

---

## 8. Settings Reference

The `databaseBackup.*` namespace, `apps/api/src/common/schemas/settings.schema.ts` (`systemSettingsSchema`/`systemSettingsPatchSchema`), edited via `GET`/`PUT /api/admin/db-backup/config` — **not** the generic `PATCH /api/system-settings` (see the "three hand-maintained copies" gotcha in CLAUDE.md's settings section; the db-backup admin controller's `PUT /config` delegates internally to `SystemSettingsService.patchSettings`, so there is still exactly one settings writer, just reached through a dedicated route rather than the generic one).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `databaseBackup.enabled` | boolean | `false` | Master on/off for the scheduled cron; manual triggers via the API work regardless of this flag |
| `databaseBackup.frequency` | `daily`\|`weekly`\|`monthly` | `daily` | Schedule cadence |
| `databaseBackup.dayOfWeek` | int 0–6 | `0` (Sunday) | Used only when `frequency='weekly'` |
| `databaseBackup.dayOfMonth` | int 1–28 | `1` | Used only when `frequency='monthly'`; capped at 28 so every month has that day |
| `databaseBackup.timeOfDay` | string `HH:mm` | `'02:00'` | Local fire time in `timezone`; 02:00 by default since `pg_dump` holds ACCESS SHARE locks and a long-lived snapshot for its whole run, blocking DDL (including a concurrent `prisma migrate deploy`) and holding back autovacuum |
| `databaseBackup.timezone` | IANA string | `'UTC'` | Timezone `timeOfDay` and the schedule's fire-boundary computation are evaluated in |
| `databaseBackup.retentionCount` | int 1–100 | `7` | Newest N `completed` non-`pre_restore` runs kept; older ones pruned after each successful run |
| `databaseBackup.storageProvider` | string \| `null` | `null` | Explicit provider override; `null` = use whatever is currently the active storage provider |
| `databaseBackup.runStaleMinutes` | int 5–240 | `30` | Heartbeat staleness window (§3.2); must exceed the heartbeat interval (`DB_BACKUP_HEARTBEAT_MS`, default 20s) by a wide margin, which the 5-minute floor guarantees |
| `databaseBackup.compressionLevel` | int 0–9 | `1` | `pg_dump -Z` level; kept low by default since embedding vectors are near-incompressible (§4.1) |
| `databaseBackup.restoreRollbackMode` | `retain_database`\|`pre_restore_dump` | `'retain_database'` | Which rollback strategy the restore uses (§3.3/§5.7) |
| `databaseBackup.oldDatabaseRetentionHours` | int 1–720 | `168` (7 days) | Age-based retention window for `pre_restore`-trigger runs (§4.4 rule 2) |

**Environment variables** (process-level, not persisted settings):

- `DB_BACKUP_SCHEDULE_ENABLED` — set `false` to disable `DatabaseBackupScheduleTask`'s cron tick entirely, independent of `ENRICHMENT_WORKER_MODE` (the task is not a queue worker); follows the `THUMBNAIL_REPAIR_ENABLED` precedent
- `DB_BACKUP_HEARTBEAT_MS` — override the default 20s heartbeat interval (§3.2)
- `DB_BACKUP_PG_DUMP_TIMEOUT_MS` — hard SIGKILL ceiling on a single `pg_dump` child process (default 4 hours) — generous by design, exists only to bound a genuinely wedged process (a hung socket), not to police normal duration
- `DB_BACKUP_PG_RESTORE_LIST_TIMEOUT_MS` — hard ceiling on the post-upload `pg_restore --list` verification step (default 30 minutes) — far cheaper than producing the dump, so a much tighter budget than the dump timeout is appropriate
- `PG_DUMP_PATH` / `PG_RESTORE_PATH` — override the resolved binary path/name if `pg_dump`/`pg_restore` aren't plain `pg_dump`/`pg_restore` on `PATH`

---

## 9. Gotchas

- **`pg_dump` blocks DDL for its whole run.** It holds ACCESS SHARE locks and a long-lived MVCC snapshot for the entire dump duration — including blocking a concurrent `prisma migrate deploy`, and holding back autovacuum. This is the concrete reason the default schedule fires at 02:00: pick a schedule window that avoids planned deploys/migrations.
- **Credentials never touch argv.** `PGPASSWORD` goes through the child process's environment only (§4.1) — this is a security requirement with an actual test assertion behind it, not a style preference.
- **Client (`pg_restore`) version must be ≥ server version.** The server runs Postgres 16 (`pgvector/pgvector:pg16`); `apps/api/Dockerfile` installs `postgresql-client-16` to match. See the [runbook §2.2](../runbooks/database-restore.md#22-client-version-must-be--server-version).
- **pgvector is required on any restore target.** The dump contains `CREATE EXTENSION vector`; restoring into a plain `postgres` image fails outright. See the [runbook §2.1](../runbooks/database-restore.md#21-pgvector-is-required-on-the-target).
- **Local-provider downloads proxy through the API**, unlike S3/R2's signed URLs — when `databaseBackup.storageProvider` resolves to `local`, a multi-GB download needs to stream with Range support rather than redirect to object storage directly. Relevant for the download endpoint's implementation, not something an operator needs to think about, but worth knowing if a download of a large local-provider backup behaves differently than an S3-backed one.
- **BigInt fields never leave the API raw.** `sizeBytes`/`bytesWritten` are Prisma `BigInt` columns; every response maps them to strings explicitly (§3.1). See CLAUDE.md's general BigInt gotcha.
- **Embeddings are recomputable but are NOT excluded from the dump.** `media_item_embedding`, `media_visual_embedding`, and `faces.embedding` could in principle be regenerated via the existing tagging/duplicate/face backfill endpoints, which could shrink dump size by roughly 70%. Deliberately not done in v1: text embeddings cost real money to regenerate at scale (AI provider calls), and silently dropping data from what's supposed to be a complete backup is a footgun waiting to surprise someone during an actual disaster.
- **Dumps contain plaintext PII** — emails, names, and everything else in the live schema — and must be treated as sensitive as the database itself. Values already encrypted at rest via `SECRETS_ENCRYPTION_KEY` (AI/face/storage/geo/email provider credentials) stay encrypted *inside* the dump too, so a leaked dump exposes nothing beyond what the masked admin APIs already reach — but bucket-level access to the `db-backups/` prefix should still be restricted at the infrastructure layer independent of this feature's own `db_backup:read` gate.
- **The restore's `restart: unless-stopped` and single-replica assumptions are structural, not defensive.** See §5.9 — verify both before you need them, not during an incident.

---

## 10. Document History

- 2026-08 — Initial version, written alongside the [disaster-recovery runbook](../runbooks/database-restore.md) (issue #346, epic #339), documenting the merged implementation of issues #340–#343 and #348, plus issue #344's design intent (not yet merged as of that writing).
- 2026-08 — Issue #344 (restore/rollback via scratch database + atomic swap) merged; §5 rewritten to describe the shipped `DatabaseRestoreService` implementation rather than design intent — the pre-flight gate table, the three `POST /runs/:id/restore` outcomes (no separate dry-run/pre-flight endpoint exists), the `restoreStatus` value set, the swap ordering, the two rollback modes, and the catalog carry-over mechanism.
