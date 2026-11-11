# workflows

Media workflow automation on the web: the workflow list, the builder (subject, trigger, conditions, actions, safety, live preview), the templates gallery and the run history, with the clients, hooks and pure helpers behind them.

## Purpose and scope

`workflows/headless` carries the clients over the host's API client (`workflows.ts`: list, create, update, delete, preview, run, approve, cancel, run detail and items), the hooks that load them (`useWorkflows`, `useWorkflow`, `useWorkflowSubjects` with `useWorkflowsEnabled`, `useWorkflowPreview`, `useWorkflowMutations`, `useWorkflowRun`, `useWorkflowRuns`, `useWorkflowRunItems`), the wire types, the builder's pure state machine (`builderState`: definition to editable state and back, the sanitiser the preview sends), the action metadata and the starter templates, and the pure helpers (`workflowCron` validation, `workflowFormat` labels and relative times, `workflowSentence`, which writes a definition as an English sentence). `workflows/ui` carries `WorkflowListPage`, `WorkflowBuilderPage`, `WorkflowCard`, `WorkflowRunHistory`, `WorkflowTemplatesGallery` and the builder blocks. The run formatters shared by every async-run page and the scrollable tab props live in `core`.

Components of slices that have not moved are reached through host slots: the people picker of a condition is the media slice's `PersonMultiSelectSlot`, and the single-person picker of the `assign_person` and `remove_person` actions is this slice's `WorkflowPersonSelectSlot`.

Staying in the app: the run page (`WorkflowRunPage`, built on the shared run progress panel and item table, which the review and trash runs also use), the admin settings page, the oversight table and the runs drawer (the platform data table and the app's admin page header), and the admin workflow client. They import this slice's types, hooks and formatters.

## Entry point

`@marinoscar/memoriahub-web/workflows/headless` and `@marinoscar/memoriahub-web/workflows/ui`. The slice imports `core` and `media` through their entries.

## Peer dependencies

`react`, `react-dom` and the optional `@marinoscar/memoriahub-contract` (type-only) for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

The host registers the person picker under `WORKFLOW_PERSON_SELECT_SLOT` (`workflows.personSelect`, props `WorkflowPersonSelectSlotProps`) and the condition people picker under the media slice's `PERSON_MULTI_SELECT_SLOT`. Feature gating (`features.workflows`) and the active owner scope come from the host.

## Extension-point catalog

The slot bridge `WorkflowPersonSelectSlot` is the extension point: the host chooses the component. It is deleted when the people slice moves into the package.
