# @marinoscar/memoriahub-web

The React side of the MemoriaHub domain: pages, components, hooks and clients, with a `headless` and a `ui` entry per slice, plus the host interface the app provides, the navigation and settings data the domain contributes, and the brand. Host-neutral: it imports no `@marinoscar/platform-*` package and no application workspace. ESM.

## Purpose and scope

The MemoriaHub web UI will live in this package, slice by slice (RETRO-J11, mirroring the API slices of RETRO-J5 to J10). A slice takes everything outside the domain (the API client, navigation, the signed-in user, feature flags, the active owner scope, the shell layout) from a `MemoriahubWebHost` the app provides once; it never imports the app or the platform. The platform's own UI (identity, the settings hub, notifications, jobs, sharing) stays `@marinoscar/platform-web`, and the web app binds the two in `apps/web/src/platform-memoriahub/`. Moving a slice therefore never moves an app import with it ([ADR 0001](../../docs/decisions/0001-packages-first.md)).

This release carries ten slices: `core` (the host), `brand`, `shell` (data for the app's registries), `search` (the search panel, the top-bar pill, AI search and the Search page), `tagging` (the tag status and vocabulary clients, the tag browse page and the two admin pages: the vocabulary and the Tagging settings), `workflows` (the workflow list, builder, templates, run history and the admin settings and oversight page), `review-runs` (the shared run progress panel, run polling hook and failed-items table, the review-queue and empty-trash run pages and their clients), `people` (the People and archived-faces pages, the person cards and grids, the face crop and dialogs, and the people and face hooks), `memories` (the feed carousel, the Memories and detail pages, the story player, the preferences card, the admin settings page and their hooks) and `media` (gallery, bulk toolbars and dialogs, albums, the map, places, archive and trash pages, the civil date utilities and the media clients). The lightbox, the detail drawer, the enhancement drawer and dialog, the people pickers (the host-slot bridges over the people slice's hooks) and the location-merge dialog belong to later parts and reach the media pages through **host slots**; the media-sync page and the Collections hub stay in the app until their slices move. The web app mounts the packaged pages on the same routes, so nothing changes for users.

Status: experimental. It is `"private": true` until the owner opens the publish gate ([release runbook](../../docs/runbooks/release-memoriahub-packages.md)).

Entry points (a slice README per folder):

