# review

The review queues of the web app: the burst, duplicate and location-suggestion pages, their group detail pages, the shared review components and the clients and hooks behind them.

## Purpose and scope

`review/headless` carries the clients over the host's API client for the three queues (`bursts`: list, detail, resolve, dismiss and the bulk-by-threshold starters; `duplicates`: the same plus `rerunDuplicateDetection`; `locationSuggestions`: list, accept, reject, revert and `inferLocation`), the hooks that load them (`useBurstGroups`, `useBurstGroupDetail`, `useDuplicateGroups`, `useDuplicateGroupDetail`, `useLocationSuggestions`, `useSuggestLocation`, `useItemLocationCandidate`, `useItemAutoAppliedSuggestion`) and the wire types. A bulk threshold action starts a run that the `review-runs` slice's `ReviewRunPage` watches. `review/ui` carries `BurstsPage`, `BurstGroupPage`, `DuplicatesPage`, `DuplicateGroupPage`, `LocationSuggestionsPage`, `AdjustLocationDialog`, `LocationSuggestionRunRedirect` and the shared pieces: `ConfidenceMeter`, `FeatureDisabledNotice`, `GroupBulkResolveToolbar`, `MemberComparison`, `ReviewSortSelect` and `SelectionCheckboxOverlay`.

The pages read the confidence floors they preselect (`burst.autoResolveThreshold`, `dedup.autoResolveThreshold`, `locationInference.bulkAcceptThreshold`) through the host's admin port (`useMemoriahubAdmin().useSystemSettings`) and the feature flags (`useFeatureFlags`) through `core`: a loaded flag record that does not say `true` means the feature is off, while a flags outage stays silent.

Staying in the app: the Review hub and queue pages with their registry (`ReviewHubPage`, `ReviewQueuePage`, `config/reviewQueues`, `useReviewQueues`, `useReviewCounts`, `ReviewQueueList`), because the shell's badge, the context pane and the Collections hub read them and the queue page opens the enhancement page; the review insights page; and the three admin settings pages of these features, which are registered in the app's admin section registry.

## Entry point

`@marinoscar/memoriahub-web/review/headless` and `@marinoscar/memoriahub-web/review/ui`. The slice imports `core`, `media` and `review-runs` through their entries.

## Peer dependencies

`react`, `react-dom` and the optional `@marinoscar/memoriahub-contract` (type-only: the burst, dedup and location schemas) for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

None of its own. It reads the host's API client, owner scope, permissions, feature flags and admin port.

## Extension-point catalog

None: the slice registers no slot of its own.
