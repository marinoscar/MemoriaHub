# Alerts

MemoriaHub mounts the platform alerts slice (`@marinoscar/platform-api/alerts`, RETRO-H5, issue #609). This runbook covers what MemoriaHub adds on top of it; the slice itself (rule kinds, the incident state machine, evaluation, dispatch, the admin routes) is described in the package's README.

## How it works here

- **Where.** Admin Console, Operations, **Alerts** (`/admin/settings/alerts`). Reading needs `alerts:read`, editing, testing and acknowledging need `alerts:write`. Both are system permissions held by the `admin` role.
- **Evaluation.** Every minute `AlertsEvaluateTask` enqueues one `alerts.evaluate` job; a worker evaluates every enabled rule (20 s budget per rule, read-only) and opens, fires or resolves incidents. There is at most one open incident per rule and label set (the raw-SQL index `alert_incidents_open_uniq_idx`). Resolved incidents are purged after 90 days (`alerts.incidents_purge`, daily). All three job types are server-only and visible at `/admin/settings/jobs`.
- **Notifications.** A rule that fires (after its `for` window) or resolves notifies every holder of `alerts:read` through the `alerts.alert_fired` / `alerts.alert_resolved` events (email, bell, push), outside the rule's cooldown (15 minutes after a resolve). Users can mute them in their notification preferences.
- **Webhooks.** Not yet: the webhook port is unbound until the webhooks slice is mounted (RETRO-H4). A rule's "Webhook" switch has no effect meanwhile.
- **Telemetry.** `metric_threshold` and `verdict` rules read the GreptimeDB store. With telemetry off or the store unreachable they cannot be evaluated: the rule's last error says so and its incidents are left as they were. Turn on the `telemetry.unavailable` starter rule to be told.

## The rules MemoriaHub ships

The platform seeds eight starter rules, disabled. On a new deployment MemoriaHub seeds five rules first, **enabled in production** and disabled anywhere else. A rule is only ever created when its key has no row: once it exists, an operator's edit (including disabling it) survives every restart. A rule with a key can be edited and disabled, never deleted. A deployment whose platform seed ran before this release (alerts mounted outside production first) keeps its starters disabled; enable them in the page.

| Rule | Kind | Fires when | Severity |
|---|---|---|---|
| Worker node offline (`nodes.offline`, starter) | `node_offline` | A worker node is stale (no heartbeat within the fleet's stale window) or offline, for 1 minute. One incident per node. | critical |
| Job failure spike (`jobs.failure_spike`, starter) | `metric_threshold` | More than one job per minute failed permanently, on average, over 5 minutes. | warning |
| Enrichment failures by job type (`memoriahub.enrichment_failures`) | `metric_threshold` over `app.jobs.settled` | More than 5 jobs of one type failed permanently in the last hour, for 10 minutes. One incident per `job_type` (face detection, video face detection, tagging, video tagging, geocode, enhancement, memories, ...). | warning |
| Enrichment queue stalled (`memoriahub.queue_stalled`) | `memoriahub_queue_stalled` | More than 500 claimable jobs are pending and none succeeded in 30 minutes, for 5 minutes. | critical |
| Database backup stale (`memoriahub.db_backup_stale`) | `memoriahub_db_backup_stale` | Scheduled backups are on and the newest completed backup is older than 2 schedule intervals (48 h for daily, 14 days for weekly, 62 days for monthly, 48 h for a cron schedule by default). A schedule that has never completed a backup alerts once its first attempt is that old. | critical |
| Node on battery, battery low, host CPU high, host memory low, telemetry verdict critical, telemetry unavailable (starters) | built-ins | See the page. | left disabled: operator's choice |

Notes:

- **`nodes.offline` sees no node until RETRO-C2.** It reads the platform `worker_nodes` table; MemoriaHub's nodes are still registered in `mh_legacy_worker_nodes`. Until C2, use the Doctor's node checks and `/admin/settings/nodes` (see `docs/platform-adoption/local-exceptions.md`).
- **The failure rules need telemetry.** `jobs.failure_spike` and the per-type rule read the platform job metric `app.jobs.settled` (label `job_type`, never an org or user id). Enable telemetry at `/admin/settings/telemetry`.
- **These complement, not replace, the in-app inbox.** The `enrichment_failed` notification still rolls permanent failures up per job type for administrators; alerts are the operator channel with a threshold and a resolve.

## First three things to check

### Worker node offline
1. **Doctor** (`/admin/settings/doctor`, category Worker Nodes): heartbeat freshness and expired leases.
2. **Worker Nodes** (`/admin/settings/nodes`): the node's last heartbeat; failed jobs claimed by it at `/admin/settings/jobs?status=failed`.
3. **On the node**: `memoriahub node status` and `memoriahub node logs --follow` (or the container logs). An OOM kill shows in `dmesg`. A node that was deregistered on purpose alerts until the fleet retention prunes it: disable the rule or remove the node record.

### Job failure spike / Enrichment failures by job type
1. **Jobs** (`/admin/settings/jobs?status=failed`, filter by the incident's `job_type`): read `lastError` of the newest rows.
2. **Doctor**: the provider checks for that feature (AI tagging and transcription, face, geocode, picture enhancer). A provider credential that expired or a sidecar that is down fails every job of one type.
3. **Logs**: the API container logs for the job type, and `memoriahub node logs` when the type runs on worker nodes. Retry with "Retry all failed" once fixed; the incident resolves when the rate falls back under the threshold.

### Enrichment queue stalled
1. **Jobs** (`/admin/settings/jobs`): running and stuck counts; whether anything is claimed. `JOBS_WORKER_MODE=off` with no node fleet runs nothing.
2. **Doctor**: `jobs.worker` and `jobs.backlog`.
3. **Logs**: the API container (crash loop, OOM, a handler hanging until its timeout) and the node logs. Reset stuck jobs from the Jobs page if the reaper has not.

### Database backup stale
1. **Database Backup** (`/admin/settings/db-backup`): the newest runs and their errors; the next scheduled time.
2. **Doctor**: `backup.schedule`, `backup.pg-client`, `backup.rls-bypass`, and the storage provider checks.
3. **Jobs** (`/admin/settings/jobs?type=db.backup.run`): whether the run was enqueued and how it ended. Run a backup now once fixed; the incident resolves at the next evaluation after it completes.

## Turning alerts off

Disable a rule with its switch in the page (immediate). There is no environment variable. Rolling back the release leaves the `alert_rules` / `alert_incidents` rows in place (they come from platform migration `0040_add_alerts`); nothing reads them without the slice.
