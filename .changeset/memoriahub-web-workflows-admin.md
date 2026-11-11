---
"@marinoscar/memoriahub-web": minor
---

Move the workflows admin page into the `workflows` slice of `@marinoscar/memoriahub-web` (private): `WorkflowsSettingsPage`, the oversight table, the runs drawer, the danger card, the KPI strip and the admin workflow client (`adminWorkflows`). They read the data table, the admin page header and the system-settings hook from the host's admin port. `core/ui` gains `KpiCard` and `KpiSkeleton` (moved from the app, which now imports them from the package; `core`'s `ui` entry now peers on `@mui/material`), and the admin port's column type gains `hideable`. The web app mounts the packaged page on the same route; nothing changes for users.
