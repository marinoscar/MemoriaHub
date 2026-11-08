# Runbook: triage with the Doctor

The Doctor answers "is this deployment configured, reachable and healthy?" in one report. Since RETRO-B1b (#602) it is the platform's: `GET /api/admin/doctor` and the page at **Admin, then Settings, then Doctor** (`/admin/settings/doctor`). The platform's own runbook (EnterpriseAppBase `docs/runbooks/doctor.md`) covers the framework; this page covers what is specific to MemoriaHub. The check inventory and the mapping from the former keys are in the [Doctor spec](../specs/doctor.md#4-check-catalog).

## Read the page

- The banner is the worst status. A `fail` blocks something; a `warn` is inconsistent or degraded; a `skip` is "not evaluated" (a feature is off, or the check it depends on did not pass) and is not a problem.
- Problems are expanded by default. Each row shows what was found, the **remedy** (a settings page, a command or a variable), the underlying error if a probe failed, and an **Open settings** link.
- **Run again** bypasses the 15 second cache. **Download support bundle** saves a redacted JSON file for a support ticket (secrets and personal data removed; the download is audited).
- A category you do not see (for example `network`) simply has no checks in this deployment.

## First move: the database

Every check that queries the database depends on `db.connection`. When it fails, those checks show `skip` ("depends on db.connection"), so fix the connection first (`POSTGRES_*`, then `db.migrations` and `db.rls_role`), and the rest of the report fills in.

## What the MemoriaHub checks tell you

| Check | A `warn`/`fail` usually means | Where to fix |
|---|---|---|
| `memoriahub.core.pgvector` | The `vector` extension or the `media_item_embedding` table is missing; semantic search is unavailable | Use `pgvector/pgvector` Postgres and run migrations |
| `backup.pg-client` (platform; was `memoriahub.core.pg-client-version` until RETRO-D4) | `pg_dump` in the API image is older than the server (`fail`: database backup and restore can never succeed), or unreadable (`warn`: backup and restore unavailable, nothing else affected) | Rebuild the API image with a matching `postgresql-client` |
| `memoriahub.storage.active-provider` / `.live-test` | No enabled credential for the active provider / the bucket cannot be reached. The live test is a **read-only** probe; it no longer writes a test object, so "Test connection" on the Storage Providers page is still the way to prove writes | Admin, Settings, Storage Providers |
| `memoriahub.ai.search` / `.tagging` / `.embedding` | The provider key or model is wrong. These three make a real, tiny request (a few tokens) | Admin, Settings, AI |
| `memoriahub.ai.flag-consistency`, `memoriahub.face.flag-consistency` | A feature flag and its provider disagree (on with no provider is a `fail`; a provider with the flag off is a `warn`) | Admin, Settings, Tagging / Face |
| `memoriahub.ai.video-tagging` | `fail`: the visual pass cannot run (no tagging model or credential). `warn`: only transcription is misconfigured; videos are still tagged visual-only | Admin, Settings, AI |
| `memoriahub.face.pgvector` | The `faces.embedding_vec` column or one of its three HNSW indexes is missing (`warn`) | Run migrations, or set `FACE_VECTOR_BACKEND=app` |
| `memoriahub.jobs.worker-enabled` | In `system` or `off` mode no healthy worker node is serving media compute | Start a node or set `ENRICHMENT_WORKER_MODE=all` |
| `memoriahub.nodes.*` | A node is stale, a lease expired, or a node reports a degraded capability | Admin, Settings, Worker Nodes; `memoriahub node doctor` on the node |
| `memoriahub.workflows.state` | A run is stuck, an approval expired unnoticed, or scheduled workflows cannot fire | Admin, Settings, Workflow Automation |
| `memoriahub.android.*` | See the [Android runbook, section 11](android-app.md#11-the-doctor-android-section) | Admin, Settings, Android app |

## Notes

- **Read-only.** A Doctor run never writes (the `doctor-read-only` conformance suite enforces it). It is safe to run against production at any time by anyone with `system_settings:read`.
- **Ids changed.** The former `POST /api/admin/doctor/run` and the camelCase keys (`core.pgClientVersion`, `android.mediaSync`, ...) are gone; the mapping is in the spec. A script that called the old route now uses `GET /api/admin/doctor`.
- **Adding a check:** [Doctor spec, "Adding a check"](../specs/doctor.md#9-gotchas-and-implementation-notes).
