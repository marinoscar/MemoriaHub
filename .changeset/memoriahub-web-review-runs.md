---
"@marinoscar/memoriahub-web": minor
---

Add the `review-runs` slice to `@marinoscar/memoriahub-web` (private): the shared run types, the review-run clients and hooks, `useRunPolling`, `RunProgressPanel`, the failed-items table columns, `ReviewRunPage` and `TrashEmptyRunPage`. `WorkflowRunPage` moves into the `workflows` slice, which now imports `review-runs`. The pages draw the failed-items table with the host's data table (the admin port), whose column type gains `truncate`. The web app mounts the packaged pages on the same routes and keeps one spec over the real platform table.
