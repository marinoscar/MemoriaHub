# Bare host

A minimal NestJS host that boots the `@marinoscar/memoriahub-*` packages with simple in-memory ports and **no platform package**, outside the repository's workspaces. It exists to prove the packages are host-neutral: a host that has none of `@marinoscar/platform-api`, `platform-web` or a provider SDK can install them from tarballs and run them.

Nothing here is published, and no registry is needed for the MemoriaHub packages (third-party dependencies come from the public npm registry like any install). The packages stay `"private": true`; see [the release runbook](../../docs/runbooks/release-memoriahub-packages.md) for the open registry decision.

## What it proves

| Claim | How |
|---|---|
| The packed packages install with only their declared peers | `run.mjs` installs the `npm pack` tarballs of compute, contract and api into a temporary project outside the repository |
| No platform package or provider SDK is pulled in | `run.mjs` asserts `@marinoscar/platform-*`, `@marinoscar/memoriahub-web`, `openai` and `@anthropic-ai/sdk` are absent from `node_modules` |
| The published `.d.ts` files typecheck | `tsc` with `skipLibCheck: false` over the host and its tests |
| The host lists the peers of the slices it imports | `check-slice-peers.mjs --app <temporary project>` |
| One copy of every singleton library | `check-single-instance.mjs` over the temporary project |
| The slices boot on the ports and behave | `test/bare-host.test.ts`: services of the media, face, insights, location, tagging, search and memories slices resolve; the nine job handlers register on the job port (the tagging and memories types stay server-only with their permanent profiles); a photo upload fans out to `face_detection` and `auto_tagging` (priority 20) only while their feature is on (a video and a trashed photo do not); tagging persists only vocabulary labels and keeps a manual tag on a re-run, a duplicate label is a 409, the backfill is photos-only unless videos are asked for; search refuses a non-member with 404, binds every query to the scope and the live rows and refuses an unknown filter with 400; the memories digest tokens use one key per purpose, so an image token is never an unsubscribe token; a job runs through the in-process runner; an object-store round trip; the location resolver is the identity while grouping is off |
| The database contract holds (`--db postgres`) | the packed `@marinoscar/memoriahub-db` runs `check --database` (extensions, raw-SQL indexes, generated columns, CHECK constraints, function, triggers) against the PostgreSQL in `BARE_HOST_DATABASE_URL` |

## Run it

```bash
npm ci
npm run build -w @marinoscar/memoriahub-compute -w @marinoscar/memoriahub-contract -w @marinoscar/memoriahub-api
node examples/bare-host/run.mjs --from pack          # what a consumer gets (also: npm run check:memoriahub-bare-host)
node examples/bare-host/run.mjs --from workspace     # copies of the package folders instead of tarballs
node examples/bare-host/run.mjs --keep               # keep the temporary project and print its path
BARE_HOST_DATABASE_URL=postgresql://... node examples/bare-host/run.mjs --db postgres   # also check a migrated database
```

`--db postgres` needs a PostgreSQL that already holds the platform and domain migrations (in CI the API DB tier's database, after `prisma:migrate`); it exits 2 without the variable. It runs the **packed** `memoriahub-db` command over the repository's API app (where the installed copies live and `pg` resolves) and the live database. It does not run the slices on PostgreSQL: they stay on the fake prisma client.

`ONNXRUNTIME_NODE_INSTALL=skip` is set for the install: the host never loads a model, so no onnxruntime binary is downloaded. Node 24 is the supported runtime (`engines`); the script runs on 22 too.

## Layout

| Path | What |
|---|---|
| `run.mjs` | The runner above. Exit 0 passed, 1 a check failed, 2 a usage or setup error. |
| `src/ports/index.ts` | The port bindings: the in-memory kit of `@marinoscar/memoriahub-api/testing` (jobs with a `drain()` runner, object store, owner-only access, one fixed principal, recorders for notify/webhooks/metrics/audit, settings with schemas, secrets, a fake model port) plus a small prisma delegate and the `features` settings namespace. |
| `src/app.module.ts` | Binds the ports once (`MemoriahubPortsModule.forRoot`), then mounts `MediaModule`, `FaceModule`, `InsightsModule` and `LocationModule`. |
| `src/main.ts` | Boots the application context, prints the registered job handlers and stops. |
| `test/bare-host.test.ts` | The tests (`node --test`). Fixture data is invented. |

## Scope and gaps

- **The slices run on a fake prisma client.** `--db postgres` proves the database contract of the packed `memoriahub-db`, not the slices on PostgreSQL: a host's generated Prisma client over a database is the web edition's `test:db` tier. PGlite is not used: it would need `vector` and the HNSW partial indexes verified first, and nothing here needs it. `memoriahub-db sync` cannot run in a bare project (the domain migrations reference platform tables), so the check points at the repository's API app.
- **Slices mounted.** `media`, `face`, `insights`, `location`, `tagging`, `search` and `memories`. `dedup` is left out on purpose (it needs `onnxruntime-node`); `burst`, `social-media`, `enhancement`, `review-runs` and `workflows` are not mounted yet.
- **Fakes for the slices' non-port needs.** The memories digest signing key is a fixed placeholder derived per purpose (`bareHostDigestKey`), the album port is a no-op and the notify port is the recorder; AI is the fake model runtime. Tagging's vocabulary CSV needs `csv-parse` and `csv-stringify`, and the search slice's upload route needs the `@fastify/multipart` host plugin, so the host lists them (the slice-peers check enforces it).
- **No face provider.** The face slice builds its provider registry itself (CompreFace), so the host exercises the fan-out and the registration, not a detection.
- A real host writes its own port adapters; the web edition's are in `apps/api/src/platform-memoriahub/`.
