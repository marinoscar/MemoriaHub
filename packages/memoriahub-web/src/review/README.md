# review

The review queues of the web app: the burst, duplicate and location-suggestion pages, their group detail pages, the shared review components and the clients and hooks behind them.

## Purpose and scope

`review/headless` carries the clients over the host's API client for the three queues (`bursts`: list, detail, resolve, dismiss and the bulk-by-threshold starters; `duplicates`: the same plus `rerunDuplicateDetection`; `locationSuggestions`: list, accept, reject, revert and `inferLocation`), the hooks that load them (`useBurstGroups`, `useBurstGroupDetail`, `useDuplicateGroups`, `useDuplicateGroupDetail`, `useLocationSuggestions`, `useSuggestLocation`, `useItemLocationCandidate`, `useItemAutoAppliedSuggestion`) and the wire types. A bulk threshold action starts a run that the `review-runs` slice's `ReviewRunPage` watches. `review/ui` carries `BurstsPage`, `BurstGroupPage`, `DuplicatesPage`, `DuplicateGroupPage`, `LocationSuggestionsPage`, `AdjustLocationDialog`, `LocationSuggestionRunRedirect` and the shared pieces: `ConfidenceMeter`, `FeatureDisabledNotice`, `GroupBulkResolveToolbar`, `MemberComparison`, `ReviewSortSelect` and `SelectionCheckboxOverlay`.

`review/ui` also carries the three admin settings pages of the features: `BurstsSettingsPage`, `DuplicatesSettingsPage` and `LocationInferenceSettingsPage` (the global switch, the detection parameters, the auto-resolve and bulk-accept thresholds and the global backfill), with their backfill clients in `review/headless` (`runGlobalBurstBackfill`, `runGlobalDuplicatesBackfill`, `getDuplicatesStatus`, `runGlobalLocationInferenceBackfill`). They take their page header and system-settings hook from the host's admin port and stay registered in the app's admin section registry.

`review/ui` also carries `ReviewInsightsPage` (the burst and duplicate queue metrics of the active circle, charted with the `insights` slice's `CompositionDonut` and `ProportionBar`) with its `getReviewInsights` client and `useReviewInsights` hook.

The review pages read the confidence floors they preselect (`burst.autoResolveThreshold`, `dedup.autoResolveThreshold`, `locationInference.bulkAcceptThreshold`) through the host's admin port (`useMemoriahubAdmin().useSystemSettings`) and the feature flags (`useFeatureFlags`) through `core`: a loaded flag record that does not say `true` means the feature is off, while a flags outage stays silent.

Staying in the app: the Review hub and queue pages with their registry (`ReviewHubPage`, `ReviewQueuePage`, `config/reviewQueues`, `useReviewQueues`, `useReviewCounts`, `ReviewQueueList`), because the shell's badge, the context pane and the Collections hub read them and the queue page opens the enhancement page; and the review insights page (it shares the chart components with the admin Storage Insights page).

## Entry point

`@marinoscar/memoriahub-web/review/headless` and `@marinoscar/memoriahub-web/review/ui`. The slice imports `core`, `media` and `review-runs` through their entries.

## Peer dependencies

`react`, `react-dom` and the optional `@marinoscar/memoriahub-contract` (type-only: the burst, dedup and location schemas) for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

None of its own. It reads the host's API client, owner scope, permissions, feature flags and admin port.

## Extension-point catalog

None: the slice registers no slot of its own.
