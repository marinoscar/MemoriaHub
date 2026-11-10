# ports

The host ports of the MemoriaHub domain: one injection token and one interface per outside dependency a slice has (database, queue, models, object storage, access, identity, notifications, settings, secrets, events, audit, webhooks, metrics).

## Purpose and scope

Declarations only: tokens (`Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_<NAME>')`, the description string is permanent), interfaces, option and result shapes, and two classes a slice throws across a port (`MemoriahubAiError`, `MemoriahubRateLimitError`). No implementation, no platform import. Every shape is structural, so a host adapts its own types to them. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-api/ports`. `ports/index.ts` re-exports one file per port (`jobs.port.ts`, `ai.port.ts`, ...). Other slices import it only through that `index.ts`.

## Peer dependencies

`@nestjs/common` (the `ExecutionContext` type of the identity port) and `zod` (the schema types of the jobs, AI and settings ports).

## Configuration

None. The slice reads no environment variable.

## Extension-point catalog

Each port token is an extension point a host binds: `MEMORIAHUB_PRISMA`, `MEMORIAHUB_JOBS`, `MEMORIAHUB_AI`, `MEMORIAHUB_OBJECT_STORE`, `MEMORIAHUB_ACCESS`, `MEMORIAHUB_IDENTITY`, `MEMORIAHUB_NOTIFY`, `MEMORIAHUB_SETTINGS`, `MEMORIAHUB_SECRETS`, `MEMORIAHUB_EVENTS`, `MEMORIAHUB_AUDIT`, `MEMORIAHUB_WEBHOOKS` and `MEMORIAHUB_METRICS`, each with its `Memoriahub<Name>Port` interface (`MemoriahubPrismaClientLike` for the database). The handler a slice registers is `MemoriahubJobHandler`, the post-upload step is `MemoriahubObjectProcessor`, and a scoped model client is `MemoriahubAiClient`.
