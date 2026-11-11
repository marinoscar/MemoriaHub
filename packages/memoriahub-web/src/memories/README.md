# memories

Auto-curated memories (On This Day, trips, people highlights, themes, seasonal, year in review): the feed carousel, the Memories page, the detail page with the full-screen story player, and the clients and hooks behind them.

## Purpose and scope

`memories/headless` carries the clients over the host's API client (`listMemories`, `getMemoriesFeed`, `getMemory`, the per-user seen, hide and favorite calls, `deleteMemory`, `saveMemoryAsAlbum`), the hooks that load them (`useMemories`, `useMemoriesFeed`, `useMemory`, `useMemoryActions`, `useMemoriesEnabled`, the optimistic list state), the story timing math (`storyTiming`) and the wire types, including the per-user preference shapes and limits (`MemoryHiddenDateRange`, `MEMORIES_MAX_HIDDEN_PERSON_IDS`, ...). `memories/ui` carries `MemoriesPage`, `MemoryDetailPage`, `MemoriesCarousel`, `MemoryCard`, `MemoryStoryPlayer`, the action menu and the delete and save-as-album dialogs. The feature flag is read from the host (`features.flags.memories`), so a flag outage hides the affordance and fires no request. A request is never sent while Memories is off.

Staying in the app: the per-user preferences card (`MemoriesSettings`, `MemoriesPreferencesPage`), because it picks people with the people slice's hook and avatar, and the admin Memories settings page. Both import the types, limits and `useMemoriesEnabled` from this slice. The share dialog the save-as-album flow opens is the media slice's `MediaShareDialogSlot`, which the host registers.

## Entry point

`@marinoscar/memoriahub-web/memories/headless` and `@marinoscar/memoriahub-web/memories/ui`. The slice imports `core` and `media` through their entries.

## Peer dependencies

`react`, `react-dom` and the optional `@marinoscar/memoriahub-contract` (type-only) for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

None of its own. It reads the host's API client, owner scope, principal, feature flags and the `media.shareDialog` slot.

## Extension-point catalog

None: the slice registers no slot of its own.
