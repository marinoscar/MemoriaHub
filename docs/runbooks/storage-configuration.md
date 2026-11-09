# Storage configuration (platform storage slice)

Since RETRO-D1 ([#563](https://github.com/marinoscar/MemoriaHub/issues/563)) MemoriaHub's object storage is the platform storage slice (`@marinoscar/platform-api/storage`). This runbook is for an operator: where the configuration lives now, the one-time carry-over on upgrade, how to switch or migrate providers, and what to check when something is wrong.

## Where the configuration lives

| What | Where | Edited at |
|---|---|---|
| The active driver (`s3`, `r2`, `s3compatible`, `local`) | `storage.provider` in the `global` system-settings row | Admin → Settings → Object Storage (`/admin/settings/storage`) |
| Each driver's non-secret settings (bucket, region, endpoint, account id, access key id, path style; the local root) | `storage.drivers.<id>` | same page |
| Each S3-family driver's secret access key | credential store, purpose `storage`, name = the driver id (`storage/s3`, `storage/r2`, `storage/s3compatible`), encrypted with `SECRETS_ENCRYPTION_KEY`. The shared `storage/default` slot is read only as a fallback while a driver's own is empty | same page: the active driver's write-only field, and one write-only field per other configured driver ("other drivers' credentials"), saved without switching |
| Storage Insights cadence, Trash retention | `storage.insights`, `storage.trash` (MemoriaHub's fields in the same namespace) | System Settings |
| Deployment limits | `MAX_FILE_SIZE`, `ALLOWED_MIME_TYPES`, `SIGNED_URL_EXPIRY`, `STORAGE_PART_SIZE` | environment |

No longer read: `STORAGE_PROVIDER`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_MAX_ATTEMPTS`, `S3_RETRY_MODE`, `BACKUP_LOCAL_PATH`, the `storage.activeProvider` setting and the `storage_provider_credentials` table. The table and the old key stay in the database for one release so a rollback needs no re-entry of secrets; a later release drops them.

The permission to view the page is `storage_config:read`, to change it `storage_config:write` (both administrators only; they replace `storage_settings:*`).

## Upgrade: the one-time carry-over

Run it once, right after deploying the release, **with the environment the previous release ran with** (the variables above are where their values still are):

```bash
docker compose ... exec api npm run storage:migrate-settings --workspace=api              # dry run
docker compose ... exec api npm run storage:migrate-settings --workspace=api -- --apply
```

It is idempotent and set-if-absent: a value an administrator saved since is never overwritten, and a second run reports nothing to write. It does three things:

1. **Settings.** `storage.provider` from `storage.activeProvider` (else `STORAGE_PROVIDER`, else `s3`); `storage.drivers.<id>` from each `storage_provider_credentials` row (an R2 row's endpoint gives the account id; a row with an endpoint keeps path-style addressing), else from the `S3_*` variables for a provider with no row; `storage.drivers.local.rootDir` from `BACKUP_LOCAL_PATH`.
2. **Secrets, one per driver.** EVERY S3-family provider's secret access key from its legacy row into that driver's own address (`s3` into `storage/s3`, `r2` into `storage/r2`; decrypted with the legacy cipher, re-encrypted by the credential store, read back and compared), set-if-absent; `AWS_SECRET_ACCESS_KEY` for a provider configured from the `S3_*` variables (no row). So a deployment with objects on S3 and on R2 under different key pairs keeps reading both. `storage/default` is not written. An undecryptable row stops the run and nothing is written.
3. **Report.** `storage_objects` per recorded provider and every warning.

Then open `/admin/settings/storage`, press **Test connection**, and look at the Doctor's `storage.config` and `storage.bucket` checks.

### The warnings, and what to do

| Warning | Meaning | Action |
|---|---|---|
| `"x"` names no platform driver | A credential row or object rows name an id no driver registers. | Fix the provider at `/admin/settings/storage`. Rows recorded on an unknown id are read through the active driver. |
| provider `"x"` (n objects) has no legacy secret | An S3-family provider that holds objects (or the active one) had neither a credential row with a secret nor, for an environment-configured provider, `AWS_SECRET_ACCESS_KEY`. Its rows cannot be read until it has one. | Enter that driver's secret access key on the page (its own field; no switch needed). |
| a credential row is disabled | Its settings were carried over all the same. | Nothing, unless you meant to drop it. |

## The `local` driver

Objects as files under one folder on the API host: `<rootDir>/<key>`, with `<key>.meta.json` beside each file and open resumable uploads under `<rootDir>/.multipart/<uploadId>/`. The layout did not change, so objects written before the upgrade are read where they lie. Leave **Root directory** empty for `/tmp/memoriahub-backup` (the old default). Changing it strands every object already written there.

- Resumable uploads go through the API (`partUploadAuth: 'bearer'`, `PUT /api/storage/objects/:id/upload/parts/:n`): the web, the CLI and the Android app already use that path.
- Downloads are short-lived signed links to `GET /api/storage/local/objects/<token>` (HMAC under a sub-key of `SECRETS_ENCRYPTION_KEY`). Before the upgrade they were `file://` URLs that no browser could open.
- Worker-node output uploads (signed PUT) are not supported on `local`; select an S3-family driver for node offload.

## Switching providers and migrating objects

Switching the active driver affects new uploads only: every row records its provider and bucket and keeps being served from there (per-row routing). The page asks for the `SWITCH` confirmation when objects would be left on the old provider.

To move existing objects, use the **copy-only migration** panel on the same page (`POST /api/admin/storage/migrations`, jobs `storage.migrate_plan` and `storage.migrate_object`). Each object is streamed, verified (byte count and sha256 read back from the target) and only then repointed; the source object is left in place. A second run skips objects already on the target. At most one run is active at a time.

MemoriaHub's own migration (`/api/storage-settings/migrate*`, job `storage_migration`) is retired. Its history stays in `mh_legacy_storage_migration_runs` / `_items`, read-only. A `storage_migration` job still queued at the upgrade settles without copying (it logs a warning); re-run the migration from the page.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `503 Object storage is not configured` | The active driver's settings or secret are incomplete. | Fill them in at `/admin/settings/storage`; the message names the missing fields. Run the carry-over if you upgraded. |
| Old photos answer "not found" after the upgrade, new ones work | Their rows record a provider whose settings or secret did not carry over (see the warnings). | Run the carry-over dry run and read its warnings; enter the missing driver settings and that driver's own secret on the page. |
| Uploads stay `processing` | Post-upload processing is the `storage.object.process` queue job now; no worker runs it, or the queue is backlogged. | Check `/admin/settings/jobs` for that type; the job retries and, on giving up, marks the object `failed`. An object left `processing` with no live job is re-queued by the `media.storage.recover_stuck` job (queued every 10 minutes; `POST /api/admin/media/reprocess-stuck` queues it now), up to `STORAGE_PROCESSING_MAX_RETRIES` times, then marked `failed`. |
| A probe object under `__memoriahub_conn_test__/` | Left by a failed connection test of the old page. | Delete it by hand; the platform's test writes `storage-config-test/`. |
