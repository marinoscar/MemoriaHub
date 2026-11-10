# core

The host interface every web slice reads, its provider, the headless hooks over it and a fake host for tests.

## Purpose and scope

`MemoriahubWebHost` is the one coupling between the domain UI and the app that mounts it: the API client, `navigate`, the signed-in `principal`, `features`, user `settings`, the active `ownerScope` (RETRO-I6), `notify`, `timeZone` and `slots` (components of slices that have not moved into the package yet). `MemoriahubWebHostProvider` provides it; `useMemoriahubHost`, `useOwnerScope`, `usePermissions` and `useFeatureFlags` read it; `api` is the host's client as a value for the headless clients; `MemoriahubApiError` is what a refused call throws. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-web/core/headless` (host, provider, hooks, `api`, error), `@marinoscar/memoriahub-web/core/ui` (`HostSlot`) and `@marinoscar/memoriahub-web/core/testing` (`createFakeMemoriahubWebHost`, `renderWithMemoriahubHost`).

## Peer dependencies

`react`, `react-dom`; the `ui` entry adds nothing; the `testing` entry adds `@mui/material`, `@testing-library/react` and `react-router-dom`.

## Configuration

The app builds the host once with `useMemo` (its state fields change over a session) and mounts `<MemoriahubWebHostProvider host={host}>` above the routes. The web edition does it in `apps/web/src/platform-memoriahub/`.

## Extension-point catalog

`MemoriahubWebHost`, `MemoriahubApiClient` and `MemoriahubWebSlots` are the extension points: the host chooses the transport and supplies the bridged components.
