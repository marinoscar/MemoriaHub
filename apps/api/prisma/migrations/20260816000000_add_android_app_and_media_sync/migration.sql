-- Android app releases + Media Sync (epic #498, issue #502).

-- CreateEnum
CREATE TYPE "MediaSyncDeviceStatus" AS ENUM ('active', 'revoked');

-- CreateEnum
CREATE TYPE "MediaSyncTrigger" AS ENUM ('periodic', 'content_trigger', 'manual', 'app_open', 'initial');

-- CreateEnum
CREATE TYPE "MediaSyncRunStatus" AS ENUM ('ok', 'partial', 'failed', 'skipped', 'paused');

-- CreateTable
CREATE TABLE "android_app_releases" (
    "id" UUID NOT NULL,
    "package_name" TEXT NOT NULL,
    "version_name" VARCHAR(50) NOT NULL,
    "version_code" INTEGER NOT NULL,
    "signing_sha256" TEXT NOT NULL,
    "file_sha256" CHAR(64) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "notes" VARCHAR(2000),
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "android_app_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_sync_devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "android_version" TEXT,
    "sdk_int" INTEGER,
    "app_version" TEXT,
    "app_version_code" INTEGER,
    "package_name" TEXT,
    "signing_sha256" TEXT,
    "timezone" TEXT,
    "pat_id" UUID,
    "status" "MediaSyncDeviceStatus" NOT NULL DEFAULT 'active',
    "config" JSONB NOT NULL,
    "config_version" INTEGER NOT NULL DEFAULT 1,
    "applied_config_version" INTEGER NOT NULL DEFAULT 0,
    "inventory" JSONB,
    "stats" JSONB,
    "permission" TEXT,
    "network_state" TEXT,
    "battery_optimized" BOOLEAN,
    "last_seen_at" TIMESTAMPTZ,
    "last_sync_at" TIMESTAMPTZ,
    "last_sync_status" "MediaSyncRunStatus",
    "last_error" VARCHAR(1000),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "media_sync_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_sync_runs" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "trigger" "MediaSyncTrigger" NOT NULL,
    "status" "MediaSyncRunStatus" NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "finished_at" TIMESTAMPTZ NOT NULL,
    "files_uploaded" INTEGER NOT NULL DEFAULT 0,
    "files_failed" INTEGER NOT NULL DEFAULT 0,
    "files_deduplicated" INTEGER NOT NULL DEFAULT 0,
    "bytes_uploaded" BIGINT NOT NULL DEFAULT 0,
    "error_code" VARCHAR(64),
    "details" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_sync_diagnostic_reports" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "summary" VARCHAR(500),
    "report" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_sync_diagnostic_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "android_app_releases_created_at_idx" ON "android_app_releases"("created_at");

-- CreateIndex
CREATE INDEX "android_app_releases_uploaded_by_id_idx" ON "android_app_releases"("uploaded_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "android_app_releases_package_name_version_code_key" ON "android_app_releases"("package_name", "version_code");

-- CreateIndex
CREATE INDEX "media_sync_devices_user_id_status_idx" ON "media_sync_devices"("user_id", "status");

-- CreateIndex
CREATE INDEX "media_sync_devices_pat_id_idx" ON "media_sync_devices"("pat_id");

-- CreateIndex
CREATE INDEX "media_sync_devices_last_seen_at_idx" ON "media_sync_devices"("last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_sync_devices_user_id_installation_id_key" ON "media_sync_devices"("user_id", "installation_id");

-- CreateIndex
CREATE INDEX "media_sync_runs_device_id_created_at_idx" ON "media_sync_runs"("device_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "media_sync_diagnostic_reports_device_id_created_at_idx" ON "media_sync_diagnostic_reports"("device_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "android_app_releases" ADD CONSTRAINT "android_app_releases_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_sync_devices" ADD CONSTRAINT "media_sync_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_sync_devices" ADD CONSTRAINT "media_sync_devices_pat_id_fkey" FOREIGN KEY ("pat_id") REFERENCES "personal_access_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_sync_runs" ADD CONSTRAINT "media_sync_runs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "media_sync_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_sync_diagnostic_reports" ADD CONSTRAINT "media_sync_diagnostic_reports_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "media_sync_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Raw-SQL constraints (intentional schema drift: Prisma cannot express these).
-- Never declare android_app_releases_one_current_uniq_idx as @@unique and never
-- replace it with a findFirst pre-check; make-current clears the old flag and
-- sets the new one in one transaction, and the database rejects a second
-- current row (P2002).
-- =============================================================================

-- At most one current release deployment-wide.
CREATE UNIQUE INDEX "android_app_releases_one_current_uniq_idx" ON "android_app_releases" ((true)) WHERE "is_current";

-- Run counters are never negative.
ALTER TABLE "media_sync_runs"
  ADD CONSTRAINT "media_sync_runs_counts_chk" CHECK (
    "files_uploaded" >= 0 AND "files_failed" >= 0 AND "files_deduplicated" >= 0 AND "bytes_uploaded" >= 0
  );

-- Device display name is 1-100 chars.
ALTER TABLE "media_sync_devices"
  ADD CONSTRAINT "media_sync_devices_name_length_chk" CHECK (char_length("name") BETWEEN 1 AND 100);
