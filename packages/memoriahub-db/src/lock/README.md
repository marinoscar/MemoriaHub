# lock

The lock files and the hashing they rest on.

## Purpose and scope

Reads, validates and writes `prisma/memoriahub.lock`; merges the domain's raw-SQL indexes and installed directories into the host's `prisma/platform.lock` (kept as a plain document so every field the platform owns is written back untouched); serialises JSON deterministically (keys sorted, two-space indent, one trailing newline, the way `platform.lock` is written); hashes bytes with SHA-256.

Status: implemented (RETRO-J3, #606).

## Entry point

`@marinoscar/memoriahub-db` (the package root re-exports this slice): `MemoriahubLock`, `MemoriahubLockEntry`, `readMemoriahubLock`, `parseMemoriahubLock`, `serializeMemoriahubLock`, `emptyMemoriahubLock`, `readPlatformLock`, `mergePlatformLock`, `serializeJson`, `sha256Hex`, `normaliseDefinition`, `MemoriahubLockError`, `MEMORIAHUB_LOCK_FILE`.

## Peer dependencies

None. The slice imports Node built-ins only.

## Configuration

None.

## Extension-point catalog

None.
