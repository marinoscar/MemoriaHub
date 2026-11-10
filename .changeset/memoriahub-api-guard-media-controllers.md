---
"@marinoscar/memoriahub-api": minor
---

Add the identity-backed guard and decorators to `@marinoscar/memoriahub-api/core` (private): `@MemoriahubAuth`, `@MemoriahubPublic`, `@MemoriahubCurrentUser`, `@MemoriahubAuthCredential` and `MemoriahubAuthGuard`, over the identity port, with the `describeMemoriahubAuthGuardConformance` kit. Move the Media Sync controller, the empty-trash engine (service, the `trash_empty_evaluate` and `trash_empty_execute_batch` handlers, controller) and the `media_items` where-builder into the `media` slice. Routes, job type strings, permissions and the generated OpenAPI document are unchanged.
