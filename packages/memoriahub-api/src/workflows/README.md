# workflows

Media Workflow Automation of the MemoriaHub domain (RETRO-J9, #622, epic #138): the **Subject, Trigger, If, Then** rule engine. A circle collaborator defines a workflow (conditions over the Media Item field catalog and an ordered action list), previews what it matches, and runs it manually, on a cron schedule, or whenever a new item finishes enrichment.

## Purpose and scope

The slice owns the versioned definition (`workflow-definition.schema`, validated by `WorkflowDefinitionValidator`: registry-aware, with the params schema of every action checked at save time), the `WorkflowConditionCompiler` (a definition to a Prisma `where`, plus read-time refinements for predicates Prisma cannot express, and the dependency set a workflow reads), the per-Subject registry (`registerWorkflowField`, `registerWorkflowAction`; v1 has one Subject, `media_item`), `WorkflowsService` (CRUD, preview), `WorkflowRunService` (create, approve, cancel, the gated-action authorization and the batch fan-out), `WorkflowsAdminService` (oversight) and three controllers over `@MemoriahubAuth` (`WorkflowsController`, `WorkflowRunsController`, `WorkflowsAdminController`: exported classes the host mounts).

Five job handlers register through the jobs port. Type strings and profiles are permanent:

| Type | Profile | Notes |
|---|---|---|
| `workflow_evaluate` | 15 min, 3 attempts | keyset-materializes a run's matched items; server-only |
| `workflow_evaluate_item` | 1 min, 3 attempts | one item against one `on_media_enriched` workflow, appended to a rolling micro-run; server-only |
| `workflow_execute_batch` | 10 min, 3 attempts | applies the ordered actions per item; **node-claimable** (the node pair; `persistNodeResult` re-derives everything from the trusted payload) |
| `workflows.schedule_tick` | 5 min, 3 attempts | starts the unattended runs of due `scheduled` workflows; server-only |
| `workflows.micro_run_finalize` | 5 min, 3 attempts | dispatches micro-runs whose 5-minute window closed; server-only |

`WorkflowScheduleTask` and `WorkflowMicroRunFinalizeTask` are the two every-minute crons: they only decide work is due and enqueue the tick (priority 20). `WorkflowTriggerService.evaluateSettlement` is the on_media_enriched decision (feature gate, one indexed backpressure query, the item's dependency snapshot, one `workflow_evaluate_item` per ready workflow); the host calls it from its two upstream signals.

**Not in the slice:** the implementation of the actions, the review-queue half of the catalog (burst, duplicate and location-suggestion fields and resolve, dismiss, accept, reject actions), the listener that turns the host's events into `evaluateSettlement`, the webhook and notification side channels, and the nightly `workflow_history_purge` (bound to the platform's retention policy). The web app keeps them in `apps/api/src/workflows`: applying an action calls the media, face, burst, duplicate and location services, and `BurstService` and `DuplicateService` have not moved. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-api/workflows` (and `@marinoscar/memoriahub-api/workflows/testing`). It imports the `ports`, `core`, `testing` and `media` slices through their `index.ts` and nothing else of the package. The built-in item-level where fragments are the media slice's where-builder, the same one search composes.

## Peer dependencies

`@nestjs/common`, `@nestjs/schedule` (the crons), `@nestjs/swagger`, `@marinoscar/memoriahub-contract` (`workflows`), `@marinoscar/memoriahub-compute` (the node result schema), `@opentelemetry/api`, `nestjs-zod` and `zod`.

## Configuration

`WorkflowsModule.forRoot()`; the options object is reserved and empty. Import it once in the host and list the three controllers where the routes belong. Settings are read through the settings port as two namespaces, `features` (`workflows`; `WORKFLOWS_ENABLED=false` overrides it) and `workflows` (`maxItemsPerRun`, `batchSize`, `maxConcurrentRuns`, `requirePreview`, `allowHardDelete`, `maxWorkflowsPerCircle`, `previewTtlHours`, `triggers.onEnrichment`, `triggers.scheduled`, `scheduleMinIntervalMinutes`; `runHistoryRetentionDays` is the host's purge). Ports used: `MEMORIAHUB_PRISMA` (narrowed to `WorkflowsDb`), `MEMORIAHUB_SETTINGS`, `MEMORIAHUB_ACCESS`, `MEMORIAHUB_JOBS`, `MEMORIAHUB_IDENTITY` (the actor's permissions) and, optionally, `MEMORIAHUB_METRICS` (`runsFinished`, `runItems` with `engine=workflow`).

## Extension-point catalog

| Name | Kind | Purpose |
|---|---|---|
| `registerWorkflowField`, `registerWorkflowAction` | registry | add a condition field or an action to a Subject's catalog (idempotent per key; catalog order is registration order, built-ins first) |
| `WorkflowActionHandlerRegistry`, `WorkflowActionHandler` | registry, interface | the host's implementation of one or more action types; an action type with no handler is a failed outcome |
| `WORKFLOW_RUN_OBSERVER`, `WorkflowRunObserver` | token, interface | optional: what happens after a run's terminal or approval write commits (webhook events, the run-completed notification); never throws |
| `describeWorkflowsSliceConformance`, `FakeWorkflowsDb` | conformance kit | proves the five handlers, node eligibility, malformed payloads, the delete guards and the executor dispatch |
