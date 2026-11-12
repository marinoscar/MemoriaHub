# node-backup

The admin Node Backup page on the web: the status, schedule and run history of one worker node's Local Media Backup.

## Purpose and scope

`node-backup/headless` carries the backup wire types and the three clients over `GET` and `PUT /api/nodes/:id/backup/config` and `GET /api/nodes/:id/backup/runs`, and `useNodeBackup` (the config and runs of one node with a 15-second silent poll). `node-backup/ui` carries `NodeBackupPage` (the status card, the config editor with schedule presets and the circle include-list, the recent-runs table) and `nodeBackupTable` (the run columns).

This is the MemoriaHub domain rather than a platform page: the feature mirrors a circle's original media bytes onto a node's disk, the API behind it is the app's `node-backup` module and the `backup.*` settings are the domain's. The platform's Worker Nodes page only links to it through a row action; the app mounts the page on `/admin/settings/workers/:id/backup`. The runs table is the host's admin-port table.

## Entry point

`@marinoscar/memoriahub-web/node-backup/headless` and `@marinoscar/memoriahub-web/node-backup/ui`. The slice imports `core` through its entries.

## Peer dependencies

`react` and `react-dom` for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

None of its own. It reads the host's API client, permissions, owner scope and admin port.

## Extension-point catalog

None: the slice registers no slot of its own.
