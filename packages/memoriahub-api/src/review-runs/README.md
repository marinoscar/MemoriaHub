# review-runs

The shared review-run engine of the MemoriaHub domain (RETRO-J9, #622): one async run model behind every bulk review-queue action.

## Purpose and scope

A bulk action on a review queue (resolve or dismiss every burst or duplicate group at or above a confidence threshold, accept or reject every location suggestion on one side of it) is a **run**: `ReviewRunService.createRun` checks the caller (collaborator on the circle, plus `media:delete` to trash), refuses a second active run of the same queue in the same circle (409; a different queue is allowed), and queues `review_run_evaluate`. The evaluate handler streams the strategy's eligible subjects into `review_run_items` in keyset pages (`createMany({ skipDuplicates })`, so a retry never double counts) and either completes the run (no matches) or fans out `review_run_execute_batch` jobs of 200 subjects. The execute handler claims a chunk (`matched` to `processing`), hands each subject to the strategy (`applied`, `skipped` or `failed`), fires the strategy's deferred effects once after the per-subject transactions commit, bumps the atomic counters and finalizes the run when **no row remains `matched` or `processing`** (never on counter equality: a subject cascade-deleted mid-run takes its item row with it). A cancelled run stops before its next batch. Job type strings and profiles are permanent: `review_run_evaluate` (15 minutes, three attempts), `review_run_execute_batch` (10 minutes, three attempts), and the two deprecated shims `location_suggestion_run_evaluate` and `location_suggestion_run_execute_batch`, kept registered because rows of those types may still be queued (they delegate into the engine). All four are server-only.

The slice knows **no review queue**. The owner of each queue registers a `ReviewRunSubjectStrategy` (what is eligible, how to apply the action, how to show a subject) with `ReviewRunSubjectRegistry`: the location slice registers the location-suggestion strategy; the web app still registers the burst and duplicate strategies, because the review services they wrap (`BurstService`, `DuplicateService`) have not moved. `ReviewRunsController` (`GET /api/review-runs/:id`, `.../items`, `POST .../cancel`) is an exported class written over `@MemoriahubAuth`, mounted by the host. Not in the slice: the nightly `review_run_history_purge` (stale-run sweep and retention over `review_runs` and `trash_empty_runs`), which stays in the web app because it is bound to the platform's `retention.reviewRuns` policy. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-api/review-runs` (and `@marinoscar/memoriahub-api/review-runs/testing`). It imports the `ports`, `core`, `testing` and `media` slices through their `index.ts` and nothing else of the package.

## Peer dependencies

`@nestjs/common`, `@nestjs/swagger`, `@marinoscar/memoriahub-contract` (`review-runs`), `@opentelemetry/api` and `nestjs-zod`.

## Configuration

`ReviewRunsModule.forRoot()`; the options object is reserved and empty. Import it once in the host and list `ReviewRunsController` in the module where the routes belong. No setting is read by the engine (the run history window is the host's retention policy). The engine uses `MEMORIAHUB_PRISMA` (narrowed to `reviewRun`, `reviewRunItem`, `auditEvent`), `MEMORIAHUB_ACCESS`, `MEMORIAHUB_JOBS` and, optionally, `MEMORIAHUB_METRICS` (`runsFinished`, `runItems` with `engine=review`).

## Extension-point catalog

`ReviewRunSubjectStrategy` and `ReviewRunSubjectRegistry` (`register`, or `registerReviewRunStrategy`): the registry a queue owner adds its strategy to. A strategy declares its `subject`, the `review_run_items` column its ids live in and the actions it supports, and implements `evaluatePage`, `executeItem`, optional `deferredEffects` and `hydrateItems`. `describeReviewRunsSliceConformance` (`./review-runs/testing`) proves the engine against a scripted strategy over `FakeReviewRunsDb`: creation refusals, the per-queue concurrency guard, evaluate and finalize with applied, skipped and failed subjects, and cancellation.
