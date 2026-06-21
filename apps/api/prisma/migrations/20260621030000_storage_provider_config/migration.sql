-- CreateEnum
CREATE TYPE "StorageMigrationStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "StorageMigrationItemStatus" AS ENUM ('pending', 'copying', 'verified', 'completed', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "storage_provider_credentials" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "encrypted_key" TEXT NOT NULL,
    "access_key_id" TEXT,
    "region" TEXT,
    "bucket" TEXT,
    "endpoint" TEXT,
    "last4" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "storage_provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_migration_runs" (
    "id" UUID NOT NULL,
    "source_provider" TEXT NOT NULL,
    "target_provider" TEXT NOT NULL,
    "status" "StorageMigrationStatus" NOT NULL DEFAULT 'pending',
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "migrated_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_migration_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_migration_items" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "object_id" UUID NOT NULL,
    "status" "StorageMigrationItemStatus" NOT NULL DEFAULT 'pending',
    "job_id" UUID,
    "new_storage_key" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "storage_migration_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "storage_provider_credentials_provider_key" ON "storage_provider_credentials"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "storage_migration_items_run_id_object_id_key" ON "storage_migration_items"("run_id", "object_id");

-- CreateIndex
CREATE INDEX "storage_migration_items_status_idx" ON "storage_migration_items"("status");

-- AddForeignKey
ALTER TABLE "storage_provider_credentials" ADD CONSTRAINT "storage_provider_credentials_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_migration_items" ADD CONSTRAINT "storage_migration_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "storage_migration_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_migration_items" ADD CONSTRAINT "storage_migration_items_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "storage_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
