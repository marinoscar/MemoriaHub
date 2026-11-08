-- RETRO-A5b (issue #653): rename MemoriaHub's legacy storage-migration tables,
-- their enum types, indexes and constraints out of the way of platform
-- migration 0042_add_storage_migrations (@marinoscar/platform-db
-- 0.1.0-next.27), which creates storage_migration_runs,
-- storage_migration_items and the enum StorageMigrationItemStatus with a
-- different shape. Same pattern as 20260817000000_rename_legacy_platform_tables
-- (RETRO-A5): the old tables keep their rows and are read through
-- @@map("mh_legacy_<table>") until RETRO-D1 moves the admin storage-migration
-- API to the platform routes and drops them. StorageMigrationStatus does not
-- collide (the platform enum is StorageMigrationRunStatus) and is renamed too,
-- so every legacy storage-migration object carries the same prefix.
--
-- Metadata only: no row is rewritten and no column changes. The list was
-- generated from pg_class / pg_index / pg_constraint of a database after the
-- 122 earlier migrations. It sorts before the installed copy of platform 0042.
-- This file is final once committed; never edit it (platform.lock records its
-- hash, and comments count).

BEGIN;

-- Tables
ALTER TABLE "storage_migration_runs" RENAME TO "mh_legacy_storage_migration_runs";
ALTER TABLE "storage_migration_items" RENAME TO "mh_legacy_storage_migration_items";

-- Enum types
ALTER TYPE "StorageMigrationStatus" RENAME TO "MhLegacyStorageMigrationStatus";
ALTER TYPE "StorageMigrationItemStatus" RENAME TO "MhLegacyStorageMigrationItemStatus";

-- Constraints of mh_legacy_storage_migration_runs (a key's index is renamed with it)
ALTER TABLE "mh_legacy_storage_migration_runs" RENAME CONSTRAINT "storage_migration_runs_pkey" TO "mh_legacy_storage_migration_runs_pkey";

-- Constraints of mh_legacy_storage_migration_items (a key's index is renamed with it)
ALTER TABLE "mh_legacy_storage_migration_items" RENAME CONSTRAINT "storage_migration_items_object_id_fkey" TO "mh_legacy_storage_migration_items_object_id_fkey";
ALTER TABLE "mh_legacy_storage_migration_items" RENAME CONSTRAINT "storage_migration_items_pkey" TO "mh_legacy_storage_migration_items_pkey";
ALTER TABLE "mh_legacy_storage_migration_items" RENAME CONSTRAINT "storage_migration_items_run_id_fkey" TO "mh_legacy_storage_migration_items_run_id_fkey";
-- Standalone indexes of mh_legacy_storage_migration_items
ALTER INDEX "storage_migration_items_run_id_object_id_key" RENAME TO "mh_legacy_storage_migration_items_run_id_object_id_key";
ALTER INDEX "storage_migration_items_status_idx" RENAME TO "mh_legacy_storage_migration_items_status_idx";

COMMIT;
