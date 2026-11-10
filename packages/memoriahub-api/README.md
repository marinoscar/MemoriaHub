# @marinoscar/memoriahub-api

The NestJS side of the MemoriaHub domain: the **host ports** (injection tokens and interfaces) every domain slice reaches the outside world through, the module that binds them, and in-memory fakes with a conformance kit. Host-neutral: it imports no `@marinoscar/platform-*` package and no application workspace. CommonJS.

## Purpose and scope

MemoriaHub's domain (media, faces, tagging, search, memories, workflows, review runs, location, dedup, burst, social media, enhancement, insights) will live in this package, slice by slice (RETRO-J5 to J10). A domain slice may not import the platform: everything outside the domain (the queue, the model runtime, object storage, notifications, settings, credentials, access policy, the database client, the event bus, audit, webhooks, metrics) is a **port**, an injection token plus an interface declared here and bound by each host. The web app binds the ports to the platform in `apps/api/src/platform-memoriahub/`; a bare host binds its own. Moving a slice therefore never moves a platform import with it ([ADR 0001](../../docs/decisions/0001-packages-first.md)).

This first release carries the ports, the module and the testing kit only. It moves no domain code, so the web app behaves exactly as before; the port design is in [the ports spec](../../docs/specs/memoriahub-ports.md).

Status: experimental. It is `"private": true` until the owner opens the publish gate ([release runbook](../../docs/runbooks/release-memoriahub-packages.md)).

Entry points (a slice README per folder):

