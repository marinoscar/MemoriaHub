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
| The slices boot on the ports and behave | `test/bare-host.test.ts`: services of the media, face, insights and location slices resolve; five job handlers register on the job port; a photo upload fans out to `face_detection` only when `features.faceRecognition` is on (a video and a trashed photo do not); a job runs through the in-process runner; an object-store round trip; the location resolver is the identity while grouping is off |

## Run it

```bash
npm ci
npm run build -w @marinoscar/memoriahub-compute -w @marinoscar/memoriahub-contract -w @marinoscar/memoriahub-api
node examples/bare-host/run.mjs --from pack          # what a consumer gets (also: npm run check:memoriahub-bare-host)
node examples/bare-host/run.mjs --from workspace     # copies of the package folders instead of tarballs
node examples/bare-host/run.mjs --keep               # keep the temporary project and print its path
```

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

- **No database.** The host uses a fake prisma client. `@marinoscar/memoriahub-db` is not installed (its `prisma` peer and the platform schema it composes with are a database host's business); the schema is proven by the `db-apply` job and `check:memoriahub-pack`. A database-backed bare host (apply the platform and domain history to PostgreSQL 16 with pgvector, run `memoriahub-db check --database`) is a follow-up. PGlite was not tried: it would need `vector` and the HNSW partial indexes verified first.
- **Slices that exist today.** `tagging`, `search` and `memories` are not in the api package yet; they are added to `src/app.module.ts` and the test when they land. `dedup` is left out on purpose (it needs `onnxruntime-node`).
- **No face provider.** The face slice builds its provider registry itself (CompreFace), so the host exercises the fan-out and the registration, not a detection.
- A real host writes its own port adapters; the web edition's are in `apps/api/src/platform-memoriahub/`.
