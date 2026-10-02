-- Android APK releases (issue #504, epic #498): record WHERE each APK was
-- written (provider + bucket) so downloads and deletes resolve the recorded
-- provider, and a release uploaded before an active-provider switch stays
-- downloadable. Same precedent as storage_objects.storage_provider and
-- database_backup_runs.storage_provider. Both nullable: no rows exist before
-- this feature ships, and a null falls back to the active provider.

-- AlterTable
ALTER TABLE "android_app_releases" ADD COLUMN "storage_provider" TEXT,
ADD COLUMN "bucket" TEXT;
