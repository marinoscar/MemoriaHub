# hubs

The Review hub on the web: the `/review` inbox, the pages of its queues, the shared queue list and the pending counts behind the sidebar badge.

## Purpose and scope

`hubs/headless` carries `useReviewCounts` (the four review-queue counts of the active circle, shared and refreshable through `refreshReviewCounts`, so the hub list and the rail badge never disagree). `hubs/ui` carries the registry `REVIEW_QUEUES` (bursts, duplicates, locations, enhancements, insights, automations, in a fixed order that is never sorted by count), `useReviewQueues` (the entries the caller can reach, with their counts and the aggregate badge total), `ReviewQueueList` (the list on the hub page and, in `pane` form, the desktop context pane), `ReviewHubPage` (`/review`) and `ReviewQueuePage` (`/review/:queue`, which mounts each queue's own page lazily from the `review`, `enhancement` and `workflows` slices and adds a way back and chain-to-next).

The hub is the phone and tablet form of what the desktop context pane shows, so `ReviewHubPage` redirects into the first enabled queue while the pane is on screen. Whether it is on screen is the host's: `shell.useContextPaneVisible` of the host's shell port. Scroll restoration is `core`'s `useScrollRestoration`.

## Entry point

`@marinoscar/memoriahub-web/hubs/headless` and `@marinoscar/memoriahub-web/hubs/ui`. The slice imports `core`, `media`, `review`, `enhancement` and `workflows` through their entries.

## Peer dependencies

`react` and `react-dom` for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

None of its own. It reads the host's owner scope, feature flags and shell port.

## Extension-point catalog

None: the slice registers no slot of its own; the context-pane answer it reads is `core`'s shell port.
