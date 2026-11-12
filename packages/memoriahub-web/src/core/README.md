# core

The host interface every web slice reads, its provider, the headless hooks over it and a fake host for tests.

## Purpose and scope

`MemoriahubWebHost` is the one coupling between the domain UI and the app that mounts it: the API client, `navigate`, the signed-in `principal`, `features`, user `settings`, the active `ownerScope` (RETRO-I6), `notify`, `timeZone`, `slots` (components of slices that have not moved into the package yet) and `admin`, the admin port: the data table, the console's page header and back link, the deployment settings hook, the AI settings hook and the email readiness that the domain admin pages need and a host-neutral package cannot import (`useMemoriahubAdmin`; `MemoriahubDataTableProps`, `MemoriahubAdminPageHeaderProps`, `MemoriahubSystemSettings`, `MemoriahubAiSettingsState`, `MemoriahubEmailReadiness` are the structural subset the pages use). `MemoriahubWebHostProvider` provides it; `useMemoriahubHost`, `useOwnerScope`, `usePermissions` and `useFeatureFlags` read it; `api` is the host's client as a value for the headless clients; `MemoriahubApiError` is what a refused call throws. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-web/core/headless` (host, provider, hooks, `api`, error), `@marinoscar/memoriahub-web/core/ui` (`HostSlot`) and `@marinoscar/memoriahub-web/core/testing` (`createFakeMemoriahubWebHost`, `renderWithMemoriahubHost`, and `createFakeAdminPort`: a plain-HTML table, a header and an in-memory settings hook, with the patches recorded).

## Peer dependencies

`react`, `react-dom`; the `ui` entry adds nothing; the `testing` entry adds `@mui/material`, `@testing-library/react` and `react-router-dom`.

## Configuration

The app builds the host once with `useMemo` (its state fields change over a session) and mounts `<MemoriahubWebHostProvider host={host}>` above the routes. The web edition does it in `apps/web/src/platform-memoriahub/`.

## Extension-point catalog

`MemoriahubWebHost`, `MemoriahubApiClient`, `MemoriahubWebSlots`, `MemoriahubAdminPort`, `MemoriahubDataTableComponent`, `MemoriahubAdminPageHeaderComponent`, `MemoriahubAdminBackLinkComponent` and `MemoriahubSecretFieldComponent` and `MemoriahubAndroidPort` are the extension points: the host chooses the transport and supplies the bridged components and the admin building blocks (the data table, the page header, the back link alone, the write-only secret input, the settings hook, the AI settings hook and the email readiness).
