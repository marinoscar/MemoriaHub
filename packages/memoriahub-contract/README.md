# @marinoscar/memoriahub-contract

Zod wire schemas, inferred types and `details.reason` codes of the MemoriaHub domain, shared by the API, the web app and the CLI. Leaf package: it imports only `zod` (no framework, no `@marinoscar/platform-*`), dual CommonJS and ESM.

## Purpose and scope

The package is where a request or response shape of a MemoriaHub route is written once. The API builds its DTO classes on the schemas (`createZodDto(schema)`), the web app and the CLI import the inferred types, and the refusal reasons a client keys off live beside them. It holds no service, no controller and no database access. It describes only the domain: platform shapes (identity, jobs, notifications, sharing, storage and AI configuration, the error envelope) come from `@marinoscar/platform-contract` and are never redefined here. The node result schemas stay in `@marinoscar/memoriahub-compute/dto` (the pure compute contract a worker node shares).

Moving a schema here changes no wire shape: the OpenAPI document the API dumps is unchanged by the refactor. Where the API validates against a Prisma enum, the contract carries the same values as a literal tuple and an API test pins the two together.

Status: experimental. It is `"private": true` until the owner opens the publish gate ([release runbook](../../docs/runbooks/release-memoriahub-packages.md)).

Entry points (a slice README per folder):

