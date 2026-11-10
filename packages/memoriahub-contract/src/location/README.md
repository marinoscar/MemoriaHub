# location

Wire schemas of the location domain: the reverse-geocoding provider settings, the location-suggestion review queue and bulk runs, and the location-group management API (groups, members, values, suggestions, merge, rebuild).

## Purpose and scope

Wire schemas of the location domain: the reverse-geocoding provider settings, the location-suggestion review queue and bulk runs, and the location-group management API (groups, members, values, suggestions, merge, rebuild).

Wire shapes only: no framework import, no environment read, no behaviour beyond parsing. The schemas are permanent: add fields, never rename or remove one, and change a limit only with the API in the same release. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-contract/location`. `location/index.ts` exports one `<name>Schema` and its inferred type per request, plus `LOCATION_GROUP_LEVELS` and `GROUPED_FILTERS`. It builds on the `primitives` slice. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes schemas, inferred types and constants, not extension points.
