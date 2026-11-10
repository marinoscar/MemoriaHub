# Runbook: the MemoriaHub worker fleet

RETRO-C11 (issue [#620](https://github.com/marinoscar/MemoriaHub/issues/620), epic #559, program #555). How to scale, upgrade, watch and recover a fleet of MemoriaHub worker nodes. The queue, the node control plane and the node engine are the EnterpriseAppBase (EAB) platform's; this page keeps only what is MemoriaHub-specific. For the platform side read the EAB documents `docs/runbooks/run-worker-nodes.md`, `docs/specs/worker-nodes.md` and `docs/specs/job-queue.md` (in the EnterpriseAppBase repository, shipped with the `@marinoscar/platform-*` packages).

Related MemoriaHub pages: [setup and troubleshooting](../worker-node-setup.md), [container configuration](../worker-container-config.md), [what is node-eligible and why](../specs/distributed-nodes.md), [the geocoding key](geocoding-key.md), [the cutover that moved the fleet](worker-nodes-cutover.md).

## Ground rules

- A node runs only the eight node-eligible types: `face_detection`, `video_face_detection`, `duplicate_detection`, `metadata_extraction`, `social_media_detection`, `thumbnail_regen`, `geocode` and `workflow_execute_batch`. Everything else, and every AI type (`auto_tagging`, `video_auto_tagging`, `picture_enhancement`), runs on the API host. The API's `JOBS_WORKER_MODE` must therefore be `all` or `system`, never `off`.
- A node holds a `nod_` credential. That credential is accepted on `/api/nodes/*` only; it cannot reach media, settings or admin routes even if its owner is an administrator.
- No provider API key is delivered to a node. The one exception is the Google geocode key, through the platform per-job secret (`POST /api/nodes/:id/jobs/:jobId/secret`): per job, in node memory only, bounded by the job's lease, and only when `nodes.jobSecretBrokerEnabled` is on (default off), Google is the active provider and a key is stored. The platform's opt-in persistent node-side credential cache is not implemented in MemoriaHub.
- Permissions are `nodes:read` and `nodes:write` (system scope, administrators). The Local Media Backup routes under `/api/nodes/:id/backup/*` need `nodes:write` and the node's owner.
- Telemetry: the dashboard groups `queue` and `nodes` (platform) and the MemoriaHub `enrichment` and `fleet` groups show backlog, claim latency, node heartbeats and per-type failures. The telemetry runbook (`docs/runbooks/telemetry.md`) describes the groups.

## 1. Scale up or down

Containers are the recommended fleet (the compose bundle is generated: `infra/compose/worker.compose.yml` with the `app.worker.*` overlays).

```bash
cd infra/compose
# one worker plus its own CompreFace sidecar per replica set
docker compose -f worker.compose.yml -f app.worker.memoriahub.compose.yml \
  -f app.worker.compreface.compose.yml up -d --scale worker=4
```

- Give every replica a distinct identity. Leave `MEMORIAHUB_NODE_NAME` empty and each replica registers under a generated name; a fixed name makes replicas re-attach to the same node row and fight over it.
- Concurrency per replica is `MEMORIAHUB_CONCURRENCY` (default 2 in the overlay). Prefer more replicas over a higher number: each concurrent job holds a decoded image or a video temp file.
- To scale down, `docker compose ... up -d --scale worker=2`. The surplus replicas receive SIGTERM and drain (the overlay's `stop_grace_period` is 180 s): they finish the jobs they hold, then exit. A job still held at the end of the grace period is requeued by the platform reaper when its lease lapses; nothing is lost.
- Check `/admin/settings/workers`: the fleet table lists each node, its status, heartbeat age, version, concurrency and offered types.

## 2. Rolling upgrade (drain, upgrade the image, re-register)

1. Pin the new tag: `WORKER_VERSION=<tag>` in the bundle's `.env` (or `WORKER_IMAGE`). The version should equal the API's.
2. Replace replicas in batches: stop a replica with `docker stop <container>` (SIGTERM drains it) and bring the new one up with `docker compose ... up -d --scale worker=N`, or recreate with `--force-recreate` when a short drop in capacity is acceptable.
3. A replica registers itself at start in headless mode. A node record that already exists under the same name is re-attached (the register call is idempotent per owner and name), so no manual step is needed.
4. **Upgrading from CLI 1.3 (a one-time step).** The 1.3 daemon spoke the old protocol and its record was marked offline by the C2 migration, so every node must re-register: run `memoriahub node register` on a native install (a container does it by itself). The `nod_` token stays valid. If a 1.3 daemon is still running, the CLI names its pid; stop it with `kill <pid>` first. The state directory moved from `~/.memoriahub/` to `~/.memoriahub/node/` (pidfile, socket, logs, models); `MEMORIAHUB_STATE_DIR` now points at that directory only and no longer relocates `config.json`.
5. Verify on `/admin/settings/workers` that every node is `online` with the new version, then watch the `queue` group for the backlog draining.

Do not leave 1.3 workers running: they speak the old protocol and cannot claim at all.

## 3. Stuck or abandoned jobs

There is nothing to reset by hand. The platform reaper (`JOBS_REAPER_ENABLED`, on by default and independent of `JOBS_WORKER_MODE`) requeues a claimed job whose lease lapsed without a renewal; the lease and the reaper's patience derive from the job type's execution profile (`maxRuntimeMs`). A job that keeps killing its worker is failed once `attempts` reaches the profile's `maxAttempts` (`JOBS_MAX_ATTEMPTS` is the default for types without a profile), so an out-of-memory job cannot crash-loop forever.

- A late result from a node whose lease was reaped is rejected (the claim token no longer matches); the new holder's result wins.
- Look at `/admin/settings/jobs` for the `failed` list; **Retry** requeues one job and **Retry all failed** requeues a type.
- `POST /api/admin/jobs/reset-stuck` still exists for a manual sweep; you should not need it.
- A node that goes silent is marked offline by the fleet sweep (`nodes.fleet.sweep`) after `staleHeartbeatSeconds x offlineStaleMultiplier` (the `nodes` settings namespace) and pruned after `offlineRetentionDays` when it holds no jobs.

## 4. Revoke a node credential

1. `/admin/settings/workers`, section **Node credentials**: find the credential (by node or owner) and revoke it. Or `DELETE /api/node-credentials/:id` (the owner) or `DELETE /api/admin/nodes/credentials/:id` (an administrator).
2. The node's next call is refused with 401, its in-flight jobs are requeued when their leases lapse, and any per-job secret it held is revoked (the Google key is shared, so also rotate it: section 5).
3. Mint a replacement with `memoriahub node enroll` (interactive, device-flow) or from the same page ("create, copy once"). The token is shown once and is never retrievable again.

## 5. Geocode on the fleet: enable the broker and rotate the Google key

Off by default, and only meaningful when reverse geocoding uses Google. Steps, the failure modes (`job_secret_broker_disabled`, `broker_unusable`) and the residual risk are in [the geocoding key runbook](geocoding-key.md). In short:

1. `/admin/settings/geo`: select **Google**, store the key.
2. `/admin/settings/workers` (the `nodes` settings card): switch on **per-job secret brokering**.
3. A Google key cannot be revoked per job. Restrict it to the Geocoding API and to your egress IPs in Google Cloud, and **rotate it** after a node compromise: create the new key, store it at `/admin/settings/geo`, revoke the node's credential (section 4), delete the old key.
4. To stop all key egress, switch the broker off. `geocode` then runs on the API host.

## 6. Read node vitals and events

`/admin/settings/workers` (route replaced `/admin/settings/nodes`, which redirects):

- **Fleet table**: status (`online`, `draining`, `offline`, `disabled`), last heartbeat, offered types, concurrency, claimed and running counts, version.
- **Node vitals dialog**: heap used, state-directory disk used, job slots in use, CPU and the counters (claims, succeeded, failed, rate limited, empty polls, claim failures, lease renewals and renewal failures, heartbeat failures, watchdog trips). Use it to see which replica is near its heap ceiling before it recycles. **Events timeline**: the node's lifecycle events.
- **Doctor** (`/admin/settings/doctor`, category `nodes`): registered nodes, heartbeat freshness, expired leases and per-node capability health (the last `node doctor` summary).
- On the node itself: `memoriahub node status`, `memoriahub node logs`, `memoriahub node doctor` (see [setup and troubleshooting](../worker-node-setup.md)).

## 7. Heap snapshot over IPC

For a suspected memory leak, ask the live daemon for a V8 heap snapshot without restarting it (a restart discards the state that names the retainer):

```bash
memoriahub node heap-snapshot          # native install; talks to the daemon over node.sock
docker compose exec worker memoriahub node heap-snapshot   # container
```

The file (`heap-manual-<pid>-<time>.heapsnapshot`) lands in `<state dir>/heap-snapshots/` (`~/.memoriahub/node/heap-snapshots/` natively, `/var/lib/worker/heap-snapshots/` in the container); the platform keeps only the newest few and skips the write when the disk is short. Copy it out and open it in Chrome DevTools. The memory valve writes a snapshot of its own before it drains. `MEMORIAHUB_HEAP_SNAPSHOTS=0` suppresses snapshot writing. A heap snapshot can contain media metadata and tokens held in memory: treat the file as sensitive and delete it after use.

## Known gaps

- The staging end-to-end test (a 2,000-item import, HEIC photos, a 2 GB video, API replica restarts) has not been run on the platform engine.
- The social-media and video-face settings (`socialMedia.*`, `face.video.*`) are not in the job payload: nodes use the old defaults (5 s sampling, 60 frames, 0.8 confidence) whatever the admin saved. The API host honours the settings.
- Open platform seam requests: EAB #1143 (`WorkerNode` extensible, 404 for a foreign node, a `models/*` route), #1144 (`ProviderRateLimitError` export; the shim loads it by file URL) and #1145 (daemon channel commands; the `backup.sock` shim). See [local-exceptions.md](../platform-adoption/local-exceptions.md).