- `@marinoscar/memoriahub-contract`: the package root; re-exports every slice below.
- `@marinoscar/memoriahub-contract/primitives`: Building blocks shared by every wire schema: the ISO date-time fields, the `bbox` query encoding, the lenient admin date bound and the IANA time-zone check ([slice README](src/primitives/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-contract/errors`: Machine-readable `details.reason` codes of the domain: the Media Sync refusals and the retired public-share route ([slice README](src/errors/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-contract/burst`: Wire schemas of burst detection: the review-queue query, the resolve and dismiss bodies, the threshold bulk actions and the admin backfill request ([slice README](src/burst/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-contract/dedup`: Wire schemas of near-duplicate detection: the review-queue query, the resolve and dismiss bodies and the threshold bulk actions ([slice README](src/dedup/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-contract/review-runs`: Wire schemas and vocabulary of the shared review-run engine (bursts, duplicates, location suggestions): the run items query and the subject and action enums ([slice README](src/review-runs/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-contract/location`: Wire schemas of the location domain: the reverse-geocoding provider settings, the location-suggestion review queue and bulk runs, and the location-group management API (groups, members, values, suggestions, merge, rebuild) ([slice README](src/location/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-contract/workflows`: Wire schemas of media workflow automation: the versioned Subject, Trigger, If, Then definition document, the workflow and run request bodies and queries, the admin oversight queries and the trigger and run-status vocabulary ([slice README](src/workflows/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-contract/media`: Wire schemas of media items, albums, tags, archive and trash, the gallery and map queries, geocoding queries and the trash-empty runs ([slice README](src/media/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-contract/media-sync`: Wire schemas and limits of the Android Media Sync companion: device registration, the versioned desired config, commands, check-in, runs and diagnostics, and the vocabulary and limits the schemas, the service and the clients share ([slice README](src/media-sync/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-contract/search`: Wire schemas of deterministic search: the search request with its people, near and date-range filter values ([slice README](src/search/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-contract/enhancement`: Wire schemas of the AI picture enhancer: the enhance parameters, apply, bulk enhance by selection or by filter, the batch list query and the hub list query with its status vocabulary and aliases ([slice README](src/enhancement/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-contract/face`: Wire schemas of face recognition and people: person create, update and merge bodies, face assignment, the bulk hide, unhide and purge bodies, the unassigned face query and the face provider settings ([slice README](src/face/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-contract/memories`: Wire schemas of Memories: the list and feed queries, the card, detail and per-user state response shapes, the save-as-album body, the admin backfill body and the memory type vocabulary ([slice README](src/memories/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-contract/tagging`: Wire schemas of AI tagging: the tag-label vocabulary bodies and the admin backfill request ([slice README](src/tagging/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-contract/social`: Wire schemas of social-media video detection: the admin backfill request ([slice README](src/social/README.md#purpose-and-scope)).

## Install and peer dependencies

```bash
npm install @marinoscar/memoriahub-contract@next
```

The only peer dependency is `zod`, and every slice needs it:

| Package | Range | Needed by |
|---|---|---|
| `zod` | `^4.4.3` | every slice |

An app installs the package and `zod` at the same range as the rest of the repository, so a single copy of `zod` is shared with `nestjs-zod`. The per-slice data is `packages/memoriahub-slice-peers.json`; `node scripts/memoriahub-packages/check-slice-peers.mjs --table` prints it.

## Quick start

```ts
import { burstQuerySchema, type BurstQuery } from '@marinoscar/memoriahub-contract/burst';
// CommonJS: const { burstQuerySchema } = require('@marinoscar/memoriahub-contract/burst');

const query: BurstQuery = burstQuerySchema.parse({ circleId: '00000000-0000-4000-8000-000000000001' });

// API side: a DTO class is the schema plus Swagger metadata.
// export class BurstQueryDto extends createZodDto(burstQuerySchema) {}
```

Keep the `.js` extension on every relative import inside the package; the ESM build fails at run time without it. A consumer compiled with `moduleResolution: node` resolves the subpaths through the per-folder `package.json` stubs the package ships.

## Configuration

None. The package reads no environment variable and takes no option object.

## Extension-point catalog

None. The package exposes schemas, inferred types and constants, not extension points.

## Data

None. It stores nothing. The wire shapes describe the API; the database side is the API's.

## Permissions and settings

None. Permission strings and settings stay where the API enforces them.

## UI

None. The package has no UI.

## Infra

None. The package ships no deployment configuration. An image that installs it must build it (`npm run build -w @marinoscar/memoriahub-contract`) because `.dockerignore` drops every `dist/`; the API, CLI and web Dockerfiles do, and they copy `scripts/memoriahub-packages/write-dist-stubs.mjs` because the build runs it.

## Observability

None. The package imports no OpenTelemetry API.

## Security notes

The package carries no secret and no credential shape: credential views belong to `@marinoscar/platform-contract`. The `.strict()` schemas stay strict, so an unknown key is rejected exactly as before. A BigInt column is a `z.string()` on the wire, never a `bigint`. Importing `@marinoscar/platform-*` from this package is a violation (rule 6 of `check:memoriahub-slice-peers`).

## Conformance suite

The package's own `node --test` suite (`npm run test:run -w @marinoscar/memoriahub-contract`): each schema parses a fixture captured from the API (`test/fixtures/`, invented data only), rejects unknown keys where the API is strict, and every entry point loads through both module systems. In the API, `src/common/contract-enums.spec.ts` pins the contract vocabularies to the Prisma enums, and the OpenAPI dump must be unchanged by a refactor.

## Upgrade notes

New package: nothing to upgrade from. Schemas that moved here keep their export names from the DTO files they came from (those files re-export them), so existing imports keep working; the `media-sync` list-runs query is exported as `mediaSyncListRunsQuerySchema` here to avoid a clash with the workflow one.

## Troubleshooting

`Cannot find module '@marinoscar/memoriahub-contract/...'` means the package was not built: run `npm run build -w @marinoscar/memoriahub-contract` (CI and the Dockerfiles do it after the install). `TS1479` from a CommonJS consumer means the `dist/cjs/package.json` stub is absent (the build writes it). `TS2307` under `moduleResolution: node` means the per-slice stub folder is missing from the checkout. A type error that two copies of `zod` are incompatible means the app resolved a second `zod`: dedupe it.

## Links

- [Package documentation standard and checks](../../docs/PACKAGES.md): how this README, the TSDoc and the catalog are checked
- [Release runbook](../../docs/runbooks/release-memoriahub-packages.md): versions, the publish gate, rollback
- [ADR 0001: packages first](../../docs/decisions/0001-packages-first.md)
- [API conventions](../../docs/API.md): the envelope and the error shape the schemas sit under