- `@marinoscar/memoriahub-api/ports`: the thirteen ports (tokens, interfaces, option and result shapes) and the two classes a slice throws across them ([slice README](src/ports/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/core`: `MemoriahubPortsModule.forRoot`, the optional-port defaults, the `Prisma` SQL helper, the domain error base class and the AI-to-job error helpers ([slice README](src/core/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/testing`: an in-memory fake of every port and `describeMemoriahubPortsConformance`, the kit a binding must pass ([slice README](src/testing/README.md#purpose-and-scope)).

## Install and peer dependencies

```bash
npm install @marinoscar/memoriahub-api@next
```

| Package | Range | Needed by |
|---|---|---|
| `@nestjs/common` | `^11.1.12` | `ports`, `core`, `testing` |
| `zod` | `^4.4.3` | `ports`, `testing` |
| `@prisma/client-runtime-utils` | `^7.8.0` (optional) | `core`, only when a slice builds raw SQL with `Prisma.sql` |
| `@marinoscar/memoriahub-contract` | any (optional) | the domain slices of J5 to J10; none of the three slices today |

The package has no dependency on `@marinoscar/platform-api`: a port is declared structurally, so a binding adapts the platform's types in the host. The per-slice data is `packages/memoriahub-slice-peers.json`; `node scripts/memoriahub-packages/check-slice-peers.mjs --table` prints it.

## Quick start

```ts
// A slice asks for a port by its token and never imports the platform.
import { Inject, Injectable } from '@nestjs/common';
import { MEMORIAHUB_JOBS, type MemoriahubJobsPort } from '@marinoscar/memoriahub-api/ports';

@Injectable()
export class ExampleScheduler {
  constructor(@Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort) {}

  async queue(mediaItemId: string): Promise<void> {
    await this.jobs.enqueue({ type: 'example.job', subjectType: 'media_item', subjectId: mediaItemId, payload: { mediaItemId } });
  }
}

// The host binds the ports once, before any domain module.
// MemoriahubPortsModule.forRoot({ ports: { prisma: { useExisting: PrismaService }, jobs: { useClass: JobsAdapter }, ... } })

// A slice's unit test needs neither a platform nor a database.
// const fakes = createFakeMemoriahubPorts();
// Test.createTestingModule({ imports: [MemoriahubPortsModule.forRoot({ ports: fakeMemoriahubBindings(fakes) })], ... })
```

## Configuration

`MemoriahubPortsModule.forRoot({ ports })` takes one binding per port (`useClass`, `useExisting`, `useValue` or `useFactory`, the four shapes of a Nest custom provider) and an optional `imports` list for the modules the bindings' providers need. The nine required ports are `prisma`, `jobs`, `ai`, `objectStore`, `access`, `identity`, `notify`, `settings` and `secrets`; `events`, `audit`, `webhooks` and `metrics` are optional and default to an in-process emitter and three no-ops. `forRoot` throws, naming every missing required port, so a forgotten binding stops the boot and not the first request. The package reads no environment variable.

## Extension-point catalog

Every token below is an extension point: a host binds it, a slice injects it. The description string of each token is permanent.

| Extension point | Kind | What a host provides |
|---|---|---|
| `MEMORIAHUB_PRISMA`, `MemoriahubPrismaClientLike` | token | the database client, plus `runInOrg` for row-level security |
| `MEMORIAHUB_JOBS`, `MemoriahubJobsPort`, `MemoriahubJobHandler` | token, hook | the queue: enqueue, dedup, handler registration, settled events |
| `MEMORIAHUB_AI`, `MemoriahubAiPort`, `MemoriahubAiClient` | token | the model runtime, feature-scoped, keys resolved per call |
| `MEMORIAHUB_OBJECT_STORE`, `MemoriahubObjectStorePort`, `MemoriahubObjectStore`, `MemoriahubObjectProcessor` | token, hook | object storage and the post-upload processors |
| `MEMORIAHUB_ACCESS`, `MemoriahubAccessPort` | token | owner-scope roles, record grants, scope sweeps |
| `MEMORIAHUB_IDENTITY`, `MemoriahubIdentityPort` | token | the normalised request principal |
| `MEMORIAHUB_NOTIFY`, `MemoriahubNotifyPort` | token | notification events, counted and state rows, email templates |
| `MEMORIAHUB_SETTINGS`, `MemoriahubSettingsPort` | token | system and user settings namespaces |
| `MEMORIAHUB_SECRETS`, `MemoriahubSecretsPort` | token | the encrypted credential store |
| `MEMORIAHUB_EVENTS`, `MemoriahubEventsPort` | token | in-process domain events |
| `MEMORIAHUB_AUDIT`, `MemoriahubAuditPort` | token | the audit sink |
| `MEMORIAHUB_WEBHOOKS`, `MemoriahubWebhooksPort` | token | outbound webhook events |
| `MEMORIAHUB_METRICS`, `MemoriahubMetricsPort` | token | counters and histograms by registered name |
| `MemoriahubPortsModule`, `MemoriahubPortBindings` | token | the global module that binds all of the above |

## Data

None. The package stores nothing and ships no schema (the domain's Prisma fragments are `@marinoscar/memoriahub-db`).

## Permissions and settings

None. The ports carry permission strings and settings namespaces as data: a slice declares the namespaces it owns through `MEMORIAHUB_SETTINGS.registerNamespace`, and the host verifies the declaration exists in its registry before the application starts.

## UI

None. The package has no UI.

## Infra

None. An image that installs the package must build it (`npm run build -w @marinoscar/memoriahub-api`) because `.dockerignore` drops every `dist/`.

## Observability

The package imports no OpenTelemetry API. `MEMORIAHUB_METRICS` writes through the host's registered metric names (labels are enums, never an organization, user or media id), and the host's jobs adapter keeps the platform's job spans: a slice never creates its own tracer.

## Security notes

A key never crosses a port: the AI port resolves the credential on the host's side and drops it when the call returns, and `MEMORIAHUB_SECRETS.status` never returns material. Access is decided only through `MEMORIAHUB_ACCESS`, which answers not-found (never forbidden) to a non-member of a scope. AI jobs are server-only: the jobs binding refuses a handler that declares `usesAi` and the node-result pair together. The conformance kit asserts each of these.

## Conformance suite

`describeMemoriahubPortsConformance(name, factory, harness, options)` from `@marinoscar/memoriahub-api/testing`: test-runner neutral, one section per port. The package runs it against its own fakes (`test/ports-conformance.spec.ts`); the web app runs it against the platform adapters (`apps/api/test/platform-memoriahub/`). A host adding a binding runs the same kit against it.

## Upgrade notes

New package: nothing to upgrade from. A port, a field of a port or a token description is added, never renamed or removed; a binding written against this release keeps working.

## Troubleshooting

`MemoriahubPortsModule.forRoot: no binding for port MEMORIAHUB_X` means the host did not bind a required port. `Cannot find module '@marinoscar/memoriahub-api/...'` means the package was not built (`npm run build -w @marinoscar/memoriahub-api`) or, under `moduleResolution: node`, that the per-slice stub folder (`ports/`, `core/`, `testing/`) is missing from the checkout. `Building raw SQL needs the optional peer dependency @prisma/client-runtime-utils` means a slice used `Prisma.sql` in a host that did not install it.

## Links

- [Ports spec](../../docs/specs/memoriahub-ports.md): each port, the call sites it serves, the bare-host notes
- [Package documentation standard and checks](../../docs/PACKAGES.md)
- [Release runbook](../../docs/runbooks/release-memoriahub-packages.md)
- [ADR 0001: packages first](../../docs/decisions/0001-packages-first.md)
