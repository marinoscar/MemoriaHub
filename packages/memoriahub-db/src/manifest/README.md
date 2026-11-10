# manifest

The package's own data: manifest, inventories, host tables.

## Purpose and scope

Reads and validates `migrations/manifest.json`, `raw-sql-indexes.json`, `extensions.json` and `schema-objects.json` of the package folder, and exports the inventories as constants (`MEMORIAHUB_RAW_SQL_INDEXES`, `MEMORIAHUB_EXTENSIONS`, `MEMORIAHUB_HOST_TABLES`). It also finds the package root and its version.

Status: implemented (RETRO-J3, #606).

## Entry point

`@marinoscar/memoriahub-db`: `readManifest`, `parseManifest`, `serializeManifest`, `readInventories`, `listPackageFragments`, `memoriahubDbPackageRoot`, `memoriahubDbVersion`, `MEMORIAHUB_RAW_SQL_INDEXES`, `MEMORIAHUB_EXTENSIONS`, `MEMORIAHUB_HOST_TABLES`, `MEMORIAHUB_HOST_MODELS` and the entry types.

## Peer dependencies

None. The slice imports Node built-ins only.

## Configuration

None. The constants are read from the package folder when the module loads.

## Extension-point catalog

None.
