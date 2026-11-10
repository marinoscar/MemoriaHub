# core

The runtime a host and every slice share: the module that binds the ports, the defaults of the optional ones, the SQL helper and the error helpers.

## Purpose and scope

`MemoriahubPortsModule.forRoot({ ports })` is a global Nest module that provides every port token from the host's bindings and fails at start-up, naming every missing required port. Around it: the no-op audit, webhook and metrics ports and the in-process event emitter a host that binds nothing gets; the `Prisma.sql|raw|join` helper (from the optional `@prisma/client-runtime-utils` peer, loaded on first use); `MemoriahubError` (a domain refusal with a machine-readable `reason`); `asJobError` and `aiRateLimit` (an AI rate limit becomes the queue's deferral); and `isFeatureEnabled` (a `features.<flag>` setting AND its kill switch). Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-api/core`. It imports the `ports` slice through its `index.ts` and nothing else of the package.

## Peer dependencies

`@nestjs/common`, and the optional `@prisma/client-runtime-utils` (only when a slice builds raw SQL).

## Configuration

`MemoriahubPortsModule.forRoot({ ports, ... })`: a binding per port plus `imports` for the modules a `useClass` binding needs. No environment variable.

## Extension-point catalog

`MemoriahubPortsModule` and `MemoriahubPortBindings` are the one extension point: the host's choice of binding for each port.
