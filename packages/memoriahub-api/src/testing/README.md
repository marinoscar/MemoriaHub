# testing

In-memory fakes of every port, and `describeMemoriahubPortsConformance`, the kit a binding must pass.

## Purpose and scope

A slice's unit test needs neither the platform nor a database: `createFakeMemoriahubPorts()` builds a fake of every port (`FakeMemoriahubJobs` with dedup, retries, deferral and settled events, `FakeMemoriahubAi` with scripted answers and failures, `InMemoryMemoriahubObjectStorePort`, `FakeMemoriahubAccess`, `FakeMemoriahubIdentity`, `FakeMemoriahubNotify`, `FakeMemoriahubSettings`, `FakeMemoriahubSecrets`, `FakeMemoriahubPrisma` and recording audit, webhook and metrics ports) and `fakeMemoriahubBindings()` turns them into `MemoriahubPortsModule.forRoot` bindings. The conformance kit is the executable contract: the fakes pass it, so do the web app's platform adapters, and a bare host runs it against its own. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-api/testing`. It imports the `ports` and `core` slices through their `index.ts`.

## Peer dependencies

`@nestjs/common` and `zod`.

## Configuration

`describeMemoriahubPortsConformance(name, factory, harness, { skip })`: a factory that builds fresh ports and the few hooks the kit cannot invent (a scope with a viewer, an editor, an admin and an outsider; a way to provoke an AI failure; an authenticated request), the test runner's `describe`, `it` and `expect`, and the ports to leave out.

## Extension-point catalog

None. The slice offers fakes and a kit, not extension points.
