---
"@marinoscar/memoriahub-api": minor
---

Add `WorkflowRunNotificationService` and the permanent `WORKFLOW_RUN_COMPLETED_EVENT_KEY` to the `workflows` slice of `@marinoscar/memoriahub-api` (private): the `workflow_run_completed` producer over the notify, settings and database ports (recipient resolution, the terminal-status filter and the opt-in volume guard for `on_media_enriched` micro-runs are unchanged). `WorkflowsModule.forRoot` provides and exports it.
