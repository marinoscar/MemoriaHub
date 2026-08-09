# Local Media Backup via Worker Nodes

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | August 2026 |
| **Status** | Implemented |
| **Epic** | #308 |
| **Children** | #310 · #312 · #314 · #316 · #318 · #319 · #320 · #321 · #322 |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Architecture](#2-architecture)
3. [Incremental Sync Protocol](#3-incremental-sync-protocol)
4. [Reconcile, Quarantine, and Verification](#4-reconcile-quarantine-and-verification)
5. [Server Data Model](#5-server-data-model)
6. [On-Disk Format](#6-on-disk-format)
7. [The Local Catalog](#7-the-local-catalog)
8. [Scheduling](#8-scheduling)
9. [Throttling and Server-Load Safety](#9-throttling-and-server-load-safety)
10. [Restore](#10-restore)
11. [Multi-Node Model](#11-multi-node-model)
12. [API Endpoints Reference](#12-api-endpoints-reference)
13. [RBAC](#13-rbac)
14. [Settings Reference](#14-settings-reference)
15. [Gotchas](#15-gotchas)

---

## 1. Overview and Goals

A worker node (see [Distributed Nodes](distributed-nodes.md)) already lets a spare household machine contribute compute to the enrichment queue. **Local Media Backup** reuses that same node identity and control-plane pattern for a different purpose: turning a registered node into a **pull-based mirror** of a circle's media library onto local disk (or an external drive, or a NAS mount) — a second, independent copy of the family's original photo/video bytes that lives outside the server's storage provider entirely.

The design is deliberately boring: a node periodically asks the server "what changed since I last looked", downloads the original bytes for anything new or changed, writes a human-browsable folder tree plus a JSON sidecar per item, and records everything in a plain SQLite catalog anyone can query with `sqlite3`. No proprietary archive format, no server-side coupling to a specific backup destination, no requirement that the node stay online — a laptop that syncs once a week self-heals via the incremental protocol described in §3.

### Goals

- **Original bytes, human-readable layout.** The backup root is a folder tree a person can browse in a file manager, not an opaque blob store.
- **Resumable and crash-safe.** A backup can be interrupted at any point — network loss, laptop sleep, `Ctrl-C`, an OOM kill — and the next run picks up exactly where it left off, never re-downloading what already landed and never leaving a half-written file in the tree.
- **User-queryable.** The catalog is a plain SQLite file (`<root>/.memoriahub/backup.db`) anyone can open with any SQLite client to answer "how many photos of person X do I have backed up" without touching the CLI at all.
- **Low server load.** The change feed is a cheap indexed keyset scan (§3), throttled client-side (§9) so a backup node can never compete meaningfully with the enrichment queue or interactive traffic for server or storage-provider capacity.
- **Restorable.** A backup root is not just an archive — `memoriahub backup restore` can rebuild a working MemoriaHub circle from it on a fresh server (§10).
- **Independent of the node's compute role.** A machine can be a backup node, an enrichment compute node, both, or neither — the two features share only the `WorkerNode` identity and the daemon process, never a queue or a concurrency budget (§2).

### Non-Goals (out of scope for this epic)

- **No app-layer encryption.** The backup root holds plaintext original bytes and plaintext JSON sidecars. Encrypting the destination (a LUKS volume, an encrypted external drive, `rclone crypt`, etc.) is the operator's responsibility, not this feature's.
- **No changes to the server-side replication feature.** `apps/api/src/jobs/backup/` (`POST /api/admin/backup`, `GET /api/admin/backup/runs`, `/status`, `/runs/:runId`) is a separate, older feature — an Admin-triggered server-to-local-disk S3 mirror that runs *on the server itself* against `BACKUP_LOCAL_PATH`. It is untouched by this epic except for the removal of its superseded `GET /api/admin/backup/objects` endpoint (see [Gotchas §15](#15-gotchas)), which existed to eagerly presign every ready object in the library in one response and is now redundant with the paginated, presigned change feed this epic introduces (§3).
- **No derived assets.** Thumbnails, face bounding boxes/embeddings, perceptual hashes, burst/duplicate grouping, and AI-tag provenance are not backed up — they regenerate from the original bytes via the server's enrichment pipeline on restore (§10).
- **No non-media entities.** Circles' membership/roles, system settings, job queue history, and other application state are not backed up. Only `MediaItem` rows (and the album/person/tag associations attached to them) are in scope.
- **No S3-to-S3 or cloud-to-cloud sync.** The destination is always a local filesystem path on the node's machine (which may itself be a mounted network share or external drive — the CLI does not care), never another object-storage bucket.

---

## 2. Architecture

### 2.1 Per-Node Pull

Backup is **per-node pull**, mirroring the compute node's claim model: the node (not the server) drives every request. There is no server-side push, no webhook, no long-lived connection — a backup run is a client-initiated HTTP session against a small, purpose-built API surface:

```
Worker node (laptop)                          MemoriaHub server
──────────────────────                        ──────────────────
1. POST /nodes/:id/backup/runs        ────▶   Create a NodeBackupRun
                                       ◀────   { runId, cursorStart }

2. GET  /nodes/:id/backup/changes     ────▶   Keyset page over media_items
   (loop until hasMore=false)         ◀────   { items[], nextCursor, hasMore }

3. Download each item's presigned URL ────▶   Storage provider (S3/R2/local)
   directly (not proxied through API) ◀────

4. POST /nodes/:id/backup/ack         ────▶   Advance the config checkpoint
   (once per committed page)          ◀────   { checkpoint }

5. GET  /nodes/:id/backup/dimensions  ────▶   Albums/people/tags catalogs
                                       ◀────   { albums[], people[], tags[] }

6. POST /nodes/:id/backup/runs/:id/finish ──▶ Mark the run terminal
```

Media bytes themselves never transit the API process — the `/changes` response carries a short-lived presigned GET URL per item (minted fresh on every page fetch), and the node streams directly from the storage provider, identical to how the compute node's claimed jobs stream input/output bytes (see [Distributed Nodes §2](distributed-nodes.md#2-security-model)). This keeps a multi-terabyte backup run from ever loading a single byte of media through the API's own process memory or bandwidth.

### 2.2 Why the Control Plane Lives at `/api/nodes/:id/backup/*`

Every backup route is mounted under the existing node namespace and gated by the same `jobs:write` permission + owner-scoping as the compute-node control plane (`NodesService.assertOwnership` — 404 for an unknown node, 403 for a node owned by someone else). This is not incidental: `JwtAuthGuard#isNodeRoute` (`apps/api/src/auth/guards/jwt-auth.guard.ts`) accepts a `nod_`-prefixed durable node credential **only** on paths matching `/api/nodes` or `/api/nodes/*` — nowhere else in the API. Mounting backup anywhere else (e.g. a standalone `/api/backup/*` namespace) would have meant either widening the node-credential route allowlist (weakening its least-privilege guarantee for every other node use of that credential) or forcing backup nodes onto a full PAT, which the whole `nod_` credential type exists to avoid for an unattended, long-running process. Since a `nod_` credential is scoped by construction to media/settings/admin-inaccessible node routes, putting backup there for free gets it the same guarantee compute jobs already have: even a leaked backup-node credential can never read circle membership, settings, or any endpoint outside the node data/control plane.

### 2.3 `BackupEngine` Hosted Beside `NodeEngine`

On a machine running `memoriahub node start --daemon`, the daemon process hosts **two independent engines side by side**, not one feature layered on the other:

- `NodeEngine` — the existing enrichment-compute claim/compute/submit loop (see [Distributed Nodes](distributed-nodes.md)).
- `BackupHost` (`apps/cli/src/backup/backup-host.ts`) — owns at most one active `BackupEngine` run, the pull-based schedule poller (§8), and the throttle knobs (§9).

They share **only the daemon process** — never a job queue, a concurrency budget, or an HTTP client:

- **Independent concurrency.** Backup's download pool is sized by `backup.concurrency`, entirely separate from `NodeEngine`'s enrichment worker slots. A node running four enrichment workers and a two-worker backup download pool has six things happening concurrently, not four contending with two.
- **Independent HTTP braking.** `CooldownGate` (the shared 429/503/`Retry-After` backoff primitive) is instantiated **per `ApiClient`**, and `BackupHost` builds its own `ApiClient` rather than reusing `NodeEngine`'s. An AI-provider 429 tripping enrichment's cooldown must never brake backup downloads, and a storage-provider 503 hitting backup must never brake an in-flight enrichment claim.

A backup-configured machine that never runs `node start --daemon` still works for one-shot runs — `memoriahub backup run` falls back to an **embedded, in-process engine** (§8) when no daemon is reachable — but scheduled runs and live `set-rate` pushes require a running daemon (see §8's "no daemon ⇒ no scheduled backups" rule).

### 2.4 Component Map

| Layer | File(s) | Responsibility |
|---|---|---|
| Server control plane | `apps/api/src/nodes/node-backup.controller.ts`, `node-backup.service.ts` | HTTP surface, run lifecycle (start/ack/finish), config CRUD |
| Server query layer | `apps/api/src/nodes/node-backup-query.service.ts` | Pure `media_items` reads: change feed, sidecar composition, manifest, pending-lag, dimensions |
| Server staleness sweep | `apps/api/src/nodes/node-backup-stale.task.ts` | Releases abandoned `running` runs every 10 minutes |
| Change-feed propagation | `apps/api/src/media/media-touch.service.ts` | Bumps `MediaItem.updatedAt` for related-table mutations the feed would otherwise miss (§3) |
| CLI layout | `apps/cli/src/backup/layout.ts` | Folder-tree planning, filename sanitization, sidecar I/O, archive/unarchive moves |
| CLI catalog | `apps/cli/src/backup/catalog-db.ts`, `catalog-repo.ts` | Per-root SQLite schema + typed data access (§7) |
| CLI init | `apps/cli/src/backup/init-backup.ts` | `backup init` — binds one machine to one root |
| CLI engine | `apps/cli/src/backup/backup-engine.ts` | The incremental sync loop (§3) |
| CLI reconcile | `apps/cli/src/backup/reconcile.ts` | Full manifest diff, quarantine, prune (§4) |
| CLI verify | `apps/cli/src/backup/verify.ts` | Local integrity check (§4) |
| CLI restore | `apps/cli/src/backup/restore-engine.ts` | Rebuild a server library from a backup root (§10) |
| CLI daemon integration | `apps/cli/src/backup/backup-host.ts`, `backup-scheduler.ts`, `run-via-daemon.ts` | Daemon hosting, pull-based cron polling, IPC delegation |
| CLI commands | `apps/cli/src/commands/backup.ts` | `init`, `run`, `status`, `verify`, `prune`, `restore`, `schedule`, `set-rate` |
| CLI renderers | `apps/cli/src/render/headless-backup.ts`, `headless-verify.ts`, `headless-restore.ts` | Human/`--json` terminal output — engines never print |
| CLI TUI | `apps/cli/src/tui/BackupDashboard.tsx`, `BackupVerify.tsx`, `BackupSettings.tsx` | Tools ▸ Backup screens |
| Web admin UI | `apps/web/src/pages/Admin/NodeBackupPage.tsx` | Per-node config editor + run history at `/admin/settings/nodes/:id/backup` |

---

## 3. Incremental Sync Protocol

### 3.1 `(updatedAt, id)` Keyset

The change feed (`GET /nodes/:id/backup/changes`) is a keyset-paginated scan of `media_items`, ordered `(updated_at ASC, id ASC)`, served by the raw-SQL index `media_items_updated_at_id_idx` on `(updated_at, id)` added in migration `20260808010000_add_backup_feed_foundations`. The node's local **checkpoint** — mirrored in the catalog's `checkpoint` table and, authoritatively, in `NodeBackupConfig.checkpointUpdatedAt`/`checkpointId` server-side — is a `(updatedAt, id)` pair: "everything up to and including this row has been acknowledged." Each page request supplies `updatedAfter`/`afterId` (both-or-neither; a lone half is a 400) and gets back items strictly after that cursor, using the same `(updatedAt > cursor) OR (updatedAt = cursor AND id > cursor.id)` tie-break every other keyset-paginated surface in this codebase uses (e.g. the media gallery, review-run items).

Unlike the gallery's keyset scan, the feed includes **trashed and archived items** — the backup's job is to mirror everything the circle ever had, not just what browse surfaces show; a tombstone (`deletedAt` non-null) is reported so the node can mark its local copy `trashed` rather than silently missing the deletion (§3.4).

### 3.2 Safety Horizon

A row whose `updatedAt` falls within `backup.feedSafetyHorizonSeconds` (default 5s) of "now" is **withheld** from the page. Without this, a page fetched at the exact instant a write is landing could observe a partially-committed row (or, more subtly, two writes to the same item in the same request could interleave such that the feed's ordering guarantee — "everything at or before this cursor is stable" — silently breaks). The horizon trades a few seconds of latency for that guarantee holding unconditionally: `getPendingLag` (used by the config's `pending` counter) applies the identical horizon so the "how far behind am I" number always matches what the feed will actually serve next.

### 3.3 The `MediaTouchService` Table

A `MediaItem`'s own column writes (favorite, description, capturedAt, archive/trash/restore, geo, orientation) bump `updatedAt` for free via Prisma's `@updatedAt`. But most of what a sidecar reports — tags, album membership, face/people associations — lives in **related tables** (`media_tags`, `album_items`, `faces`) that Prisma does not cascade an `updatedAt` touch through. Without an explicit propagation step, adding a tag to a photo would be **invisible to an already-synced node**: the photo's own row never changed, so it would never reappear in a future page.

`MediaTouchService.touchMediaItems(ids, tx?)` is the single, explicit primitive that closes this gap: a best-effort (never-throwing, warn-and-continue) `updateMany` that sets `updatedAt = new Date()` on the given ids, chunked at 500 ids per statement. Every call site below exists because *something changed that a sidecar reports but that doesn't otherwise touch `MediaItem.updatedAt`*:

| Call site | File | Trigger |
|---|---|---|
| Auto-tagging (parse failure, MediaTag-only path) | `tagging/auto-tagging.service.ts` | AI re-tags an item without also updating `description` (parse failed but a stale-AI-tag was still deleted) |
| Tag label delete/import | `tagging/tag-labels.service.ts` | Deleting or CSV-reimporting a global tag label removes/updates `media_tags` rows for every item it touched |
| Attach / remove a manual tag | `media/media.service.ts` (`attachTags`, `removeTag`) | `media_tags` join changes |
| Bulk tags | `media/media.service.ts` (`bulkTags`) | Same, batched |
| Album delete | `media/media.service.ts` (`deleteAlbum`) | Cascade-deletes `album_items`, which is invisible to the members' own rows |
| Add items to an album (explicit ids, or by filter) | `media/media.service.ts` (`addAlbumItems`, `addAlbumItemsByFilter`) | New `album_items` rows |
| Remove one item from an album | `media/media.service.ts` (`removeAlbumItem`) | `album_items` row deleted |
| Rename an album / change its cover | `media/media.service.ts` (`touchAlbumMembers`, called from `updatePerson`-adjacent album update paths) | The sidecar's `albums[].name` is now stale for every member |
| Face detection (photo + video) | `face/face-detection.service.ts`, `face/video-face-detection.service.ts` | New `Face` rows for the item |
| Create / rename a person, assign or unassign faces, merge, delete, hide/unhide, purge | `face/people.service.ts` (11 call sites: `createPerson`, `assignFaces`, `unassignFace`, `mergePeople`, `deletePerson`, `purgePeople`, `purgeFaces`, `purgeArchivedFaces`, `addPersonToMedia`, `removePersonFromMedia`, and the shared `touchMediaForPersons`/`touchMediaForFaceIds` helpers used by hide/unhide) | Any of these changes the `people[]` array the sidecar reports for one or more items |
| Face auto-archive sweep | `face/face-auto-archive-sweep.handler.ts` | Auto-hiding a face changes which people appear on affected items |

The common shape: whenever a mutation changes what `NodeBackupQueryService.composeSidecar` would emit for an item **without independently bumping that item's own row**, the mutating service calls `touchMediaItems` on the affected id set immediately after the mutation, inside the same request/handler (not deferred, not batched into a cron). Because the feed only cares about the `(updatedAt, id)` ordering — not *why* it changed — a touch is indistinguishable from a genuine content edit, and a node that re-fetches a touched item simply re-derives an identical sidecar (a harmless, idempotent no-op write).

### 3.4 Bytes-vs-Metadata Rule (`contentHash`)

The engine's per-item classification (`BackupEngine.processItem`) decides whether to **re-download bytes** using `contentHash`, never `updatedAt`:

- `deletedAt` non-null → tombstone: mark `trashed` locally, rewrite the sidecar, **the file is left in place** (nothing is deleted from the backup root by an ordinary sync — only reconcile's quarantine path and `backup prune --yes` ever remove local bytes, see §4).
- No local catalog row yet, or `existing.contentHash !== item.contentHash`, or the local row's `status === 'failed'`, or the file is missing/wrong-size on disk → **download**.
- Otherwise → the item's bytes are already correct; only the sidecar (and, if `archivedAt` flipped, the file's tree location) needs updating.

This is what makes a `touchMediaItems`-triggered re-appearance in the feed **cheap**: a tag added to a photo re-syncs a few hundred bytes of JSON, never the multi-megabyte original, because `contentHash` (server-side, over the object's bytes) never changed.

### 3.5 Ack/Checkpoint Monotonicity

`POST /nodes/:id/backup/ack` enforces that the submitted cursor never moves the stored checkpoint **backward**: a cursor strictly behind `NodeBackupConfig.checkpointUpdatedAt`/`checkpointId` is rejected with 409; an *equal* cursor is accepted as a no-op (idempotent retry of an already-applied ack). Within one transaction, the ack advances the config's checkpoint, increments `itemsAcked`/`bytesAcked` (BigInt columns), and accumulates the identical stats onto the run's own counters.

### 3.6 Crash-Safe Page Commit Ordering

Every page follows the same three-step order, and the engine **never** acks ahead of what it has durably committed:

```
1. Files → final place on disk        (downloads land via temp-file + rename;
                                        tree moves are rename-with-EXDEV-fallback)
2. ONE catalog transaction             (every item/dimension upsert + status
                                        write + the checkpoint mirror, atomic)
3. POST /ack (server checkpoint)       (only after step 2 has committed)
```

A crash between any two steps is safe by construction:
- **Crash before step 2 commits:** the catalog transaction rolled back entirely (SQLite's transaction semantics), so the next run re-fetches the *same* page (the local checkpoint never advanced) and re-processes it — downloads that already landed on disk are simply re-verified/no-op'd by the classification in §3.4 (their `contentHash` already matches).
- **Crash between step 2 and step 3:** the local catalog is fully updated and the local checkpoint has advanced, but the server never received the ack. The next run's local cursor read (`readLocalCursor()`) uses the **local** mirrored checkpoint, which is now *ahead* of the server's. The next page request naturally starts from there; the server never rejects a *later* checkpoint. The stale-run sweep (§8) eventually recycles the abandoned server-side run row.

### 3.7 Why the Local Checkpoint May Legitimately Lead the Server's

Because of the ordering in §3.6, **the local checkpoint always mirrors what the node has actually and durably committed to disk, while the server's checkpoint reflects only what it has been told about.** After a crash between steps 2 and 3, the local value is strictly ahead. This is intentional, not a bug to reconcile: `runBackup()`'s cursor selection explicitly prefers the local mirror over the server-reported `cursorStart` (`let cursor = this.readLocalCursor(); if (!cursor && cursorStart...)`), so the node never re-downloads work it has already durably finished, purely because an ack round-trip was lost. The two checkpoints converge on the very next successful ack.

---

## 4. Reconcile, Quarantine, and Verification

Three complementary mechanisms exist to catch drift the incremental feed structurally cannot see, and to prove the local bytes are actually intact.

### 4.1 Reconcile: Manifest Temp-Table Diff

A **reconcile** run (`kind: 'reconcile'`) first executes a normal incremental pass (so the catalog is current), then streams the entire server manifest — `GET /nodes/:id/backup/manifest`, id-keyset paged at up to 1000 rows/page, `{ id, contentHash, updatedAt, deletedAt, archivedAt }` — into a **connection-scoped SQLite temp table** (`CREATE TEMP TABLE IF NOT EXISTS reconcile_ids(id TEXT PRIMARY KEY)` inside the same catalog DB connection). This is memory-safe at any library size: the diff is a SQL `NOT IN` against a table, never an in-process Set of millions of UUIDs.

Two things fall out of the diff:

- **Absent from the manifest, present locally (`status IN ('present','trashed','failed')`) → quarantine.** The manifest reflects everything the server still knows about (including trashed items — a tombstone still has a manifest row). Absence means the item was **hard-deleted** server-side (e.g. `POST /api/media/trash/delete-forever`, an empty-trash run, or the item left the node's circle scope). A quarantined item's file + sidecar move (cross-device-safe) to `<root>/_quarantine/<original subtree>`, the catalog row flips to `status='quarantined'`, and `last_error` records the reconcile run id + reason.
- **Present in both, but `contentHash` differs → marked for re-download.** `markForRedownload` clears the local hash, sets `verified_at = NULL`, and flips `status='failed'`, so the very next incremental pass's classification (§3.4) treats it as needing bytes again.

### 4.2 The Cancelled-Stream-Does-Nothing Rule

The diff step runs **only when the manifest streamed to completion**. A reconcile cancelled mid-stream (`Ctrl-C`, a daemon `backup-cancel`) returns early with `cancelled: true` and performs **no quarantine at all** — a partial manifest would make every unseen-so-far item look server-deleted, which would be catastrophically wrong. This is the same "never act on partial information" posture the engine's page-commit ordering (§3.6) embodies for downloads.

### 4.3 Quarantine Never Deletes

Reconcile's quarantine step is a **move**, never a delete — `quarantineItem` renames the file and sidecar into `_quarantine/`, preserving the original subtree path, and updates only the catalog row's `rel_path`/`status`. This is the single most important safety property of the whole reconcile design: a bug, a misconfigured circle scope, or a genuine-but-unwanted server-side deletion can never destroy a local backup copy automatically. The bytes sit in `_quarantine/` — inspectable, recoverable by hand — until a human explicitly runs the one and only code path that unlinks them.

### 4.4 `prune --yes`

`memoriahub backup prune` lists quarantined catalog rows (optionally filtered by `--older-than <days>`, measured from the row's `updated_at` — the quarantine write is the last mutation a quarantined row ever sees) and, **only with `--yes`** (or an interactive `y` confirmation when no `--yes` was passed and stdin is a TTY), permanently deletes the file, the sidecar, and the catalog row (+ its dimension rows) via `pruneQuarantine`. Without `--yes` it is always a dry run — the default posture for a destructive action in this codebase, matching e.g. the server's `POST /api/media/trash/delete-forever` requiring an explicit id list rather than an implicit "everything".

### 4.5 Verify: Two Modes, Catalog-Driven

`memoriahub backup verify` never walks the filesystem — it iterates the **catalog's** `present` and `failed` rows (trashed and quarantined rows are deliberately excluded: a trashed row's file is a known, deliberate local copy of something the server no longer serves, and quarantine is `prune`'s territory, not verify's) and checks each against disk:

- **Default mode** — existence + size for every row; a **full sha256** only for rows whose bytes have not been *proven* since they landed: `status === 'failed'`, `verified_at === null`, or `downloaded_at > verified_at` (re-downloaded since the last proof). This is the cheap everyday check — a multi-terabyte root is `stat()`ed in full, and only the genuinely unproven tail is hashed.
- **`--deep` mode** — sha256 **every** file, streamed (never buffered whole), bounded by `--concurrency` (default 4). No bandwidth cap applies (`TokenBucket` exists to protect a network link, not local/attached disk).

Outcome handling deliberately mirrors reconcile's drift path so the two features heal through the *same* mechanism: a missing file, a size mismatch, a hash mismatch, or an unreadable file marks the row `status='failed'` + clears `verified_at`, which the next `backup run`'s classification (§3.4) treats as needing a fresh download. **Nothing is ever deleted or moved by verify.**

### 4.6 The "Stat-Only Does Not Stamp `verified_at`" Rule

This is the one deliberate, easy-to-miss subtlety in `verify.ts`: `verified_at` is stamped **only when a file was actually hashed in this pass** (`if (result.hashed) repo.markVerified(...)`), never on a cheap existence/size check alone. If a stat-only "ok" outcome stamped `verified_at`, the *next* default-mode `verify` run would see a fresh `verified_at` and conclude those bytes had been cryptographically proven when they never were — silently and permanently defeating the "hash only the unproven tail" optimization the whole default mode exists to provide. `needsHash()` — the function deciding whether a row needs a full hash in non-deep mode — is exactly the logic this rule protects: it only returns `false` once a genuine hash-backed `verified_at` exists that is not older than the last download.

### 4.7 The 30-Day Auto-Reconcile Cadence

`memoriahub backup run` (no flags) decides its own run kind: `--reconcile` forces one; otherwise `resolveRunKind` checks the server config's `lastReconcileAt` and upgrades a plain incremental to a reconcile when that value is `null` or at least `RECONCILE_EVERY_DAYS` (30) old (`shouldAutoReconcile`). A config-fetch failure degrades gracefully to a plain incremental — the auto-cadence never blocks an otherwise-runnable sync. `lastReconcileAt` is stamped server-side only on a run that both had `kind='reconcile'` **and** finished `status='completed'` (`finishRun`'s `run.kind === NodeBackupRunKind.reconcile` branch), so an aborted or failed reconcile does not reset the 30-day clock.

---

## 5. Server Data Model

Two tables, added in migration `20260808010000_add_backup_feed_foundations` (foundations, issue #310) plus the control-plane logic that reads/writes them (issue #312):

### `node_backup_configs`

One row per `WorkerNode` (`@unique node_id`, cascade-deleted with the node). Columns: `enabled` (default true), `scheduleCron`/`timezone`/`nextRunAt` (the server-computed schedule, §8), `circleIds` (`UUID[]`, empty = all circles the node's owner belongs to), `checkpointUpdatedAt`/`checkpointId` (the authoritative server-side cursor — advanced only by a successful `ack`), `itemsAcked`/`bytesAcked` (`BigInt`, cumulative, incremented by `ack`), `lastRunAt`/`lastCompletedRunAt`/`lastReconcileAt`. Index on `nextRunAt` (a future admin-facing "what's due soon" view could use it; no consumer yet).

### `node_backup_runs`

One row per attempted run (`kind` = `incremental`|`reconcile`, `status` = `running`|`completed`|`failed`|`aborted`|`stale`). `trigger` (`'manual'`|`'scheduled'`) is a plain `TEXT` column (not an enum — kept intentionally loose since it is display-only). `lastAckAt` is the staleness clock: a page fetch **or** an ack both refresh it (`requireActiveRun(..., { refreshAck: true })` on `getChanges`/`getManifest`; the ack transaction itself sets it on `ack`), so a node that is actively working — even slowly, even mid-download between pages — never gets swept as stale mid-run. `cursorStartUpdatedAt`/`cursorStartId` snapshot the checkpoint at the moment the run began (independent of the live config checkpoint, which only moves on ack); `cursorEndUpdatedAt`/`cursorEndId` track the run's own progress. Counters (`itemsDownloaded`, `itemsSkipped`, `sidecarsWritten`, `bytesDownloaded` (`BigInt`), `errorCount`) accumulate via `ack` and the terminal `finish` call's optional `finalStats`. Indexes: `(nodeId, startedAt DESC)` (run history), `(status)` (the staleness sweep's `WHERE status='running'` scan).

### The `media_items (updated_at, id)` Index

A raw-SQL, non-Prisma-DSL-representable index — `media_items_updated_at_id_idx` — added in the same foundations migration, serving the change feed's keyset scan (§3.1) as a pure index range scan. This joins the existing precedent of hand-authored partial/composite indexes on `media_items` (`media_items_gallery_idx`, `media_items_map_locations_idx`) documented in CLAUDE.md's Database Tables section — the backup feed's ordering (`updatedAt, id` ascending, no `WHERE` filter since trashed/archived items must be included) is different enough from those two that a dedicated index was the right call rather than reusing one.

### `MediaTouchService` Propagation

Not a new table — see §3.3 for the full call-site inventory. The service exists purely to keep `updatedAt` an honest proxy for "this item's sidecar-visible state changed," across every mutation path that writes a *related* table rather than the `MediaItem` row itself.

---

## 6. On-Disk Format

### 6.1 Folder Trees

```
<root>/
  media/
    2024/
      03/
        IMG_4521.jpg
        IMG_4521.jpg.json          ← sidecar, side by side
    unknown-date/
      scan0001.jpg
      scan0001.jpg.json
  archived/
    2023/
      11/
        old-photo.heic
        old-photo.heic.json
    unknown-date/
  _quarantine/
    media/2022/06/deleted-item.jpg  ← original subtree preserved under quarantine
  catalog/
    albums.json
    people.json
    tags.json
    manifest.json
  .memoriahub/
    backup.db                       ← the SQLite catalog (§7)
    tmp/                            ← in-flight `.part` downloads
```

Two independent trees — `media/` and `archived/` — mirror the server's Archive/Trash model (see [Archive & Trash spec](archive-trash.md)): `treeFor(archivedAt)` selects `archived/` for any item with a non-null `archivedAt`, `media/` otherwise. **Trash does not move a file** — a trashed item (`deletedAt` non-null) keeps whatever `rel_path` it already had (§3.4's tombstone handling never re-plans a path); its file simply stays wherever it was, and only the catalog `status` flips to `trashed`.

Both trees bucket by **month of capture**, computed from `capturedAt` shifted by `capturedAtOffset` (minutes) so the bucket reflects the **human-local capture date**, not a UTC-shifted one — a photo taken at 11:30 PM local time on New Year's Eve lands in December, not January. An item with no EXIF capture date (`capturedAt === null`) lands in `unknown-date/` within its tree — **deliberately with no fallback to an upload/import date**, so an undated item is always findable in exactly one predictable place rather than scattered across whatever date it happened to sync on.

### 6.2 Filename Sanitization and the `~id8` Collision Policy

`sanitizeFilename` strips control characters; replaces path separators and Windows-invalid characters (`<>:"/\|?*`) with `_`; trims leading/trailing dots and spaces (Windows compatibility); prefixes Windows-reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`9`, `LPT1`–`9`, case-insensitive, with or without an extension) with `_`; and trims to 200 UTF-8 bytes without splitting a multi-byte code point, sacrificing the stem before the extension.

Two items that sanitize to the same filename in the same month bucket **collide**. `planRelPath` resolves this deterministically:

1. The plain sanitized name, if unclaimed (or claimed by the *same* `mediaItemId` — re-planning an already-cataloged item's path is always a no-op match).
2. Otherwise, `<stem>~<first 8 chars of mediaItemId><ext>`.
3. In the astronomically unlikely case that also collides, `<stem>~<full mediaItemId><ext>` (unique by construction, since `mediaItemId` is the collision key).

### 6.3 Rel-Path Stability

Once assigned, an item's `rel_path` is **stable forever** in the catalog — a later rename of `originalFilename` server-side does **not** move the local file. The only things that move a file are: an archive/unarchive transition (`planTreeTransition` flips the leading tree segment, preserving the date bucket and filename), and quarantine (§4.3). This stability is what makes `rel_path` a safe join key for the collision-owner lookup (`ownerOfPath`) — a filename-based rename racing a backup run can never orphan or duplicate a catalog row.

### 6.4 Sidecar: Full `schemaVersion: 1` Field Reference

The sidecar is **server-composed** (`NodeBackupQueryService.composeSidecar`) and written **verbatim** by the node (`writeSidecar` — no re-derivation, no client-side computation) via a same-directory temp-file-then-rename for atomicity. It is the single source of truth for everything the local catalog's dimension tables (`item_tags`/`item_albums`/`item_people`) mirror.

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `1` | Literal; a future breaking change bumps this |
| `mediaItemId` | string (uuid) | |
| `circleId` / `circleName` | string | |
| `type` | string | `photo` \| `video` |
| `originalFilename` | string | |
| `capturedAt` / `capturedAtOffset` | string\|null / number\|null | ISO instant + UTC offset minutes |
| `createdAt` / `updatedAt` / `importedAt` | string (ISO) | |
| `contentHash` | string\|null | The bytes-vs-metadata decision key (§3.4) |
| `size` | string\|null | **BigInt as a decimal STRING** (see Gotchas §15) |
| `mimeType` | string\|null | |
| `width` / `height` / `durationMs` / `orientation` | number\|null | |
| `cameraMake` / `cameraModel` | string\|null | |
| `description` | string\|null | |
| `favorite` | boolean | |
| `archivedAt` / `deletedAt` | string\|null | Presence drives tree selection (§6.1) and tombstone handling (§3.4) |
| `geo.takenLat` / `.takenLng` / `.takenAltitude` | number\|null | |
| `geo.coordSource` | string\|null | `exif`\|`manual`\|`inferred` |
| `geo.country` / `.countryCode` / `.admin1` / `.admin2` / `.locality` / `.placeName` | string\|null | |
| `geo.geoSource` | string\|null | |
| `tags[]` | `{ name, source }[]` | `source`: `manual`\|`ai`\|`system` |
| `albums[]` | `{ id, name }[]` | |
| `people[]` | `{ personId, name, favorite }[]` | Derived from the distinct persons across the item's `faces[]` |
| `faces[]` | `{ id, personId, boundingBox, confidence, videoTimestampMs, manuallyAssigned }[]` | Raw detection records — **not restored** on `backup restore` (§10); backed up purely as an audit/inspection record |
| `sourcePath` / `sourceDeviceId` / `sourceDeviceName` | string\|null | Original-import provenance, when known |
| `metadata` | unknown (JSON) | The item's free-form `metadata` column, passed through as-is |
| `exportedAt` | string (ISO) | Stamped fresh on every sidecar write — *not* stable, unlike every other field |

### 6.5 Dimension Exports: `catalog/*.json`

Written once per **completed** run (not per page — see `writeDimensionCatalogs`, called only after the page loop and any reconcile phase both finish cleanly):

- **`albums.json`** — `{ id, name, description, itemCount, itemIds[] }[]` across the scope's circles.
- **`people.json`** — `{ id, name, favorite, faceCount }[]`.
- **`tags.json`** — `{ name, itemCount }[]`, aggregated by tag *name* across circles and sources.
- **`manifest.json`** — a single object: `{ serverUrl, nodeId, nodeName, catalogSchemaVersion, checkpoint, counts (CatalogStats), lastRun: { id, kind, status, startedAt, finishedAt, stats }, generatedAt }`. This is the human-facing "what is this folder, and how current is it" summary — the same information `backup status`'s local section reports, frozen at the end of the most recent completed run.

All four files are written atomically (temp file + rename), and `restore-engine.ts` reads `albums.json` specifically to recover an album's `description` on restore (album membership itself is reconstructed from each item's own sidecar, §10).

---

## 7. The Local Catalog

`<root>/.memoriahub/backup.db` is deliberately **per-root**, not the CLI's central `~/.memoriahub/memoriahub.db` — the catalog travels with the folder, so an external drive plugged into a different machine brings its full backup state along, and a single machine can (in principle) hold multiple independently-catalogued backup roots on different drives even though v1 binds one machine to one *active* root (§8, §11). It is opened with `journal_mode=WAL` and `foreign_keys=ON`, and migrated via its own `PRAGMA user_version` runner (`runCatalogMigrations`) — copied from the same pattern the central DB uses. A catalog stamped with a `user_version` **higher** than the running CLI understands throws a clean `CatalogOpenError` rather than corrupting or half-understanding it, guiding the operator to upgrade the CLI.

### 7.1 Full DDL

**v1** (issue #314):

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE items(
  media_item_id TEXT PRIMARY KEY, circle_id TEXT NOT NULL,
  rel_path TEXT NOT NULL UNIQUE, sidecar_rel_path TEXT NOT NULL,
  captured_at TEXT, content_hash TEXT, size INTEGER, mime_type TEXT,
  server_updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present','trashed','quarantined','failed')),
  archived INTEGER NOT NULL DEFAULT 0,
  downloaded_at TEXT, verified_at TEXT, last_error TEXT,
  updated_at TEXT NOT NULL);
CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_hash ON items(content_hash);
CREATE INDEX idx_items_captured ON items(captured_at);

CREATE TABLE item_tags(media_item_id TEXT NOT NULL, tag TEXT NOT NULL, source TEXT,
  PRIMARY KEY(media_item_id, tag));
CREATE TABLE item_albums(media_item_id TEXT NOT NULL, album_id TEXT NOT NULL, album_name TEXT,
  PRIMARY KEY(media_item_id, album_id));
CREATE TABLE item_people(media_item_id TEXT NOT NULL, person_id TEXT NOT NULL, person_name TEXT,
  PRIMARY KEY(media_item_id, person_id));

CREATE TABLE runs(id TEXT PRIMARY KEY, kind TEXT, status TEXT, started_at TEXT, finished_at TEXT,
  items_downloaded INTEGER DEFAULT 0, items_skipped INTEGER DEFAULT 0,
  bytes_downloaded INTEGER DEFAULT 0, error_count INTEGER DEFAULT 0, last_error TEXT);

CREATE TABLE checkpoint(key TEXT PRIMARY KEY, value TEXT);
```

**v2** (issue #321, restore tracking):

```sql
ALTER TABLE items ADD COLUMN restored_media_item_id TEXT;
```

`restored_media_item_id` records the `MediaItem` id a backed-up item was restored **into** on some server, making `backup restore` re-runnable (§10). It is deliberately a plain nullable column with no index — restore scans the whole eligible set anyway, and every other lookup in the catalog is by primary key. `upsertItemWithDims`'s `INSERT OR REPLACE` carries this column forward via a self-subselect (see [Gotchas §15](#15-gotchas)) rather than letting an ordinary backup run silently clear it.

### 7.2 Example Queries

The catalog is a plain SQLite database — query it directly with any client:

```bash
# Total items and bytes backed up
sqlite3 <root>/.memoriahub/backup.db \
  "SELECT COUNT(*), SUM(size) FROM items WHERE status = 'present'"

# Everything shot in July 2024
sqlite3 <root>/.memoriahub/backup.db \
  "SELECT rel_path, captured_at FROM items
   WHERE captured_at LIKE '2024-07%' ORDER BY captured_at"

# How many photos of a given person are backed up
sqlite3 <root>/.memoriahub/backup.db \
  "SELECT COUNT(DISTINCT i.media_item_id) FROM items i
   JOIN item_people p ON p.media_item_id = i.media_item_id
   WHERE p.person_name = 'Grandma' AND i.status = 'present'"

# Anything currently quarantined, oldest first
sqlite3 <root>/.memoriahub/backup.db \
  "SELECT rel_path, last_error, updated_at FROM items
   WHERE status = 'quarantined' ORDER BY updated_at"

# Storage by album
sqlite3 <root>/.memoriahub/backup.db \
  "SELECT a.album_name, COUNT(*), SUM(i.size) FROM items i
   JOIN item_albums a ON a.media_item_id = i.media_item_id
   WHERE i.status = 'present' GROUP BY a.album_name ORDER BY 3 DESC"
```

---

## 8. Scheduling

### 8.1 Server-Owned Cron

Unlike the CLI's other scheduling surfaces, the backup schedule is **entirely server-computed**: `memoriahub backup schedule "0 3 * * *" --tz America/Costa_Rica` sends the raw cron string + IANA timezone to `PUT /nodes/:id/backup/config`, and the **server** validates the cron (`isValidCron`), validates the timezone against `Intl.supportedValuesOf('timeZone')` (plus `'UTC'`, added explicitly since some runtimes canonicalize it out of that list), and computes `nextRunAt` (`nextCronDate`, evaluated in the given timezone, defaulting to UTC when `timezone` is null). The CLI itself never parses cron for backup — `BackupScheduler.tick()` (§8.2) only ever compares `Date.parse(config.nextRunAt)` against "now."

### 8.2 Pull Delivery via the 60-Second Daemon Poll

A running daemon's `BackupScheduler` polls `GET /nodes/:id/backup/config` every `pollIntervalMs` (default 60s), plus one **immediate** check on daemon start. When `config.enabled && config.nextRunAt` is due (`Date.parse(nextRunAt) <= now`) and no local run is already active, it fires `trigger='scheduled'`. A failed poll is logged and counted; after `SCHEDULER_FAILURE_THRESHOLD` (5) **consecutive** failures the cadence backs off to `SCHEDULER_BACKOFF_INTERVAL_MS` (5 minutes) until a poll succeeds again, which immediately resets the cadence. All timers are `unref()`'d — the scheduler never keeps the daemon process alive purely to poll.

### 8.3 `nextRunAt` Roll-Forward at Run Start

`NodeBackupService.startRun` rolls `nextRunAt` forward **at the moment a `trigger='scheduled'` run starts** (`nextCronDate(config.scheduleCron, now, timezone)`), not when it finishes — the same at-start pattern `workflow-schedule.task.ts` uses for scheduled workflow runs. This bounds a crash mid-run to firing the same slot once: even if the run then fails or the process dies, the slot has already advanced, so a crash-looping node cannot re-fire the same scheduled backup forever.

### 8.4 Offline/Overdue Behavior — "No Daemon ⇒ No Scheduled Backups"

Because `nextRunAt` only advances **at scheduled-run start** (§8.3), a machine offline (no daemon running, laptop asleep, powered off) at the scheduled instant simply leaves `nextRunAt` in the past — there is nothing to "miss," because nothing ever polled to notice. The very next successful poll — including the **immediate** check `BackupScheduler.start()` performs the moment a daemon comes back up — sees the still-past-due timestamp and fires it right then. This is a deliberate design choice, not a gap: scheduling is entirely pull-based, so **a node with no running daemon simply never has a scheduled backup fire, ever** — `memoriahub backup run` (manual, one-shot) still works via the embedded engine fallback (§2.3), but the cron only ever executes from inside a daemon's poll loop. Operators who want unattended nightly backups must run `node start --daemon` or `node service install` (a systemd user unit) — see the [user guide](../local-backup.md) for the concrete setup steps.

A due schedule is also skipped, without consuming the slot, while a local run is already active (`isRunActive()`); since `nextRunAt` only rolls forward on a scheduled *start*, the still-past-due timestamp makes the *next* poll fire it the moment the active run ends.

---

## 9. Throttling and Server-Load Safety

Backup deliberately behaves like a polite background citizen of the server, never a bulk-import-scale traffic spike:

- **Concurrency** (`backup.concurrency`, CLI setting, default 2) — the size of the download worker pool (`runPool`, the same bounded-concurrency primitive the sync engine and node compute loop use). Deliberately smaller-by-default than a typical enrichment node's concurrency, since backup is I/O- (not CPU-) bound and a household's upstream bandwidth is usually the real ceiling.
- **`maxMbps` token bucket** (`backup.maxMbps`, default 0 = unlimited) — `TokenBucket` (`rate-limiter.ts`) is **shared across every worker in the pool**, so the cap bounds the *aggregate* download rate, not a per-worker rate. Every streamed chunk calls `await bucket.take(chunk.length)`; a `take()` that would overdraw the balance sleeps off exactly the deficit. The bucket starts **empty** (no initial burst) for deterministic timing, and `setRate()` lets a running daemon apply a new cap **live** — the balance is settled at the old rate first, then clamped to the new capacity so a rate cut can never carry over a large old-rate burst.
- **`pageSize`** (`backup.pageSize`, default 100, server-clamped to `backup.maxPageSize`) — how many items one `/changes`/`/manifest` page returns; a small, cheap, indexed query regardless of library size (§3.1).
- **`pacingMs`** (`backup.pacingMs`, default 250) — an explicit sleep **between** pages, independent of the token bucket (which only throttles bytes, not request rate) — bounds how fast the engine can hammer `/changes` even for a page with zero bytes to download (e.g. an all-tombstone page).
- **Per-`ApiClient` `CooldownGate` isolation** (§2.3) — `BackupHost` builds its own `ApiClient`/`CooldownGate` pair, so a 429/503/`Retry-After` response on the backup path brakes only backup's own requests, and vice versa for enrichment. This is what keeps a fully-loaded backup pull from ever amplifying into a *second*, uncoordinated source of backoff pressure against the same server the enrichment queue is also polling.

Every knob above is overridable per-invocation on `memoriahub backup run` (`--concurrency`, `--max-mbps`, `--page-size`) without touching the persisted CLI settings, and durably via `memoriahub backup set-rate` (persists to the settings KV **and**, when a daemon is running, pushes the change live over IPC so an in-progress run adopts it on its very next page/chunk — see §14 for the exact keys).

---

## 10. Restore

`memoriahub backup restore --root <dir>` is the read-back half of the epic: rebuilding a working MemoriaHub circle from a backup root against **any** server (the original one, or a fresh install after a disaster). It re-uploads through the normal resumable upload path and re-registers each item as a brand-new `MediaItem` — it is emphatically not a privileged database import.

### 10.1 What Is and Isn't Restorable

**Restored** (re-applied from each item's own sidecar, after upload):
- The original bytes (re-uploaded via the same resumable multipart path any client uses).
- `capturedAt`/`capturedAtOffset`, `description`, `favorite`, a **manual** GPS location (`geo.coordSource === 'manual'` only — an EXIF-sourced or previously-inferred location is re-derived by the server's own enrichment on the fresh upload instead of being force-written).
- Tags (all of them, any `source` — restored as a flat `add[]`, so they land as ordinary manually-addable tags regardless of whether they were originally AI- or system-applied).
- Album membership, **by name** (find-or-create per target circle; a name collision with an existing album reuses it rather than duplicating).
- People associations, **by name** (via the same manual `POST /api/media/:id/people` `{ name }` find-or-create path a user takes from the properties pane — idempotent, no bounding box required).
- Archive state (applied **last**, after every other write, so an item is never hidden from a browse surface before its metadata has actually landed).

**Not restored — regenerates from the bytes instead:** thumbnails, EXIF-derived typed columns, detected faces (bounding boxes/embeddings — the sidecar's `faces[]` array is an audit record only), perceptual hashes, and burst/duplicate grouping. This is *why* restore is a plain re-upload rather than a database import: the server's own enrichment pipeline (auto-tagging, face detection, burst/duplicate detection) re-derives every one of these from the restored original bytes, guaranteeing they are consistent with whatever detection logic is current on the target server — not frozen at whatever version produced the original backup.

### 10.2 Scope Rules

| Catalog status | Restored? | Lands as |
|---|---|---|
| `present`, `archived=false` | Yes (default) | Active |
| `present`, `archived=true` | Yes (default) | Active, then re-archived at the end |
| `trashed` | Only with `--include trashed` | **Active** — no public API can put a fresh item directly into the server's Trash |
| `quarantined` | **Never** | — the server no longer lists this item; restoring it would resurrect content the server considers deleted |
| `failed` | **Never** | — the local bytes are known-bad; verify or a fresh sync must heal the row first |

### 10.3 Circle Mapping Precedence

Every source circle (derived from the distinct `circleId`s among the items in scope) is resolved to a **target** circle in this strict order, validated **entirely before the first write**:

1. `--map-circle <sourceCircleId>=<targetCircleId>` (repeatable).
2. `--into-circle <targetCircleId>` — everything lands in one circle.
3. **Find-or-create by the sidecar's recorded `circleName`** among the restoring user's own circles (exact name match; an ambiguous duplicate name resolves to the first one listed; genuinely no match creates a new circle with that name, unless `--dry-run`, which only *plans* the would-be creation).

An unresolvable `--map-circle`/`--into-circle` **target** — one that isn't a circle the restoring user actually belongs to — throws `RestoreMappingError` up front, never discovered halfway through an upload run. A source circle whose sidecars carry no recorded name at all (and neither flag was given) is also a hard pre-flight error, since it cannot be matched or auto-created.

### 10.4 Dual Idempotence

Two independent mechanisms make an interrupted or re-run restore safe to simply re-invoke:

1. **`items.restored_media_item_id` (catalog v2).** Set immediately after the `MediaItem` is created — before any metadata is reapplied — so a crash mid-metadata still resumes correctly on the next run. A row already carrying an id is verified live (`GET /api/media/:id`); a 200 skips it outright (`outcome: 'skipped-existing'`); a 404 (restored into a server that has since lost the item) clears the stale marker and re-uploads from scratch.
2. **Server-side content-hash dedup**, `(circle_id, content_hash)`. A re-upload of bytes the target circle already has returns the existing item with `deduplicated: true` — reported as a skip, never an error, and consuming zero of the run's upload byte total.

Restore also **refuses a `nod_` node credential up front** (`assertRestoreCredential`) rather than failing item-by-item with 401s: a node credential is valid only on `/api/nodes/*` routes and can never write media, albums, tags, or people, so restore requires a normal account login or PAT.

---

## 11. Multi-Node Model

Every machine binds **exactly one** backup root (v1's single-root-per-machine guard, enforced by `runBackupInit` — a *different* `--dest` while one is already configured is `BackupRootConflictError`; re-running `init` against the *same* `--dest` is an idempotent re-bind/refresh), and **nodes never coordinate with each other**. Each node keeps:

- Its own local catalog + mirrored local checkpoint (§3.7), entirely private to that machine's `.memoriahub/backup.db`.
- Its own server-side `NodeBackupConfig` row and checkpoint, keyed by that node's id — so node A acking a page can never move node B's cursor, and the single-active-run guard (§5, `node_backup_runs`) is per-`nodeId`, not global.

Two backup nodes independently backing up the same (overlapping or identical) circle scope simply **converge on identical local content**, purely by each independently replaying the same server change feed from its own checkpoint — there is no leader election, no lock beyond each node's own single-active-run guard, and no shared state between them beyond the server's `media_items` table itself. This is a deliberate simplicity trade-off: running two backup nodes for redundancy (e.g. a always-on home server plus an off-site laptop synced weekly) requires no special configuration beyond running `backup init` on each machine — see the [user guide](../local-backup.md) for the concrete walkthrough.

---

## 12. API Endpoints Reference

All routes below are mounted at `/api/nodes/:id/backup/*`, require `jobs:write`, and are owner-scoped via `NodesService.assertOwnership` (404 for an unknown node id, 403 for a node the caller does not own). `nod_` durable node credentials authenticate here exactly as they do on every other `/api/nodes/*` route (§2.2).

### `GET /nodes/:id/backup/config`

Returns `{ config: null }` when backup has never been configured for the node, otherwise the full config plus a **live** pending-lag computation:

```
{ config: {
    nodeId, enabled, scheduleCron, timezone, nextRunAt, circleIds,
    checkpoint: { updatedAt, id } | null,
    itemsAcked, bytesAcked,          // BigInt → decimal STRING
    lastRunAt, lastCompletedRunAt, lastReconcileAt,
    pending: { items, bytes },       // bytes is a decimal STRING
    activeRunId                      // uuid | null
} }
```

### `PUT /nodes/:id/backup/config`

Partial upsert — only provided keys change. `scheduleCron` (5-field cron, `null` clears the schedule + `nextRunAt`), `timezone` (IANA name, `null` falls back to UTC), `circleIds` (every id must be a circle the *node owner* belongs to; empty = all owner circles). Changing `scheduleCron`/`timezone` recomputes `nextRunAt`. 400 on an invalid cron, unsupported timezone, or a `circleIds` entry the owner doesn't belong to. Response shape matches `GET`.

### `POST /nodes/:id/backup/runs`

Body `{ kind: 'incremental'|'reconcile', trigger: 'manual'|'scheduled', cliVersion? }`. Single-active-run rule: a **fresh** `running` run (acked within `backup.runStaleMinutes`) blocks with 409 `{ message, activeRunId }`; a **stale** one is released (`status='stale'`) and the new run proceeds. 400 when backup is unconfigured or `enabled=false`. `trigger='scheduled'` rolls `nextRunAt` forward at start (§8.3). Returns `{ run: { id, kind, startedAt, cursorStart: { updatedAt, id } } }`.

### `GET /nodes/:id/backup/changes`

Query: `runId` (must be the node's **active** running run — 409 otherwise; the fetch itself refreshes `lastAckAt`), `updatedAfter`+`afterId` (both-or-neither — 400 on a lone half), `limit` (default 100, clamped to `backup.maxPageSize`). Returns `{ items[], nextCursor: {updatedAt,id}|null, hasMore, safetyHorizon }`. Each item carries a per-page presigned `downloadUrl` (`null` for a tombstone, a not-`ready` object, or a presign failure — best-effort, never blocks the page) plus the full `schemaVersion: 1` sidecar (§6.4). `nextCursor` advances even on a **partial** page — a short page near "now" is expected because of the safety horizon (§3.2), not an error.

### `POST /nodes/:id/backup/ack`

Body `{ runId, cursor: {updatedAt, id}, stats: {itemsDownloaded, itemsSkipped, sidecarsWritten, bytesDownloaded, errors} }` (`bytesDownloaded` accepted as a decimal string or a plain non-negative integer). Validates the active run (409 otherwise) and monotonicity (§3.5, 409 on a regressing cursor). Returns `{ ok: true, checkpoint: {updatedAt, id} }`.

### `POST /nodes/:id/backup/runs/:runId/finish`

Body `{ status: 'completed'|'failed'|'aborted', error?, finalStats? }`. Sets the terminal status + `finishedAt` (+ `lastError` from `error`, truncated by the caller to 4000 chars); accumulates `finalStats` onto the run's counters. On `completed`, stamps `lastCompletedRunAt` (and `lastReconcileAt` when `kind='reconcile'`). 404 for an unknown run or one belonging to another node; 400 if the run is already terminal.

### `GET /nodes/:id/backup/runs`

Query `limit` (default 20, max 100). Returns `{ runs: [...] }`, newest first, `bytesDownloaded` as a decimal string.

### `GET /nodes/:id/backup/manifest`

Query: `runId` (active run required — 409 otherwise; also refreshes `lastAckAt`), `afterId` (id-keyset cursor), `limit` (default 1000, **hard-capped** at 1000 regardless of `backup.maxPageSize`). Returns `{ items: [{id, contentHash, updatedAt, deletedAt, archivedAt}], nextAfterId, hasMore }` — used exclusively by the reconcile pass (§4.1).

### `GET /nodes/:id/backup/dimensions`

No active run required — a config-less node reads the owner's full circle scope. Returns `{ albums[], people[], tags[], generatedAt }` (§6.5's `catalog/*.json` source).

---

## 13. RBAC

**No new permission was added.** Every route reuses the owner's existing `jobs:write` (the same permission that already gates registering/managing a caller's own worker nodes and minting/revoking that owner's `nod_` credentials — see [Distributed Nodes](distributed-nodes.md#node-data-plane-distributed-workers--admin-worker-nodes) in CLAUDE.md). Two enforcement layers:

- **Authentication**: `nod_` or PAT, both accepted only on `/api/nodes/*` (§2.2).
- **Authorization**: `NodesService.assertOwnership(userId, nodeId)` on every call — 404 for a node id that doesn't exist, 403 for one that exists but belongs to a different owner. Circle scoping is enforced independently, inside `updateConfig`: every requested `circleIds` entry must be a circle the **node's owner** (not necessarily the caller, though in practice they are the same account) is a member of.

**Admin fleet visibility** is read-only and separate: `NodesService.listNodes`/`getNode` (the existing `GET /api/nodes` / `GET /api/nodes/:id`, and the Admin-only `GET /api/admin/nodes`) now include a `backup: { enabled, lastCompletedRunAt, checkpointUpdatedAt, activeRun } | null` summary per node (`summarizeBackup`), joined from `NodeBackupConfig` with a deliberately narrow `select` that excludes the BigInt counters (`itemsAcked`/`bytesAcked`) — keeping them out of the list-response serialization path entirely, rather than relying on per-field `.toString()` discipline at every call site. No lag/pending computation is included in the list view (that stays exclusive to `GET /nodes/:id/backup/config`, which is the only place it's cheap to compute per-request).

---

## 14. Settings Reference

### System Settings — `backup.*` namespace

Editable only via the generic `PATCH`/`PUT /api/system-settings` JSON (no dedicated admin settings-page panel exists for this namespace as of this writing):

| Key | Type | Default | Purpose |
|---|---|---|---|
| `backup.maxPageSize` | integer, 50–500 | 200 | Hard cap on rows a node may request per `/changes`/`/manifest` page (a `limit` above this is clamped, not rejected) |
| `backup.feedSafetyHorizonSeconds` | integer, 0–60 | 5 | Withhold rows newer than this from the feed (§3.2); `0` disables the horizon |
| `backup.runStaleMinutes` | integer, 5–120 | 15 | Minutes without a page fetch or ack before a `running` run is released as `stale` (§5, §8) |

### CLI Settings KV (`~/.memoriahub/memoriahub.db`, via `SettingsRepo`)

| Key | Accessor | Default | Purpose |
|---|---|---|---|
| `backup.root` | `backupRoot()`/`setBackupRoot()` | `null` | Absolute path of this machine's single configured backup root |
| `backup.nodeId` | `backupNodeId()`/`setBackupNodeId()` | `null` | The `WorkerNode` id the root is bound to |
| `backup.concurrency` | `backupConcurrency()`/`setBackupConcurrency()` | 2 | Concurrent download workers (§9); `backup run --concurrency` overrides per-invocation; `backup set-rate --concurrency` persists + live-pushes |
| `backup.maxMbps` | `backupMaxMbps()`/`setBackupMaxMbps()` | 0 (unlimited) | Aggregate bandwidth cap in Mbps (§9) |
| `backup.pageSize` | `backupPageSize()` | 100 | Change-feed page size requested per call (server still clamps to `backup.maxPageSize`) |
| `backup.pacingMs` | `backupPacingMs()` | 250 | Inter-page sleep (§9) |

`backup.root`/`backup.nodeId` are set once by `backup init` and never edited directly; the throttle knobs (`concurrency`/`maxMbps`/`pageSize`/`pacingMs`) are ordinary settings-KV entries any `memoriahub settings get/set` call could in principle touch, though `backup set-rate` is the documented, validated path for the two that matter most operationally.

---

## 15. Gotchas

- **Every byte-count field crosses the wire as a decimal STRING, never a raw number/BigInt.** `bytesAcked`, `pending.bytes`, `bytesDownloaded`, `itemsAcked`, and the sidecar's `size` field are all Prisma `BigInt` columns server-side — see CLAUDE.md's "Never store an unsigned 64-bit value..." and "`BigInt` is not JSON-serializable" gotchas, which this feature follows without exception. `BackupAckDto`'s `bytesDownloaded` field tolerates a plain non-negative integer *inbound* for robustness, but every outbound byte count is a string.
- **Never select `embeddingVec` (or `embedding`) in the change-feed query.** `NodeBackupQueryService`'s `changeFeedSelect` selects only `id`, `personId`, `boundingBox`, `confidence`, `videoTimestampMs`, and `manuallyAssigned` from `faces` — a hard-coded comment above the select warns future editors that `embeddingVec` is a Prisma `Unsupported` column type that must never appear in any select, and `embedding` (the 128-float array) has no sidecar value and would needlessly bloat every page's response.
- **Presigned download URLs are minted PER PAGE, not per run.** A URL from an earlier page can expire mid-run on a slow connection; the engine's `PresignExpiredError` handling re-fetches the **same page** (the cursor hasn't moved, so this is idempotent) to re-mint URLs, capped at `MAX_PAGE_REMINTS` (3) before the still-expired items are recorded as failed for that page (retried automatically on the next incremental run).
- **The `nod_` route restriction is load-bearing for restore, not just backup.** Restore's `assertRestoreCredential` check exists *because* a `nod_` credential is provably incapable of writing media/albums/tags/people (§2.2's route allowlist) — the check is a fast, clear failure instead of a confusing cascade of 403s partway through an upload run.
- **`INSERT OR REPLACE` on the catalog `items` table is a delete+insert at the SQLite level**, which would silently drop `restored_media_item_id` (catalog v2) on every ordinary backup sync unless carried forward explicitly. `upsertItemWithDims`'s INSERT statement does this via a self-referencing subselect — `(SELECT restored_media_item_id FROM items WHERE media_item_id = ?)` — as its final value, so a ordinary `backup run` after a `backup restore` never clears the restore marker. The backup engine itself is never a *writer* of this column, only a preserver of it.
- **A cancelled run never acks, never commits, and — for reconcile — never quarantines anything.** All three "never" clauses share one root cause: acting on partial information is unsafe in a way that's specific to each phase (an unacked partial page would double-count on retry; an uncommitted catalog write would diverge from the server's checkpoint; a partial-manifest quarantine pass would treat every not-yet-streamed item as server-deleted). See §3.6 and §4.2.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | August 2026 | AI Assistant | Initial specification, written against the completed implementation (issues #310, #312, #314, #316, #318, #319, #320, #321) on `feat/backup-docs` |
