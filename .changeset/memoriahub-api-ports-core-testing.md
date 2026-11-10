---
"@marinoscar/memoriahub-api": minor
---

Add `@marinoscar/memoriahub-api` (private): the host ports of the MemoriaHub domain (`@marinoscar/memoriahub-api/ports`: prisma, jobs, ai, object store, access, identity, notify, settings, secrets, events, audit, webhooks, metrics), `MemoriahubPortsModule.forRoot` and the helpers a slice needs (`@marinoscar/memoriahub-api/core`), and in-memory fakes with the `describeMemoriahubPortsConformance` kit (`@marinoscar/memoriahub-api/testing`). The package imports no `@marinoscar/platform-*`; the web app binds each port to the platform in `apps/api/src/platform-memoriahub/`. No domain code moves yet and nothing changes on the wire.
