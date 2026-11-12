# insights

Storage insights on the web: the admin Storage Insights page, its client and hook, and the chart pieces the review insights page shares.

## Purpose and scope

`insights/headless` carries `getInsights` and `refreshInsights` (the precomputed storage snapshot and its refresh job) and `useInsights`, which loads the snapshot and follows a refresh to its end. `insights/ui` carries `StorageInsightsPage` and the shared chart pieces `CompositionDonut`, `ProportionBar` and `FreshnessPill`; the `review` slice imports them for its Review Insights page.

The page takes its back link from the host's admin port (`useMemoriahubAdmin` of `core`) and stays registered in the app's admin section registry. The charts are why the `ui` entry has the `@mui/x-charts` peer.

## Entry point

`@marinoscar/memoriahub-web/insights/headless` and `@marinoscar/memoriahub-web/insights/ui`. The slice imports `core` through its entries.

## Peer dependencies

`react` and `react-dom` for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material`, `@mui/x-charts` and `react-router-dom`.

## Configuration

None of its own. It reads the host's API client, permissions and admin port.

## Extension-point catalog

None: the slice registers no slot of its own.
