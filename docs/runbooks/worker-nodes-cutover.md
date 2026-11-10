# Worker nodes on the platform nodes slice (RETRO-C2, #581)

The worker-node fleet (registration, claim, credentials, the admin routes, the fleet sweeps) is `@marinoscar/platform-api/nodes`. The old node plane in `apps/api/src/nodes/` is deleted. Design and what runs on a node: [distributed-nodes.md](../specs/distributed-nodes.md#9-permissions-and-routes). Every deviation from the platform: [local-exceptions.md](../platform-adoption/local-exceptions.md).

## What the release changes for an operator

| Before | After |
|---|---|
| `mh_legacy_worker_nodes`, `mh_legacy_node_credentials` | the platform's `worker_nodes`, `node_credentials` (rows copied, ids and token hashes kept) |
| node routes gated by `jobs:read` / `jobs:write` | `nodes:read` / `nodes:write` (system scope, admin only) |
| `/admin/settings/nodes` | `/admin/settings/workers` (the old address redirects) |
| `NodeStaleOfflineTask`, `NodeOfflinePruneTask` crons | the jobs `nodes.fleet.sweep` and `nodes.fleet.prune` (kill-switches `NODE_STALE_OFFLINE_ENABLED`, `NODE_OFFLINE_PRUNE_ENABLED`) |
| `NODE_HEARTBEAT_STALE_SECONDS`, `NODE_OFFLINE_STALE_MULTIPLIER`, `NODE_OFFLINE_RETENTION_DAYS` | still read, but only as the DEFAULTS of the `nodes` settings namespace; save the namespace in the admin UI to override |
| `POST /api/nodes/:id/jobs/:jobId/credentials` handed a node the AI or geocode key | deleted. **No AI key reaches a node**; the Google geocode key reaches one only through `POST /api/nodes/:id/jobs/:jobId/secret` (opt-in). |

## AI compute is server-only; geocode runs on the server unless you opt in

`auto_tagging`, `video_auto_tagging` (and the two enhancement types) are server-only for good (AI rule 3): their provider key never goes to a node. `geocode` is node-eligible again since RETRO-C6, but its Google key reaches a node only through the platform per-job secret (`POST /api/nodes/:id/jobs/:jobId/secret`), which is **off by default** (`nodes.jobSecretBrokerEnabled`, the Workers settings card). Consequences:

- With the switch off, no active Google provider or no stored Google key, the platform withholds `geocode` from nodes and the server's own worker runs it: nothing fails for want of a secret. The API's `JOBS_WORKER_MODE` must be `all` (the default) or `system` (`system` claims every type no node may take right now, geocode included). **`off` leaves the AI types unclaimed.**
- To geocode on the fleet: select Google at `/admin/settings/geo`, store the key, switch on the broker at `/admin/settings/workers`. The node asks for the key per job, keeps it in memory only and never writes it to disk, env or argv. See [the geocoding runbook](geocoding-key.md).
- A fleet keeps serving the other node-eligible types: `face_detection`, `video_face_detection`, `duplicate_detection`, `metadata_extraction`, `social_media_detection`, `thumbnail_regen`, `workflow_execute_batch`.
- A node that still sends the old `POST /api/nodes/:id/jobs/:jobId/credentials` request gets a 404.

## Until the CLI engine moves (RETRO-C10)

The 1.3 CLI speaks the old protocol (a flat register body, a claim that returns a presigned `inputUrl`, no claim token). **No MemoriaHub node can claim until C10.** Keep `JOBS_WORKER_MODE=all` and leave the fleet stopped. The Local Media Backup routes and `GET /api/nodes/models/manifest` keep their shapes, so `memoriahub backup ...` and `node install-deps` still work; a `403` from a backup route for a node the caller does not own is now a `404`.

## Deploy

1. Back up the database (`/admin/settings/db-backup`, or `pg_dump`). Rehearse on a restored copy first: `cd apps/api && POSTGRES_DB=<scratch> npm run prisma:migrate`, then check the counts below.
2. Stop the worker fleet (they cannot claim anyway) and deploy the API and web.
3. `npm run prisma:migrate --workspace=api` applies `20261109300000_c2_worker_nodes_to_platform` (one transaction; a count check aborts and rolls it back if a row was not copied).
4. `npm run prisma:seed --workspace=api` (the new permissions `nodes:read` / `nodes:write` go to the `admin` role; the API's boot reconcile also adds them).
5. Verify:

```sql
select status, count(*) from worker_nodes group by 1;            -- every node 'offline' (or 'disabled'), same count as before
select count(*) from node_credentials;                            -- same count as mh_legacy_node_credentials had
select count(*) from node_backup_configs c join worker_nodes w on w.id = c.node_id;   -- equals count(*) of node_backup_configs
select to_regclass('mh_legacy_worker_nodes'), to_regclass('mh_legacy_node_credentials');  -- both NULL
```

6. In the admin UI open `/admin/settings/workers`: the nodes are listed (offline) and their credentials are in the Node credentials section. `/admin/settings/nodes` redirects.

## Rollback

Revert the release (API and web) and restore the backup: the migration drops the two legacy tables, so a revert without the restore leaves the old code without its tables. Nothing else depends on the new columns. Do not start a 1.3 fleet against the reverted API with the backup restored from before the migration unless its credentials are still valid (they are: the hashes are unchanged).

## Proof

`apps/api/test/nodes/worker-nodes-migration.db.spec.ts` (the copy, the credential hashes and a token validated through the platform `NodeCredentialService`, the backup foreign keys, the dropped tables), `apps/api/test/nodes/node-round-trip.db.spec.ts` (register re-attach, claim, result, settle, the server-only rule, `NodeJobInputsAdapter`) and `apps/api/test/nodes/nodes-mount.spec.ts` (a `nod_` credential reaches the backup and manifest routes and nothing else, another user's node is a 404, no credentials route).
