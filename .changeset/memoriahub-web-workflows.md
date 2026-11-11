---
"@marinoscar/memoriahub-web": minor
---

Add the `workflows` slice to `@marinoscar/memoriahub-web` (private): the workflow clients, hooks, builder state, action metadata, starter templates and pure formatters (`workflows/headless`) and the workflow list and builder pages with their blocks, the card, the templates gallery and the run history (`workflows/ui`). `core` gains the shared run formatters (`runStatusColor`, `formatRelativeTime`, ...) and `scrollableTabsProps`. The single-person picker of the person actions is a host slot (`workflows.personSelect`) until the people slice moves; the run page and the admin pages stay in the app. The web app mounts the packaged pages on the same routes; nothing changes for users.
