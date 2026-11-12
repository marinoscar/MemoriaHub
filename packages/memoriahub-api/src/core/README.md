# core

The runtime a host and every slice share: the module that binds the ports, the defaults of the optional ones, the SQL helper and the error helpers.

## Purpose and scope

`MemoriahubPortsModule.forRoot({ ports })` is a global Nest module that provides every port token from the host's bindings and fails at start-up, naming every missing required port. Around it: the no-op audit, webhook, metrics and doctor ports and the in-process event emitter a host that binds nothing gets; the `Prisma.sql|raw|join` helper (from the optional `@prisma/client-runtime-utils` peer, loaded on first use); `MemoriahubError` (a domain refusal with a machine-readable `reason`); `asJobError` and `aiRateLimit` (an AI rate limit becomes the queue's deferral); `isFeatureEnabled` (a `features.<flag>` setting AND its kill switch), the diagnostics helpers (`doctorCheckId`, `pass`, `warn`, `fail`, `skip`, `DOCTOR_CHECK_TIMEOUT_MS`), and the identity-backed guard: `@MemoriahubAuth({ permissions?, roles?, anyPermissions?, credentials?, public? })`, `@MemoriahubPublic()`, `@MemoriahubCurrentUser()` and `@MemoriahubAuthCredential()` over the `MEMORIAHUB_IDENTITY` port, so a slice's controllers live in the package without importing the host. The decorator writes the metadata keys and the OpenAPI `x-rbac` extension the web edition's `@Auth()` writes, and the guard refuses with the same messages; `describeMemoriahubAuthGuardConformance` (in `/testing`) proves a binding does. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-api/core`. It imports the `ports` slice through its `index.ts` and nothing else of the package.

## Peer dependencies

`@nestjs/common`, and the optional `@prisma/client-runtime-utils` (only when a slice builds raw SQL), `@nestjs/core` and `@nestjs/swagger` (only the guard and its decorators).

## Configuration

`MemoriahubPortsModule.forRoot({ ports, ... })`: a binding per port plus `imports` for the modules a `useClass` binding needs. No environment variable.

## Extension-point catalog

`MemoriahubPortsModule` and `MemoriahubPortBindings`: the host's choice of binding for each port. `MemoriahubAuthGuard`: it decides every protected route of a slice, over whatever the host binds to `MEMORIAHUB_IDENTITY`.
