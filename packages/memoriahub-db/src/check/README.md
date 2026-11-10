# check

Prove the installed copies match the package; check a live database.

## Purpose and scope

`checkMemoriahubInstall` compares the package with its manifest, every fragment copy and installed migration byte for byte, `memoriahub.lock` with the folder and `platform.lock` with the inventory; with `database` it also reads catalogs (`pg_extension`, `pg_indexes`, `pg_trigger`, `pg_proc`, `pg_constraint`, `information_schema.columns`) with `SELECT`s only. It also holds the fragments to the raw-SQL index tripwire.

Status: implemented (RETRO-J3, #606).

## Entry point

`@marinoscar/memoriahub-db`: `checkMemoriahubInstall`, `checkPackage`, `checkDatabaseCatalog`, `checkFragmentDeclarations`, `readDatabaseCatalog`, `scanFragmentIndexes`, `MemoriahubCheckUsageError` and the option and result types.

## Peer dependencies

None declared. `pg` is resolved at run time from the app (then from this package) only for `database`, so the offline checks need nothing; it is not a peer of the package.

## Configuration

`MemoriahubCheckOptions` (`root`, `database`, `databaseUrl`, `packageDir`, `catalog`); `DATABASE_URL` is the default connection string.

## Extension-point catalog

None.
