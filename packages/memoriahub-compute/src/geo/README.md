# geo

Reverse-geocoding response mapping for Nominatim and Google (raw provider JSON to typed place-name tiers) and the fetch helpers a worker node uses with a transient per-job credential.

## Purpose and scope

Reverse-geocoding response mapping for Nominatim and Google (raw provider JSON to typed place-name tiers) and the fetch helpers a worker node uses with a transient per-job credential.

Pure compute only: no framework import, no environment read, no persistence. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-compute/geo`. `geo/index.ts`: `mapNominatimResponse`, `mapGoogleResponse`, `fetchNominatim`, `fetchGoogleReverse`, `GeoProviderRateLimitError`. Other slices are imported only through their `index.ts`.

## Peer dependencies

None beyond Node built-ins (global `fetch`). Depends on the `rate-limit` slice.

## Configuration

None. Credentials and base URLs are parameters; nothing is read from the environment.

## Extension-point catalog

None. The slice exposes functions and data shapes, not extension points.
