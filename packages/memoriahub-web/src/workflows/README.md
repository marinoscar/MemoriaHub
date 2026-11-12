# workflows

Media workflow automation on the web: the workflow list, the builder (subject, trigger, conditions, actions, safety, live preview), the templates gallery, the run history and the admin settings and oversight page, with the clients, hooks and pure helpers behind them.

## Purpose and scope

`workflows/headless` carries the clients over the host's API client (`workflows.ts`: list, create, update, delete, preview, run, approve, cancel, run detail and items), the hooks that load them (`useWorkflows`, `useWorkflow`, `useWorkflowSubjects` with `useWorkflowsEnabled`, `useWorkflowPreview`, `useWorkflowMutations`, `useWorkflowRun`, `useWorkflowRuns`, `useWorkflowRunItems`), the wire types, the builder's pure state machine (`builderState`: definition to editable state and back, the sanitiser the preview sends), the action metadata and the starter templates, and the pure helpers (`workflowCron` validation, `workflowFormat` labels and relative times, `workflowSentence`, which writes a definition as an English sentence). `workflows/ui` carries `WorkflowListPage`, `WorkflowBuilderPage`, `WorkflowCard`, `WorkflowRunHistory`, `WorkflowTemplatesGallery`, the builder blocks and the admin page: `WorkflowsSettingsPage` (feature and trigger switches, engine limits, the hard-delete danger card, the KPI strip), `WorkflowsOversightTable` and `WorkflowRunsDrawer`. `workflows/headless` also carries the admin client (`adminWorkflows.ts`: stats, every workflow, every run, force-disable, cancel). The admin page takes its data table, page header and system-settings hook from the host's admin port (`useMemoriahubAdmin` of `core`) and stays registered in the app's admin section registry. The run formatters shared by every async-run page and the scrollable tab props live in `core`.

Components of slices that have not moved are reached through host slots: the people picker of a condition is the media slice's `PersonMultiSelectSlot`, and the single-person picker of the `assign_person` and `remove_person` actions is this slice's `WorkflowPersonSelectSlot`.

`workflows/ui` also carries `WorkflowRunPage` (approval preview, live progress and failed items), built on the `review-runs` slice's run progress panel, run polling hook and item table, which the review-queue and trash runs also use.

## Entry point

`@marinoscar/memoriahub-web/workflows/headless` and `@marinoscar/memoriahub-web/workflows/ui`. The slice imports `core`, `media` and `review-runs` through their entries.

## Peer dependencies

`react`, `react-dom` and the optional `@marinoscar/memoriahub-contract` (type-only) for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

The host registers the person picker under `WORKFLOW_PERSON_SELECT_SLOT` (`workflows.personSelect`, props `WorkflowPersonSelectSlotProps`) and the condition people picker under the media slice's `PERSON_MULTI_SELECT_SLOT`. Feature gating (`features.workflows`) and the active owner scope come from the host.

## Extension-point catalog

The slot bridge `WorkflowPersonSelectSlot` is the extension point: the host chooses the component. It is deleted when the people slice moves into the package.
