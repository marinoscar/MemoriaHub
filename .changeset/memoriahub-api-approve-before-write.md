---
'@marinoscar/memoriahub-api': patch
---

`WorkflowRunService.approveRun` validates the `DELETE {matchedCount}` confirmation and the gated-action re-authorization before it writes anything, so a refused approval no longer marks the listed `excludedItemIds` as `excluded`; the run stays `awaiting_approval` and every item stays `matched`. Responses and messages are unchanged.