- `@marinoscar/memoriahub-web/core/headless`: `MemoriahubWebHost`, its provider and the hooks over it ([slice README](src/core/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-web/core/ui`: `defineHostSlot`, the typed bridge to a component the host supplies.
- `@marinoscar/memoriahub-web/core/testing`: a fake host and `renderWithMemoriahubHost`.
- `@marinoscar/memoriahub-web/brand`: the identity values and the mark ([slice README](src/brand/README.md#purpose-and-scope)); the assets, one export each: `@marinoscar/memoriahub-web/brand/assets/mark.svg`, `@marinoscar/memoriahub-web/brand/assets/favicon.ico`, `@marinoscar/memoriahub-web/brand/assets/favicon-16x16.png`, `@marinoscar/memoriahub-web/brand/assets/favicon-32x32.png`, `@marinoscar/memoriahub-web/brand/assets/apple-touch-icon.png`, `@marinoscar/memoriahub-web/brand/assets/android-chrome-192x192.png`, `@marinoscar/memoriahub-web/brand/assets/android-chrome-512x512.png`, `@marinoscar/memoriahub-web/brand/assets/icon-192.png`, `@marinoscar/memoriahub-web/brand/assets/icon-512.png`, `@marinoscar/memoriahub-web/brand/assets/icon-maskable-192.png`, `@marinoscar/memoriahub-web/brand/assets/icon-maskable-512.png`, `@marinoscar/memoriahub-web/brand/assets/badge-72.png`, `@marinoscar/memoriahub-web/brand/assets/app-logo.png`.
- `@marinoscar/memoriahub-web/shell`: the route prefixes and settings cards as data ([slice README](src/shell/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-web/media/headless`: the media clients, hooks, contexts and the civil date utilities ([slice README](src/media/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-web/media/ui`: the media pages and components, and the slot bridges.
- `@marinoscar/memoriahub-web/review-runs/headless`: the run wire types, the run clients and the run polling hook ([slice README](src/review-runs/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-web/review-runs/ui`: the run progress panel, the failed-items table, the review and empty-trash run pages.
- `@marinoscar/memoriahub-web/people/headless`: the people and face clients, hooks and types ([slice README](src/people/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-web/people/ui`: the People and archived-faces pages, person cards and grids, the face crop and dialogs.
- `@marinoscar/memoriahub-web/memories/headless`: the memories clients, hooks, story timing and types ([slice README](src/memories/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-web/memories/ui`: the Memories pages, the carousel and the story player.
- `@marinoscar/memoriahub-web/search/headless`: the search clients, the agent stream and the search hook ([slice README](src/search/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-web/search/ui`: the search state, panel, top-bar pill and the Search page.
- `@marinoscar/memoriahub-web/tagging/headless`: the per-item tag status and vocabulary clients and `useMediaTags` ([slice README](src/tagging/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-web/tagging/ui`: the tag browse page.
- `@marinoscar/memoriahub-web/workflows/headless`: the workflow clients, hooks, builder state, templates and formatters ([slice README](src/workflows/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-web/workflows/ui`: the workflow list and builder pages and their blocks.

## Install and peer dependencies

```bash
npm install @marinoscar/memoriahub-web@next
```

| Package | Range | Needed by |
|---|---|---|
| `react`, `react-dom` | `^19.2.7` | every slice |
| `@mui/material`, `@mui/icons-material` | `^9.1.0` | every `ui` entry, `shell`, `core/testing` |
| `react-router-dom` | `^7.17.0` | every `ui` entry, `core/testing` |
| `leaflet`, `leaflet.markercluster`, `react-leaflet` | `^1.9.4`, `^1.5.3`, `^5.0.0` | `media/ui` (the map, places and location pickers) |
| `hash-wasm` | `^4.12.0` | `media` (the upload dialog's streaming SHA-256) |
| `@testing-library/react` | `^16.3.2` | `core/testing` |
| `@marinoscar/memoriahub-contract` | any (optional) | `media` (request types) |

The package has no dependency on `@marinoscar/platform-web`: the platform is reached through the host. A `headless` entry imports no `@mui/*`, `@emotion/*` or router, so a host with another design system builds its own UI on it. The per-slice data is `packages/memoriahub-slice-peers.json`; `node scripts/memoriahub-packages/check-slice-peers.mjs --table` prints it. The host app must resolve one copy of React, MUI and Emotion (`npm run check:single-instance`).

## Quick start

```tsx
import { MemoriahubWebHostProvider, type MemoriahubWebHost } from '@marinoscar/memoriahub-web/core/headless';
import { AlbumsPage } from '@marinoscar/memoriahub-web/media/ui';

// The app builds the host once (useMemo: its state fields change over a session).
const host: MemoriahubWebHost = {
  apiClient, // get/post/put/patch/delete, refreshToken, rewriteEndpoint, rewriteBody, getAccessToken, baseUrl
  navigate, principal, authLoading, features, settings, ownerScope, notify, timeZone,
  slots: { 'media.lightbox': AppLightbox },
};

<MemoriahubWebHostProvider host={host}>
  <Route path="/albums" element={<AlbumsPage />} />
</MemoriahubWebHostProvider>;

// A slice's test needs no app.
// const { host } = createFakeMemoriahubWebHost({ routes: { 'GET /media/albums': { items: [], meta: {} } } });
// renderWithMemoriahubHost(<AlbumsPage />, host);
```

## Configuration

`MemoriahubWebHostProvider host={...}` takes one host; every field is read through `useMemoriahubHost()` or the hooks over it (`useOwnerScope`, `usePermissions`, `useFeatureFlags`). `apiClient` resolves with the `{ data }` envelope removed and rejects with a `MemoriahubApiError` (the app's own error class extends it, so `instanceof` agrees on both sides); the owner-scope rewrite of `circleId` belongs to the client. The package reads no environment variable. `slots` is where the host registers the components of slices that have not moved yet; a page renders nothing in the place of an absent slot.

## Extension-point catalog

| Extension point | Kind | What a host provides |
|---|---|---|
| `MemoriahubWebHost` | host | the one object every slice reads: transport, user, features, owner scope, notifications |
| `MemoriahubApiClient` | host | the HTTP transport, including the credential and the owner-scope rewrite |
| `MemoriahubSearchPort` | host | the search surface the map hands a filter to |
| `MemoriahubShellPort` | host | the shell's main-area layout (`full-bleed` for the map) |
| `MemoriahubAdminPort` | host | what an admin page needs from the platform: the data table, the admin page header and the deployment settings hook |
| `MemoriahubDataTableComponent` | host | the responsive data table (columns, pagination, row actions, CSV export) of `MemoriahubAdminPort` |
| `MemoriahubAdminPageHeaderComponent` | host | the admin console page header (back link, title, description) of `MemoriahubAdminPort` |
| `SearchPeopleExploreSlot` | slot | the people carousel of the Search page's explore view |
| `WorkflowPersonSelectSlot` | slot | the single-person picker of the `assign_person` and `remove_person` workflow actions |
| `MemoriahubWebSlots` | host | components of slices that have not moved into the package yet, by name |

## Data

None. The package stores nothing; its only browser state is a page's own React state and, in the map, the browser's geolocation permission.

## Permissions and settings

None of its own. A settings card is data with the exact permission string the API enforces (`memoriahubUserSettingsCards`, `Media sync` behind `media:read`); the app's registries spread it and the platform's `SettingsHub` draws it (Settings UI Pattern). The package adds no breakpoint read: the five coupled gates stay in the platform shell.

## UI

MUI pages and components that take their theme from the host's `ThemeProvider` (the package creates none). Pages are named exports of `media/ui`; the app lazy-loads the entry and picks a page per route. The map imports Leaflet's CSS from `media/ui/lib/leaflet-setup`, so the host's bundler must handle CSS imports.

## Infra

None. An image that installs the package must build it (`npm run build -w @marinoscar/memoriahub-web`) because `.dockerignore` drops every `dist/`; `apps/web/Dockerfile` does.

## Observability

None. The package adds no telemetry: browser spans and error reporting belong to the host.

## Security notes

No token or key is handled in the package: the host's API client carries the credential, and the package sends a bearer token only to a same-origin part URL (`uploadPart` refuses another origin). A public link renderer stays app-registered and never renders a private field.

## Conformance suite

`createFakeMemoriahubWebHost` and `renderWithMemoriahubHost` from `@marinoscar/memoriahub-web/core/testing` run a slice with no app; the package's own suite (`npm run test:run -w @marinoscar/memoriahub-web`) uses them. The web app's `runPlatformWebConformance` suites stay green with the packaged pages mounted.

## Upgrade notes

New package: nothing to upgrade from. A host field, a slot name or a slice entry is added, never renamed or removed; a host written against this release keeps working. When a slice moves into the package its host slot is deleted, and the app stops registering that component.

## Troubleshooting

`No MemoriahubWebHost` means a packaged page rendered without a `MemoriahubWebHostProvider` above it. A page that renders without its lightbox or drawer means the host registered no slot for it (`slots`). `Cannot find module '@marinoscar/memoriahub-web/...'` means the package was not built (`npm run build -w @marinoscar/memoriahub-web`). `Unknown file extension ".css"` means the host's bundler or test runner does not handle CSS imports (Vitest does by default).

## Links

- [Package documentation standard and checks](../../docs/PACKAGES.md)
- [Release runbook](../../docs/runbooks/release-memoriahub-packages.md)
- [ADR 0001: packages first](../../docs/decisions/0001-packages-first.md)
- [The Date Model](../../docs/specs/date-model.md): the civil `captured_at` rule the media utilities keep
- [Settings UI spec](../../docs/specs/settings-ui.md)
