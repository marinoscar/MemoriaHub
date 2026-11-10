---
"@marinoscar/memoriahub-db": minor
---

Add `@marinoscar/memoriahub-db`: the MemoriaHub domain's Prisma schema fragments (`schema/memoriahub.<slice>.prisma`), its baseline migration, the raw-SQL index, extension and schema-object inventories, and the `memoriahub-db` command (`sync`, `check`, `promote`) with `prisma/memoriahub.lock`. A host with the web app's history adopts the baseline without writing a directory or running SQL; a new host installs it after the platform's migrations. No table, column or index changes.
