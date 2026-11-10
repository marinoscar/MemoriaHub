# sync

Install the domain fragments and migrations into a host app.

## Purpose and scope

`planMemoriahubSync` decides what to write (fragment copies with the GENERATED header, migration directories under `original`, `stable` or (deprecated) `after-host` names, `memoriahub.lock`, the `platform.lock` merge) and refuses what would break a rule; `applyMemoriahubSync` writes it and never overwrites an installed migration. The baseline migration (the whole domain schema, for a host with no MemoriaHub history) is installed on such a host and only recorded as `adopted` (no directory, `installedDir: null`) on a host whose history already built it, which is the web app.

Status: implemented (RETRO-J3, #606).

## Entry point

`@marinoscar/memoriahub-db`: `planMemoriahubSync`, `applyMemoriahubSync`, `renderFragmentCopy`, `stableName`, `afterHostNames` (deprecated), `findMissingHostModels`, `MemoriahubSyncError`, `FRAGMENT_GENERATED_LINE` and the option and plan types.

## Peer dependencies

None. The slice imports Node built-ins only.

## Configuration

`MemoriahubSyncOptions` (`root`, `fragmentsDir`, `migrationsDir`, `names`, `baseline`, `dryRun`, `packageDir`, `platformSchemaDir`); the command's flags map one to one.

## Extension-point catalog

None.
