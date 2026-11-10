# rate-limit

The shared provider rate-limit signal: `ProviderRateLimitError` and `Retry-After` parsing, so the API and a worker node react the same way (defer with backoff, not retry).

## Purpose and scope

The shared provider rate-limit signal: `ProviderRateLimitError` and `Retry-After` parsing, so the API and a worker node react the same way (defer with backoff, not retry).

Pure compute only: no framework import, no environment read, no persistence. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-compute/rate-limit`. `rate-limit/index.ts`: `ProviderRateLimitError`, `parseRetryAfterMs`. Other slices are imported only through their `index.ts`.

## Peer dependencies

None.

## Configuration

None.

## Extension-point catalog

None. The slice exposes functions and data shapes, not extension points.
