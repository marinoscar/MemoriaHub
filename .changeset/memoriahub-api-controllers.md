---
"@marinoscar/memoriahub-api": minor
---

Move the controllers the dedup and location slices left in the web app into `@marinoscar/memoriahub-api` (private): `DuplicateController`, `AdminDuplicateController` and `ReviewInsightsController` (`/dedup`), `LocationGroupsController`, `LocationGroupsAdminController`, `LocationSuggestionController`, `AdminLocationInferenceController` and `LocationSuggestionRunsController` (`/location`), with their DTO classes and permission constants. They are exported classes over `@MemoriahubAuth` that the web app mounts in its own modules, not part of any `forRoot()`. The `dedup` and `location` slices now list `@nestjs/swagger` and `nestjs-zod` as peers. Routes, permissions and OpenAPI are unchanged.
