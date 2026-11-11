---
"@marinoscar/memoriahub-api": minor
---

Move the 28 gallery request DTO classes (`MediaQueryDto`, `CreateMediaDto`, the album, bulk, trash, locations, dashboard and geocode query DTOs) into `@marinoscar/memoriahub-api/media` (private). They are thin `createZodDto` classes over the `memoriahub-contract/media` schemas; the web app imports them from the slice. Routes and OpenAPI are unchanged.
