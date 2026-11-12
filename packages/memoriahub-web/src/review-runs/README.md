# review-runs

The async run pages of the web app: the shared run progress panel and failed-items table, the run polling hook, and the review-queue and empty-trash run pages, with the clients behind them.

## Purpose and scope

`review-runs/headless` carries the shared run wire types (`BaseRun`, `BaseRunDetail`, `BaseRunItem`, `RunItemStatus`, `RunListMeta`), the review-run types (`ReviewRunDetail`, `ReviewRunItem`, `CreateReviewRunResponse`), the clients over the host's API client (`getReviewRun`, `listReviewRunItems`, `cancelReviewRun`, the location accept and reject starters `startLocationAcceptRun` and `startLocationRejectRun`, and `startRunErrorMessage`, which turns the per-queue 409 into one sentence), and the hooks (`useReviewRun`, `useReviewRunItems`, `useTrashEmptyRun`, `useTrashEmptyRunItems`, and `useRunPolling`, which polls a run's detail endpoint until its status is terminal). `review-runs/ui` carries `RunProgressPanel` (one presentational progress panel for every run), `buildRunItemColumns` (the failed-items table's column declarations), `ReviewRunPage` (burst, duplicate and location-suggestion bulk runs, titled from the run's subject and action) and `TrashEmptyRunPage`. The workflows slice builds `WorkflowRunPage` on the same panel, polling hook and item table; the enhancement batch page, which stays in the app, does too.

The pages draw the failed-items table with the host's data table (`useMemoriahubAdmin` of `core`), so the table's column picker, responsive card layout and layout persistence stay the platform's. The run formatters (`runStatusLabel`, `formatRelativeTime`, ...) live in `core`.

## Entry point

`@marinoscar/memoriahub-web/review-runs/headless` and `@marinoscar/memoriahub-web/review-runs/ui`. The slice imports `core` and `media` (the empty-trash run client) through their entries.

## Peer dependencies

`react`, `react-dom` and the optional `@marinoscar/memoriahub-contract` (type-only: `ReviewRunSubject`, `ReviewRunAction`) for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

None of its own. It reads the host's API client, owner scope and data table.

## Extension-point catalog

None: the slice registers no slot of its own.
