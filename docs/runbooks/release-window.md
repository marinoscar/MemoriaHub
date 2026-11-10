# Runbook: the production release window (RETRO-A6)

Issue [#592](https://github.com/marinoscar/MemoriaHub/issues/592), epic #564, program #555. This is the one document an operator follows, top to bottom, to take production from the pre-retrofit release (tag `MonoRepo`) to the platform-based release: the platform baseline and migrations, identity, settings, jobs, nodes, storage, email, notifications, backup, Android, AI, telemetry, the harvested features, and circles to groups (I2 to K2). Each step names the runbook that holds the detail; this page holds the **order**, the **gates**, the **verification** and the **way back**.

> **Status.** Nothing in this document has been run in staging or production. The window has not been scheduled. Every command was checked against `apps/api/package.json`, `apps/cli` and the linked runbooks on 2026-11-10, but a command that has never run against a restored production backup is a hypothesis. Section 2 is the rehearsal that turns it into a procedure. Where a fact is uncertain this page says **UNVERIFIED** and tells you what to do about it.
>
> Hostnames, paths and tokens below are placeholders (`app.example.test`, `<ADMIN_JWT>`). Never paste `POSTGRES_PASSWORD`, `SECRETS_ENCRYPTION_KEY`, a JWT or a PAT into the issue, a ticket or a chat.

Contents: [1 Gates](#1-release-gates) | [2 Rehearsal](#2-the-staging-rehearsal) | [3 Roles, announcement, freeze](#3-roles-announcement-freeze) | [4 The window](#4-the-window-in-order) | [5 After deploy: settings](#5-after-deploy-settings) | [6 Verification](#6-verification-checklist) | [7 Rollback](#7-rollback) | [8 Known gaps](#8-known-gaps-and-follow-ups) | [9 Production record](#9-production-record-template)

## 0. What the train contains

All of it is on `main` (platform packages `0.1.0-next.29`); none of it is tagged or deployed.

| Group | Issues | Database change (migration directory under `apps/api/prisma/migrations/`) |
|---|---|---|
| Baseline | A5, A5b | `20260817000000_rename_legacy_platform_tables`, platform `0003`-`0040` installed by the baseline, `20261108160000_rename_legacy_storage_migration_tables`, installed `0041`/`0042` |
| Identity, settings, credentials | B1-B4 | `20261108030000_move_user_avatar_off_users`; platform `0024` moves `contributor`/`viewer` onto memberships |
| Jobs and nodes | C1 | `20261108040000_cutover_enrichment_jobs_to_jobs` |
| Nodes slice | C2 (#689) | `20261109300000_c2_worker_nodes_to_platform` (drops the legacy node tables) |
| Native handlers, crons, node CLI | C3-C6, C9, C10 (CLI 1.6.x) | none |
| Storage, email, notifications, backup, Android | D1, D1b, D2, D3, D4, D5 | none (one-off data scripts, section 4.7) |
| AI | E1-E4 | none (key import script, section 4.7) |
| Telemetry, harvested features | T1-T4, H1-H5 | none |
| Circles to groups | I2 | `20261108200000_i2_circles_to_groups_ownership` |
|  | I4 (#578) | `20261109100000_i4_media_shares_to_link_grants` (drops `media_shares`; refuses until imported) |
|  | I5 (#583) | `20261109200000_i5_circle_invites_to_group_invites` (drops `circle_invites`) |
|  | I3, I6, K1 (#698) | none (code) |
|  | K2 (#699) | `20261110100000_k2_drop_circles` (drops `circles`, `circle_members`, `CircleRole`) |
| J-series packages | J1, J2 | none; the packages are **private**, nothing is published |

## 1. Release gates

Do not schedule the window until **every** gate is ticked. The first two are open today.

- [ ] **Staging end-to-end worker test: NOT YET RUN.** On staging, with the release image and CLI 1.6.2 or newer: about 2,000 mixed photos and videos (include HEIC photos and one 2 GB video), **two worker replicas**, no OOM restart loop (`docker ps` restart count stays 0; no exit 75 loop, see [worker-container-config.md](../worker-container-config.md#35-memory--oom-hardening)), jobs of node-eligible types show `executor = 'node'` (`SELECT executor, type, count(*) FROM jobs GROUP BY 1,2 ORDER BY 2,1;`), AI jobs stay on the server. If you opt into geocoding on the fleet, the Google key reaches a node **only** through the per-job secret ([geocoding-key.md](geocoding-key.md)); otherwise leave `nodes.jobSecretBrokerEnabled` off and `geocode` runs on the API host.
- [ ] **Worker image Docker build and the HEIC gate: NOT YET VERIFIED.** A `.github/workflows/deploy.yml` run must build the worker image and pass the in-image `REQUIRE_HEIC_DECODE=1` check (the step is at `deploy.yml` line ~160 and ~231). Record the run URL.
- [ ] **Staging rehearsal of the whole train on a restored production backup** (section 2), with every report block recorded. The A5 rehearsal ([database-baseline.md §10](database-baseline.md)) covers the baseline only; it is not a substitute.
- [ ] **No `v*` tag until the window.** Do not push one, and do not let an automation do so.
- [ ] `main` CI green; the image to deploy is built from the exact commit recorded in section 9, and its tag is pinned.
- [ ] The image contains the `platform` bin and the files the baseline needs: `docker compose ... run --rm api npx platform --help`, and `apps/api/scripts/platform-env.js`, `prisma/`, `prisma.config.ts` present in the image.
- [ ] No other PR carries the `migration-lock` label (`gh pr list --label migration-lock`). Nothing lands under the operator's feet.
- [ ] The Postgres image for production and staging is `pgvector/pgvector:pg17` (the migrations were rehearsed on 16 and 17 with pgvector and `pg_trgm`).
- [ ] `SECRETS_ENCRYPTION_KEY` is the production value and is available to the one-off containers (every import script and the AI key import decrypt legacy secrets with it).

## 2. The staging rehearsal

Restore the newest production backup into a staging database ([database-restore.md](database-restore.md), the manual path), deploy the release image against it and run **sections 4 to 6 of this page, in order**, recording each report block and each timing. Specifically record:

- the baseline dry-run report (B1 to B5), compared line by line with the production dry run in step 4.5;
- the dry-run counts of every one-off script (section 4.7) and the `NOTICE` lines of `prisma:migrate` (`RETRO-I2`, `RETRO-I5`, `RETRO-C2`);
- the row counts of every table the train renames, copies or drops, before and after (the SQL in [circles-to-groups.md §9](circles-to-groups.md#9-dropping-the-circle-tables-retro-k2), [worker-nodes-cutover.md](worker-nodes-cutover.md) and [jobs-cutover.md §3](jobs-cutover.md));
- the wall-clock time of the whole of section 4 (this sets the maintenance window length, with the backup time on top).

**Resolve the I4 ordering question here** (section 4.6 explains it). Whichever of the two options you choose, the rehearsal must show it working end to end, including the verification in section 6. If the rehearsal shows the migration step failing for a reason this page does not cover, stop: fix it in a PR and re-rehearse.

## 3. Roles, announcement, freeze

| Role | Does |
|---|---|
| **Operator** | Runs every command, owns the production record |
| **Owner / approver** | Decides go/no-go after each dry run, holds the rollback decision |
| **Verifier** | Signs in as admin, contributor and viewer test accounts; runs section 6 independently |
| **Scribe** (may be the verifier) | Fills section 9 as the window proceeds |

Prerequisites for the people: SSH access to the production host, `docker compose` rights, an admin account, a contributor and a viewer test account that already exist in production, a place to store the downloaded backup (encrypted volume), and two ways to reach each other.

Before the window:

1. **Freeze.** From the merge of the last train PR until the window, `main` is **not deployed** to production (announce in #555). No `migration-lock` PR is open.
2. **Announce** to users: date, start time, expected length (rehearsal time plus backup time plus 30 minutes of slack), what they will see (the maintenance screen), and what changes for them ([circles-to-groups.md §9, behaviour changes](circles-to-groups.md#behaviour-changes-to-tell-users-about): deleting a library with content is refused; the "Circles" language becomes groups and "My library"). Tell Android users nothing is needed; tell worker-node owners their nodes must be re-registered afterwards.
3. **Stage worker nodes.** Every owner of a native node and the operator of the container fleet know the window. Native nodes will be stopped (`memoriahub node stop`) and containers scaled to 0 at step 4.2.
4. **Maintenance mode** is the mechanism for the window ([maintenance-mode.md](maintenance-mode.md)). Know the break-glass: `MAINTENANCE_MODE=false` in the API environment forces it off, and `allowAdmins: false` is a footgun if the API is down (read [§4 of that runbook](maintenance-mode.md#4-the-three-lockout-safeguards--and-the-one-footgun) first). In this window use `allowAdmins: false` so no session writes between backup and apply, **and keep the nginx-level fallback ([§6](maintenance-mode.md#6-nginx-level-fallback-when-the-api-itself-wont-start)) in reach** in case the API will not start.

## 4. The window, in order

Conventions. Production runs through `infra/deploy/` ([prod-deploy.md](../prod-deploy.md)); the compose file lives at `/opt/infra/apps/memoriahub/compose.yml`. The one-off commands below use these shell variables:

```bash
export COMPOSE="docker compose -f /opt/infra/apps/memoriahub/compose.yml"
export RUN="$COMPOSE run --rm api"        # one-off container from the NEW image; no API traffic
echo "$POSTGRES_HOST $POSTGRES_DB"; echo "$POSTGRES_HOST $POSTGRES_DB"   # read POSTGRES_* twice: they must name production
```

`RUN` reads the API's environment from the compose file, so `POSTGRES_*` and `SECRETS_ENCRYPTION_KEY` are the production values. Check with `$RUN printenv POSTGRES_HOST POSTGRES_DB` (never print the password or the key).

**Do not use `infra/deploy/update.sh` for this window.** It rebuilds, stops the API and runs `prisma migrate deploy` in one go ([prod-deploy.md, Updates](../prod-deploy.md#updates)), which would apply the migrations before the I4 import (step 4.6) and before the one-off scripts. Build and pin the image yourself (or use `update.sh` only for the final restart in step 4.8, after the migrations ran, where its migrate step finds nothing pending; confirm that in the rehearsal).

### 4.1 Open maintenance

```bash
curl -sS -X PUT https://app.example.test/api/admin/maintenance \
  -H "Authorization: Bearer <ADMIN_JWT>" -H "Content-Type: application/json" \
  -d '{"enabled": true, "message": "Upgrading, back in about 60 minutes", "allowAdmins": false}'
curl -i https://app.example.test/api/media        # expect 503 with details.reason MAINTENANCE_MODE
```

Keep it on until step 4.10.

### 4.2 Stop worker nodes

Stop the container fleet (scale the worker compose to 0, or `docker stop` each replica; SIGTERM drains) and ask native-node owners to run `memoriahub node stop`. Confirm nothing claims: `/admin/settings/workers` (or `SELECT count(*) FROM jobs WHERE status = 'running';` goes to 0 or stays unchanged). If the old API's own in-process worker is running jobs, it stops with the API in the next step.

### 4.3 Verified backup, off-server

1. Take a fresh backup: `/admin/settings/backup`, or `POST /api/admin/db-backup/runs` (needs `db_backup:write`). Wait for `status = completed` **and** `verifiedAt` set. Note the run id.
2. Download it off the server over SSH (`GET /api/admin/db-backup/runs/:id/download`, a signed URL) and store it encrypted. **This archive is the rollback for the whole window.** Confirm you can read its table of contents (`pg_restore --list <archive> | head`).
3. Record the run id, size and checksum in section 9. If the backup is not `verified`, stop.

### 4.4 Stop the API, record "before" counts

Stop the API and web (`$COMPOSE stop api web`) so nothing writes. Leave Postgres up. Record the before-counts you will compare after (adapt the table list to what the dry runs print):

```sql
-- as the application owner; the content tables are under RLS, so bypass it in the transaction
BEGIN; SELECT set_config('app.rls_bypass','on',true);
SELECT 'users', count(*) FROM users UNION ALL
SELECT 'media_items', count(*) FROM media_items UNION ALL
SELECT 'storage_objects', count(*) FROM storage_objects UNION ALL
SELECT 'circles', count(*) FROM circles UNION ALL
SELECT 'circle_members', count(*) FROM circle_members UNION ALL
SELECT 'circle_invites', count(*) FROM circle_invites UNION ALL
SELECT 'media_shares', count(*) FROM media_shares UNION ALL
SELECT 'worker_nodes', count(*) FROM worker_nodes UNION ALL
SELECT 'node_credentials', count(*) FROM node_credentials UNION ALL
SELECT 'enrichment_jobs', count(*) FROM enrichment_jobs;
COMMIT;
```

(Before the baseline, `worker_nodes` and `node_credentials` still have their old names; after the rename they are `mh_legacy_*`. Use the names that exist at the time you run it; the point is to have the numbers.) Also take the identity snapshot ([identity-adoption.md](identity-adoption.md), pre-flight):

```bash
$RUN node scripts/verify-identity-transform.mjs snapshot --out /tmp/before.json   # UNVERIFIED: the container's /tmp is discarded; mount a volume or run it from the host with POSTGRES_* pointed at production
```

and run the pre-flight query there (users with no role gain `viewer` at platform `0024`; decide before the window).

### 4.5 Baseline: dry run, compare, apply

Dry run on production with the **new** image in a one-off container (the old image is already stopped). The dry run changes nothing; its report is on stderr:

```bash
$RUN npm run db:baseline -- --through 2 --allow-rls 2>&1 | tee ~/baseline-dry-run-prod.txt
diff ~/baseline-dry-run-prod.txt ~/baseline-dry-run-staging.txt     # must show no difference except timings
```

The report must equal the staging rehearsal **line by line**: `B1` matched/unmatched/app-only counts, `B2 0 problem(s)`, `B3 0 blocking, N declared`, both `B4` `0 problem(s)`, `B5 0 to resolve, 0 to install only`, `dry run clean`. The numbers for a database migrated from empty are in [database-baseline.md §6 and §13](database-baseline.md#6-expected-numbers); §13 has no entry yet for I4, I5, C2 or K2, so the staging report is the reference, not the doc. **Any difference: stop, close the window (section 7), investigate.** `--allow-rls` is required because platform `0025` to `0029` and `0039` enable row-level security above `--through` ([§5](database-baseline.md#5-the-procedure)).

Apply, following the rehearsed order of [database-baseline.md §10 steps 4 to 6](database-baseline.md#10-production-backup-rehearsal-not-yet-done-required-before-retro-a6):

```bash
$RUN npm run db:baseline -- --through 2 --allow-rls --apply --force-remap    # "baseline applied and verified"
```

The lock is already committed, so `--force-remap` rewrites an identical lock inside the container; it resolves nothing new on production. **UNVERIFIED:** whether, with the committed tree, a bare `prisma:migrate` before this step would also apply platform `0003`-`0040` (the issue text and §10 step 4 disagree). Do exactly what the staging rehearsal did, in that order, and write the order you used in section 9.

### 4.6 Migrations, with the I4 import in the right place

**The hazard, stated plainly.** `prisma migrate deploy` applies every pending directory in order. Two constraints collide:

- `sharing:import-media-shares` needs the I2 migration applied first (it reads `media_items.org_id` and `albums.org_id`; [circles-to-groups.md §7](circles-to-groups.md#7-public-shares-to-link-grants-retro-i4)).
- The I4 migration (`20261109100000_i4_media_shares_to_link_grants`) **refuses** (`RAISE EXCEPTION 'RETRO-I4: N media_shares row(s) are not imported as link grants yet'`) while any share is not imported, and drops `media_shares` once it passes.

On a production database that still lacks I2, one `prisma:migrate` reaches I4 before the import could have run. The migrations after I4 (I5, C2, K2) must also not run before the import completes. **The checklist sentence "run the import before `prisma:migrate`" is therefore not executable as written on this database.** Two options; the staging rehearsal picks one and records it:

**Option A (recommended, UNVERIFIED): let the migration stop at I4, then import, then re-run.**

```bash
$RUN npm run prisma:migrate        # applies up to I2, then fails at I4 with the RETRO-I4 message; read the output
```

The refusal is the first statement of the I4 file (a `DO` block), so nothing of I4 is applied. Prisma then records that migration as failed in `_prisma_migrations` and **blocks later deploys** (error `P3009`) until it is marked rolled back. **UNVERIFIED:** whether your Prisma version needs the explicit step below; do it only if the next `prisma:migrate` reports `P3009`, and record the exact output in the rehearsal:

```bash
$RUN node scripts/prisma-env.js migrate resolve --rolled-back 20261109100000_i4_media_shares_to_link_grants
```

Then import, with the circles still present:

```bash
# 1. Read-only counts (any time):
#    SELECT target_type,
#           count(*) FILTER (WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS active,
#           count(*) FILTER (WHERE revoked_at IS NULL AND expires_at <= now()) AS expired,
#           count(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked
#    FROM media_shares GROUP BY target_type;
$RUN npm run sharing:import-media-shares              # dry run: "media_shares: N (active a, expired e, revoked r; ...)"
$RUN npm run sharing:import-media-shares -- --apply   # "imported N, already there 0, invalid 0, ... re-keyed K"
```

`invalid` lists rows whose token is malformed or whose target is gone; the migration refuses until they are deleted. Re-running is safe. Compare the dry-run counts with the rehearsal. Then continue:

```bash
$RUN npm run prisma:migrate        # I4 (drops media_shares), I5, C2, K2; read every NOTICE
```

**Option B (UNVERIFIED): apply the earlier migrations alone.** Run the one-off container with a migrations directory that holds only the directories up to and including `20261108200000_i2_circles_to_groups_ownership` (copy the tree, remove the later ones, mount it over `prisma/migrations`), run the import, then run `prisma:migrate` from the unmodified image. It avoids the failed-migration state but edits what the container sees; `platform.lock` hashes the real files, so do not edit any file in the repository. Use it only if Option A's `P3009` handling is not acceptable after the rehearsal.

Read the `NOTICE` lines in the output and record them in section 9:

| Migration | Output to read | Meaning |
|---|---|---|
| `20261108200000_i2_...` | `RETRO-I2` notices | shared circles without an admin (the owner becomes group admin); circle members without an active default-organization membership (informational); any table with **no owner rows is a blocker** ([circles-to-groups.md §5](circles-to-groups.md#5-troubleshooting)) |
| `20261109200000_i5_...` | `RETRO-I5: circle_invites T (claimed C dropped; personal-circle P skipped; already a member M skipped); imported N pending group invite(s)` | `N` must equal `pending_shared` minus the "already a member" skips from the read-only query in [§8 step 1](circles-to-groups.md#8-circle-invites-to-group-invites-retro-i5); no invite can be lost between the copy and the drop (one transaction) |
| `20261109300000_c2_...` | an exception `RETRO-C2: N worker node(s) ... were not copied` aborts and rolls back; otherwise silent | **drops the legacy node tables** (irreversible without a restore) |
| `20261110100000_k2_...` | exceptions `RETRO-K2: ...` (second personal circle, circle without a group, row with an unknown scope) abort before any change; success proves row counts and owner columns unchanged | **drops `circles`, `circle_members`, `CircleRole`** (irreversible without a restore) |

**Deploy-order constraints, summarised:** the K1 code (#698, in the image) must be what runs after K2 (the previous release reads `circles` and cannot run on the migrated database); the I4 import runs after I2 and before I4's migration; the I5 migration needs I2 and I4 applied (they are earlier in the history, so the single `prisma:migrate` run satisfies it); C2's migration drops `mh_legacy_worker_nodes` and `mh_legacy_node_credentials` (a revert needs the restore).

### 4.7 Seed, checks, one-off scripts

```bash
$RUN npm run prisma:seed          # idempotent: viewers get groups:write; admins get nodes:read, nodes:write, ai_config:read/write, org settings
$RUN npm run db:check
$RUN npm run db:check:database    # "ok (N ledger row(s) match the files)"
$RUN npm run db:baseline          # no --through: "nothing to do" / "dry run clean"
```

Then the one-off data scripts. **Every one is a dry run by default; run the dry run first, read it, then `--apply`.** All are idempotent and set-if-absent unless noted. They need `SECRETS_ENCRYPTION_KEY` (the key that encrypted the legacy rows) and refuse, writing nothing, when a legacy secret cannot be decrypted. Run them with the API **stopped** (the one-off container) or after it starts; both work, but run them before the users come back (step 4.10).

| # | Purpose | Dry run | Apply | Detail |
|---|---|---|---|---|
| 1 | Email settings and secrets into the platform `email` row | `$RUN npm run email:migrate-settings` | `... -- --apply` | [email-configuration.md](email-configuration.md#after-the-upgrade-carry-the-configuration-over) |
| 2 | Run-history retention into `retention.workflowRuns` / `retention.reviewRuns` | `$RUN npm run settings:migrate-run-retention` | `... -- --apply` | [workflows spec](../specs/workflows.md), [review-runs spec](../specs/review-runs.md) |
| 3 | Database backup history and settings | `$RUN npm run db-backup:migrate-legacy -- --dry-run` | `... -- --apply` | [database-restore.md](database-restore.md), [database-backup spec](../specs/database-backup.md) |
| 4 | Storage settings and one secret per S3-family driver | `$RUN npm run storage:migrate-settings` | `... -- --apply` | [storage-configuration.md](storage-configuration.md#upgrade-the-one-time-carry-over); read the warnings table |
| 5 | Geo and face credentials into the platform credential store | `$RUN npm run credentials:migrate-legacy -- --purpose geo`, then `--purpose face`, then `--purpose all` | `... -- --purpose face --purpose geo --apply`; re-run: every line `already present` | [credentials-migration.md](credentials-migration.md#3-procedure) |
| 6 | Notifications (see below the table) | see below | see below | [notifications-cutover.md](notifications-cutover.md#the-carry-over-operator-action-right-after-the-phase-2-deploy) |
| 7 | Telemetry flag, **only if telemetry was exported before** (`OTEL_ENABLED=true`) | `$RUN npm run settings:migrate-telemetry` | `... -- --apply` | [DEVELOPMENT.md](../DEVELOPMENT.md) (telemetry upgrade note); writes only while the namespace is absent |
| 8 | AI provider keys into the platform key store | `$RUN npm run ai:migrate-keys -- --dry-run` | `... -- --apply`; re-run: every line `skipped_existing` | [ai-platform-migration.md](ai-platform-migration.md#3-procedure); fix every `undecryptable` and `failed` line first; **this is a prerequisite since RETRO-E2**, not an option |
| 9 | Android releases copied into the slice's table | `$RUN npm run android:migrate-legacy-releases` | `... -- --apply` | [android-release.md §14](android-release.md#14-cutover-to-the-platform-slice-retro-d5) |
| 10 | Public shares to link grants | done in step 4.6 | done in step 4.6 | [circles-to-groups.md §7](circles-to-groups.md#7-public-shares-to-link-grants-retro-i4) |

**Notifications (row 6), in this order.** Drain or cancel scheduled/sending broadcasts **before** the deploy: the legacy `broadcast_start`/`broadcast_chunk` handlers are retired, `--apply` refuses while a legacy broadcast is `scheduled` or `sending`, and such a broadcast cannot progress. Cancel one in SQL (`UPDATE mh_legacy_notification_broadcasts SET status = 'canceled', canceled_at = now() WHERE status IN ('scheduled','sending');`) and recreate it on `/admin/settings/broadcasts`.

```bash
$RUN npm run notifications:migrate-legacy                                  # dry run: counts per table and type, the settings plan
$RUN npm run credentials:migrate-legacy -- --purpose push_vapid            # dry run of the VAPID key move
$RUN npm run credentials:migrate-legacy -- --purpose push_vapid --apply    # first: the key pair keeps existing browser subscriptions valid
$RUN npm run notifications:migrate-legacy -- --apply
```

Run the dry run again afterwards: every table reports `0 to copy` and `already in the platform shape`.

**Scripts you did not find a place for.** `apps/api/package.json` also defines `settings:verify` (read-only; reports stored settings values the schemas would not accept; [DEVELOPMENT.md](../DEVELOPMENT.md)) and `ai:migrate-keys:dev` (a development-checkout variant of row 8, not for the image). `apps/api/scripts/verify-identity-transform.mjs` is the identity verifier of step 4.9. There is no other `migrate-` or `import-` script in `apps/api/package.json` as of 2026-11-10; re-run `node -e 'for (const k of Object.keys(require("./apps/api/package.json").scripts)) if (/migrate-|import-|:migrate|:import/.test(k)) console.log(k)'` against the release commit before the window in case one was added.

### 4.8 Start the new release

Start the API, web and nginx from the pinned image (`$COMPOSE up -d`; or `update.sh` per the note above). The API reconciles roles and permissions at boot as well. Check `curl -fsS https://app.example.test/api/health/ready` (a 503 here is expected while maintenance is on; the check that matters is `/api/health/live` and the logs, and section 6 after step 4.10). Look at the API log for startup errors and for repeated `legacy`-table warnings. Confirm the restart policy is `unless-stopped` (`infra/compose/prod.compose.yml`).

### 4.9 Identity verification

```bash
$RUN node scripts/verify-identity-transform.mjs verify --before /tmp/before.json   # UNVERIFIED path as in 4.4; add --accept-roleless-viewer only if you accepted that gain
```

Exit 0 means every user has the permissions they had, and the PATs, refresh tokens, device codes, allowlist and node credentials kept their ids and hashes ([identity-adoption.md](identity-adoption.md#run)). New permissions that did not exist before are reported as a NOTICE.

### 4.10 Verify, restart workers, close maintenance

Run **section 6**. Maintenance is still on with `allowAdmins: false`, so the verifier cannot sign in. Either (a) switch `allowAdmins` to `true` for the verification (`PUT /api/admin/maintenance {"enabled": true, "allowAdmins": true}`; the persisted flag survives), do the verification as admins, then disable maintenance; or (b) disable maintenance and verify with users blocked only by announcement. Option (a) is the safer one. Then:

1. Restart the worker nodes (section 5.4) and confirm one claims a job.
2. Disable maintenance: `PUT /api/admin/maintenance {"enabled": false}`.
3. Post the record (section 9) in #592 and commit it to [database-baseline.md](database-baseline.md#14-production-record).

## 5. After deploy: settings

These are not migrations. Until they are done, the features they gate are off.

1. **AI.** `ai.enabled` is **off by default**. Turn it on (`/admin/settings/ai`, `PUT /api/admin/ai/config`), then open `/admin/settings/ai/models` and **enable each feature's model**. With either missing, every AI feature (tagging, video tagging, search, embeddings, the enhancer, transcription, memory titles) stays off ([ai-configuration.md](ai-configuration.md)). Check **Test** on each provider, and **Test embedding** reports 1536 dimensions ([ai-platform-migration.md §5](ai-platform-migration.md#5-verify)).
2. **`JOBS_WORKER_MODE`** in the API environment must be `all` or `system`, **never `off`**: tagging, enhancement and (by default) geocoding run on the API host. `off` leaves every claimable type to a fleet and AI jobs would never run ([jobs-cutover.md §4](jobs-cutover.md#4-environment)).
3. **Geocode on the fleet.** `nodes.jobSecretBrokerEnabled` is **off by default**, so `geocode` runs on the server and no key leaves it. To opt in, follow [geocoding-key.md](geocoding-key.md#turn-it-on): Google as the active provider with a stored key, then switch the broker on at `/admin/settings/workers`. A Google key cannot be revoked per job: restrict it to the Geocoding API and your egress IPs, and rotate it after a node compromise ([worker-fleet.md §5](worker-fleet.md#5-geocode-on-the-fleet-enable-the-broker-and-rotate-the-google-key)).
4. **Re-register every worker node.** The C2 migration marked every node `offline`; `nod_` tokens still work, but the 1.3 protocol is gone. Ship **CLI 1.6.2 or newer** (the version in `apps/cli/package.json` on `main`). Native: `memoriahub node register` (the state directory is now `~/.memoriahub/node/`; a running 1.3 daemon is named by pid, stop it with `kill <pid>`). Containers register themselves at start. Pin the worker image to the API's version (`WORKER_VERSION=<tag>`). Then `/admin/settings/workers` shows every node `online` with the new version ([worker-fleet.md §2](worker-fleet.md#2-rolling-upgrade-drain-upgrade-the-image-re-register), [worker-node-setup.md](../worker-node-setup.md)). Do not leave 1.3 workers running.
5. **Doctor** (`/admin/settings/doctor`, [doctor.md](doctor.md)). Expected: green or an explained warning for every check. Known and accepted: `db.rls_role` **fails** while the API connects as the bootstrap superuser (a row in [local-exceptions.md](../platform-adoption/local-exceptions.md); [application-role.md](application-role.md)). Anything else red is a finding: record it, do not wave it through.
6. **Telemetry** (T1-T4): if it was off before, it stays off; if it was exporting, step 4.7 row 7 kept it on. Watch API error rate and database latency for 24 hours and record anomalies in #592.

## 6. Verification checklist

Do it as three real accounts: admin, contributor, viewer. Tick each; record any failure with the exact message.

- [ ] `curl -fsS https://app.example.test/api/health/live` and `/api/health/ready` both 200 (maintenance off, or `allowAdmins: true`).
- [ ] Sign in as admin, contributor and viewer: each keeps exactly the permissions they had (step 4.9 passed). `GET /api/auth/me` shows the expected roles.
- [ ] Gallery loads in a shared library and in "My library"; an existing album opens; a face or tag job result is visible on an old photo.
- [ ] **Upload** one photo into a shared library and one into "My library"; both appear and their jobs run.
- [ ] **Create a group** at `/settings/groups` and **upload into it at once**. (After K2 the asynchronous mirror window of the earlier release is gone; this must work immediately. A failure here is a K2 finding.)
- [ ] **Old public links:** one `/s/<token>` media link and one album link open (they land on `/s#lnk_<token>`); one revoked link says "This link is not available". Create a new link from an album and revoke it at `/admin/settings/sharing`.
- [ ] **An invite sign-in:** invite a test address from a library's Invites tab (it is allowlisted and receives the group invitation); sign in as that account and land in the library. A pre-window pending invite signs in and joins.
- [ ] **Search and AI** (after step 5.1): a keyword search; one agentic search; tag one photo; the AI Usage page records the call.
- [ ] **Android:** an existing paired device checks in with its **existing PAT** (the device's `lastSeenAt` moves on `/settings/android-app` or the media-sync device list). The Android Hub screen still reads `GET /api/circles/:id` (open item [#675](https://github.com/marinoscar/MemoriaHub/issues/675)): confirm it still shows its target library; this is the one place a pre-K2 contract could break on a phone.
- [ ] **CLI:** `memoriahub login` and a call with an existing PAT work.
- [ ] **Workers:** `/admin/settings/workers` lists every node `online`; a node claims a job and the job reaches `succeeded` with `executor = 'node'`; a `nod_` credential is refused on `GET /api/media` (403).
- [ ] **Doctor** as in section 5.5.
- [ ] **SQL checks** (read-only, as the table owner): [circles-to-groups.md §9 verification](circles-to-groups.md#procedure) (circles gone, 21 scope triggers, 0 old triggers, every row names a scope that exists and every owner matches); the C2 queries in [worker-nodes-cutover.md](worker-nodes-cutover.md#deploy) (counts equal the before counts, both legacy tables `NULL`); `SELECT count(*) FROM group_invites WHERE accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL` by role matches the I5 `NOTICE` ([circles-to-groups.md §8 step 3](circles-to-groups.md#8-circle-invites-to-group-invites-retro-i5)).
- [ ] **Row counts** equal the step 4.4 before-counts for every table that was renamed or copied.

## 7. Rollback

**Trigger:** any failure in steps 4.5 to 4.9 that you cannot fix in place within the window, or a verification failure that loses data or access. Keep maintenance **on**.

1. Stop the API and web (`$COMPOSE stop api web`) and the worker fleet.
2. Restore the step 4.3 backup with the scratch-database-and-rename path ([database-restore.md](database-restore.md)). On an older archive the in-app restore answers `blocked` on the schema check; follow that runbook's guidance for a pre-cutover archive. Verify the restored database before renaming it into place.
3. Redeploy the **previous** image tag (the one recorded in section 9 as "before") for the API, web and CLI-facing containers. Do not start the new image against the restored database.
4. Verify: sign in, gallery, one upload, `/api/health/ready`. Close maintenance. Re-register the old worker fleet if it was running 1.3 (its `nod_` tokens are unchanged).
5. Open a bug issue with the failing report block, the output of the failed step and the exact image tags. Fix in a PR, re-rehearse, re-schedule. Rows written after the migrations are lost with the restore; that is the cost of a rollback and the reason maintenance was on.

**What cannot be reverted without the restore** (there are no down-migrations and an installed migration is never edited):

| Step | Why |
|---|---|
| Baseline apply and the rename migrations | The legacy objects are renamed (`mh_legacy_*`); the previous binary reads the old names ([database-baseline.md §11](database-baseline.md#11-release-train-rollback)) |
| I4 | Drops `media_shares` (after the import; before it, the migration refuses). Before the migration: revert the image; the imported grants can be deleted ([circles-to-groups.md §7](circles-to-groups.md#7-public-shares-to-link-grants-retro-i4)) |
| I5 | Drops `circle_invites` in the same transaction as the copy |
| C2 | Drops `mh_legacy_worker_nodes` and `mh_legacy_node_credentials` ([worker-nodes-cutover.md, Rollback](worker-nodes-cutover.md#rollback)) |
| K2 | Drops `circles`, `circle_members` and `CircleRole`; the release before K1 cannot run on it ([circles-to-groups.md §9, Rollback](circles-to-groups.md#rollback)) |

What reverts by redeploying the previous image alone (only if the migrations in question have **not** run): the data scripts of step 4.7 never modify a legacy table, so the previous release restores the old readers; their rollback notes are in the linked runbooks (the original notification policy is kept under `mhLegacyNotifications`, the original database-backup settings under `mhLegacyDatabaseBackup`).

Record in section 9: the time rollback started and ended, the backup run id used, and the tag redeployed.

## 8. Known gaps and follow-ups

Not blockers for the window; each has an owner or an issue.

| Item | Detail |
|---|---|
| **E3 release N+1** (#605) | Drops the legacy AI table `ai_provider_credentials`. Do it **only after release N (this window) has run in production** and the key import is verified ([ai-platform-migration.md](ai-platform-migration.md)). A `migration-lock` PR |
| **A6 production record** | The owner commits section 9 to [database-baseline.md](database-baseline.md#14-production-record) and updates the status line of [platform-adoption/README.md](../platform-adoption/README.md#status) |
| **`location_suggestion_run_*` shim check** | Run `SELECT status, count(*) FROM jobs WHERE type LIKE 'location_suggestion_run_%' GROUP BY 1;` (the query is in [local-exceptions.md](../platform-adoption/local-exceptions.md), the shim row for RETRO-C6). Zero pending/running rows: delete both handlers and their module registrations (the labels stay) |
| **Android Kotlin** [#675](https://github.com/marinoscar/MemoriaHub/issues/675) | The Hub still reads `GET /api/circles/:id`; the native module has not moved to groups |
| **Legacy shims and tables** | The `mh_legacy_*` tables kept by D3, D4, D5 and the legacy fragments, the old settings keys and the `PLATFORM-ADOPTION-SHIM` markers go in cleanup `migration-lock` PRs, one at a time ([local-exceptions.md](../platform-adoption/local-exceptions.md)). The old `workflows.runHistoryRetentionDays` and `reviewRuns.runHistoryRetentionDays` keys wait for RETRO-C11 |
| **Staging worker test and image gate** | Section 1; if the window slips past them, they are the reason |
| **EnterpriseAppBase seam requests** | Open: #1143, #1144, #1145, #1119 (opt-in node credential delivery; needs the owner's decision), plus [EAB#1134](https://github.com/marinoscar/EnterpriseAppBase/issues/1134) (releases on a non-active provider cannot be downloaded or deleted through the android-app slice) |
| **J-series packages** (J1, J2 merged, **private**) | Nothing is published. The registry decision (public npm, a private registry or GitHub Packages) is the owner's and is not part of this window ([release-memoriahub-packages.md](release-memoriahub-packages.md)) |
| **Application role** | `db.rls_role` fails until the API connects as the non-superuser role ([application-role.md](application-role.md)) |
| **UNVERIFIED in this page** | The I4 ordering option (4.6); the identity snapshot path from a one-off container (4.4, 4.9); whether `update.sh` finds nothing to migrate after the manual migration (4.8); the exact `db:baseline` order with the committed tree (4.5) |

## 9. Production record template

Copy into #592 and into [database-baseline.md §14](database-baseline.md#14-production-record). Fill it in during the window. Never write a password, key, token or archive URL here.

```
Window
  Date / start / end (UTC):
  Operator / approver / verifier:
  Maintenance opened / closed:
  Duration of the migrations (4.5 to 4.7):

Images
  Release commit (sha):
  API image tag:                Web image tag:
  Worker image tag:             CLI version:
  Previous API image tag (rollback target):

Backup
  Run id:                       verifiedAt:
  Size:                         sha256:
  Stored at (description only, no URL):

Gates
  Staging worker test (run date, result):
  Worker image build + HEIC gate (workflow run URL):
  Staging rehearsal of the train (date, link):

Baseline (4.5)
  B1 / B2 / B3 / B4 / B5 / last line (paste from the dry run):
  Diff against staging dry run: none / attach
  "baseline applied and verified": yes / no
  Order used (bare prisma:migrate before or after the baseline apply):

Migrations (4.6)
  Option used (A or B), and any P3009 / resolve output:
  sharing:import-media-shares dry run: media_shares N (active / expired / revoked):
  sharing:import-media-shares --apply: imported / already there / invalid / re-keyed:
  NOTICE RETRO-I2:
  NOTICE RETRO-I5: circle_invites T (claimed C; personal P; member M); imported N
  RETRO-C2 / RETRO-K2: passed / refused (text):
  db:check / db:check:database / db:baseline results:

One-off scripts (4.7), dry-run counts and apply results
  email:migrate-settings:
  settings:migrate-run-retention:
  db-backup:migrate-legacy:
  storage:migrate-settings (warnings):
  credentials:migrate-legacy (geo, face, push_vapid):
  notifications:migrate-legacy:
  settings:migrate-telemetry (run / not needed):
  ai:migrate-keys:
  android:migrate-legacy-releases:

Settings (5)
  ai.enabled on, models enabled:      JOBS_WORKER_MODE:
  nodes.jobSecretBrokerEnabled:       Nodes re-registered (count):
  Doctor (failing/warning checks and why):

Verification (6): each item ticked / failed (message)
Row counts before / after (4.4):
Rollback used: no / yes (start, end, backup run id, tag)
Anomalies in the first 24 hours (error rate, DB latency):
Follow-ups opened (issue numbers):
```
