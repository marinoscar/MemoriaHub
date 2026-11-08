-- RETRO-A5 (issue #587): rename every legacy table, enum type, index and
-- constraint that a platform migration (0003 to 0040) would create again.
--
-- Why: the platform history (@marinoscar/platform-db) creates notifications,
-- push_subscriptions, notification_deliveries, notification_broadcasts,
-- job_stats_rollup, worker_nodes, node_credentials, database_backup_runs and
-- android_app_releases, plus the enum types JobStatus, JobReason, NodeStatus,
-- DatabaseBackupStatus, DatabaseBackupTrigger, NotificationBroadcastStatus
-- and NotificationDeliveryStatus, and Postgres index and constraint names are
-- schema-global. Applying those migrations on top of this database would stop
-- with "already exists". Renaming the old objects first lets the platform
-- migrations run on an empty namespace; the old tables keep their rows and
-- are read through @@map("mh_legacy_<table>") until each slice moves its data
-- (RETRO-C1, C2, D3, D4, D5) and drops them.
--
-- Metadata only: no row is rewritten and no column changes. The list below was
-- generated from pg_class / pg_index / pg_constraint of the database after the
-- 81 earlier migrations. This file is final once committed; never edit it
-- (platform.lock records its hash, and comments count).

BEGIN;

-- Tables
ALTER TABLE "notification_deliveries" RENAME TO "mh_legacy_notification_deliveries";
ALTER TABLE "notifications" RENAME TO "mh_legacy_notifications";
ALTER TABLE "push_subscriptions" RENAME TO "mh_legacy_push_subscriptions";
ALTER TABLE "job_stats_rollup" RENAME TO "mh_legacy_job_stats_rollup";
ALTER TABLE "worker_nodes" RENAME TO "mh_legacy_worker_nodes";
ALTER TABLE "node_credentials" RENAME TO "mh_legacy_node_credentials";
ALTER TABLE "database_backup_runs" RENAME TO "mh_legacy_database_backup_runs";
ALTER TABLE "notification_broadcasts" RENAME TO "mh_legacy_notification_broadcasts";
ALTER TABLE "android_app_releases" RENAME TO "mh_legacy_android_app_releases";

-- Enum types
ALTER TYPE "JobStatus" RENAME TO "MhLegacyJobStatus";
ALTER TYPE "JobReason" RENAME TO "MhLegacyJobReason";
ALTER TYPE "NodeStatus" RENAME TO "MhLegacyNodeStatus";
ALTER TYPE "DatabaseBackupStatus" RENAME TO "MhLegacyDatabaseBackupStatus";
ALTER TYPE "DatabaseBackupTrigger" RENAME TO "MhLegacyDatabaseBackupTrigger";
ALTER TYPE "NotificationBroadcastStatus" RENAME TO "MhLegacyNotificationBroadcastStatus";
ALTER TYPE "NotificationDeliveryStatus" RENAME TO "MhLegacyNotificationDeliveryStatus";

-- Constraints of mh_legacy_notification_deliveries (primary, unique and foreign keys, checks; a key's index is renamed with it)
ALTER TABLE "mh_legacy_notification_deliveries" RENAME CONSTRAINT "notification_deliveries_notification_id_fkey" TO "mh_legacy_notification_deliveries_notification_id_fkey";
ALTER TABLE "mh_legacy_notification_deliveries" RENAME CONSTRAINT "notification_deliveries_user_id_fkey" TO "mh_legacy_notification_deliveries_user_id_fkey";
ALTER TABLE "mh_legacy_notification_deliveries" RENAME CONSTRAINT "notification_deliveries_pkey" TO "mh_legacy_notification_deliveries_pkey";
-- Standalone indexes of mh_legacy_notification_deliveries
ALTER INDEX "notification_deliveries_created_at_idx" RENAME TO "mh_legacy_notification_deliveries_created_at_idx";
ALTER INDEX "notification_deliveries_status_created_at_idx" RENAME TO "mh_legacy_notification_deliveries_status_created_at_idx";
ALTER INDEX "notification_deliveries_user_id_type_idx" RENAME TO "mh_legacy_notification_deliveries_user_id_type_idx";

-- Constraints of mh_legacy_notifications (primary, unique and foreign keys, checks; a key's index is renamed with it)
ALTER TABLE "mh_legacy_notifications" RENAME CONSTRAINT "notifications_circle_id_fkey" TO "mh_legacy_notifications_circle_id_fkey";
ALTER TABLE "mh_legacy_notifications" RENAME CONSTRAINT "notifications_user_id_fkey" TO "mh_legacy_notifications_user_id_fkey";
ALTER TABLE "mh_legacy_notifications" RENAME CONSTRAINT "notifications_pkey" TO "mh_legacy_notifications_pkey";
-- Standalone indexes of mh_legacy_notifications
ALTER INDEX "notifications_dismissed_at_updated_at_idx" RENAME TO "mh_legacy_notifications_dismissed_at_updated_at_idx";
ALTER INDEX "notifications_read_at_idx" RENAME TO "mh_legacy_notifications_read_at_idx";
ALTER INDEX "notifications_review_queue_live_uniq_idx" RENAME TO "mh_legacy_notifications_review_queue_live_uniq_idx";
ALTER INDEX "notifications_user_id_created_at_idx" RENAME TO "mh_legacy_notifications_user_id_created_at_idx";
ALTER INDEX "notifications_user_id_dismissed_at_idx" RENAME TO "mh_legacy_notifications_user_id_dismissed_at_idx";
ALTER INDEX "notifications_user_id_read_at_idx" RENAME TO "mh_legacy_notifications_user_id_read_at_idx";

-- Constraints of mh_legacy_push_subscriptions (primary, unique and foreign keys, checks; a key's index is renamed with it)
ALTER TABLE "mh_legacy_push_subscriptions" RENAME CONSTRAINT "push_subscriptions_user_id_fkey" TO "mh_legacy_push_subscriptions_user_id_fkey";
ALTER TABLE "mh_legacy_push_subscriptions" RENAME CONSTRAINT "push_subscriptions_pkey" TO "mh_legacy_push_subscriptions_pkey";
-- Standalone indexes of mh_legacy_push_subscriptions
ALTER INDEX "push_subscriptions_endpoint_key" RENAME TO "mh_legacy_push_subscriptions_endpoint_key";
ALTER INDEX "push_subscriptions_user_id_idx" RENAME TO "mh_legacy_push_subscriptions_user_id_idx";

-- Constraints of mh_legacy_job_stats_rollup (primary, unique and foreign keys, checks; a key's index is renamed with it)
ALTER TABLE "mh_legacy_job_stats_rollup" RENAME CONSTRAINT "job_stats_rollup_pkey" TO "mh_legacy_job_stats_rollup_pkey";
-- Standalone indexes of mh_legacy_job_stats_rollup

-- Constraints of mh_legacy_worker_nodes (primary, unique and foreign keys, checks; a key's index is renamed with it)
ALTER TABLE "mh_legacy_worker_nodes" RENAME CONSTRAINT "worker_nodes_created_by_id_fkey" TO "mh_legacy_worker_nodes_created_by_id_fkey";
ALTER TABLE "mh_legacy_worker_nodes" RENAME CONSTRAINT "worker_nodes_pkey" TO "mh_legacy_worker_nodes_pkey";
-- Standalone indexes of mh_legacy_worker_nodes
ALTER INDEX "worker_nodes_created_by_id_idx" RENAME TO "mh_legacy_worker_nodes_created_by_id_idx";
ALTER INDEX "worker_nodes_created_by_id_name_key" RENAME TO "mh_legacy_worker_nodes_created_by_id_name_key";
ALTER INDEX "worker_nodes_status_idx" RENAME TO "mh_legacy_worker_nodes_status_idx";

-- Constraints of mh_legacy_node_credentials (primary, unique and foreign keys, checks; a key's index is renamed with it)
ALTER TABLE "mh_legacy_node_credentials" RENAME CONSTRAINT "node_credentials_user_id_fkey" TO "mh_legacy_node_credentials_user_id_fkey";
ALTER TABLE "mh_legacy_node_credentials" RENAME CONSTRAINT "node_credentials_pkey" TO "mh_legacy_node_credentials_pkey";
-- Standalone indexes of mh_legacy_node_credentials
ALTER INDEX "node_credentials_token_hash_key" RENAME TO "mh_legacy_node_credentials_token_hash_key";
ALTER INDEX "node_credentials_user_id_idx" RENAME TO "mh_legacy_node_credentials_user_id_idx";

-- Constraints of mh_legacy_database_backup_runs (primary, unique and foreign keys, checks; a key's index is renamed with it)
ALTER TABLE "mh_legacy_database_backup_runs" RENAME CONSTRAINT "database_backup_runs_created_by_id_fkey" TO "mh_legacy_database_backup_runs_created_by_id_fkey";
ALTER TABLE "mh_legacy_database_backup_runs" RENAME CONSTRAINT "database_backup_runs_pre_restore_backup_id_fkey" TO "mh_legacy_database_backup_runs_pre_restore_backup_id_fkey";
ALTER TABLE "mh_legacy_database_backup_runs" RENAME CONSTRAINT "database_backup_runs_restored_by_id_fkey" TO "mh_legacy_database_backup_runs_restored_by_id_fkey";
ALTER TABLE "mh_legacy_database_backup_runs" RENAME CONSTRAINT "database_backup_runs_pkey" TO "mh_legacy_database_backup_runs_pkey";
-- Standalone indexes of mh_legacy_database_backup_runs
ALTER INDEX "database_backup_runs_active_uniq_idx" RENAME TO "mh_legacy_database_backup_runs_active_uniq_idx";
ALTER INDEX "database_backup_runs_started_at_idx" RENAME TO "mh_legacy_database_backup_runs_started_at_idx";
ALTER INDEX "database_backup_runs_status_idx" RENAME TO "mh_legacy_database_backup_runs_status_idx";

-- Constraints of mh_legacy_notification_broadcasts (primary, unique and foreign keys, checks; a key's index is renamed with it)
ALTER TABLE "mh_legacy_notification_broadcasts" RENAME CONSTRAINT "notification_broadcasts_canceled_by_id_fkey" TO "mh_legacy_notification_broadcasts_canceled_by_id_fkey";
ALTER TABLE "mh_legacy_notification_broadcasts" RENAME CONSTRAINT "notification_broadcasts_created_by_id_fkey" TO "mh_legacy_notification_broadcasts_created_by_id_fkey";
ALTER TABLE "mh_legacy_notification_broadcasts" RENAME CONSTRAINT "notification_broadcasts_pkey" TO "mh_legacy_notification_broadcasts_pkey";
-- Standalone indexes of mh_legacy_notification_broadcasts
ALTER INDEX "notification_broadcasts_created_at_idx" RENAME TO "mh_legacy_notification_broadcasts_created_at_idx";
ALTER INDEX "notification_broadcasts_status_scheduled_for_idx" RENAME TO "mh_legacy_notification_broadcasts_status_scheduled_for_idx";

-- Constraints of mh_legacy_android_app_releases (primary, unique and foreign keys, checks; a key's index is renamed with it)
ALTER TABLE "mh_legacy_android_app_releases" RENAME CONSTRAINT "android_app_releases_uploaded_by_id_fkey" TO "mh_legacy_android_app_releases_uploaded_by_id_fkey";
ALTER TABLE "mh_legacy_android_app_releases" RENAME CONSTRAINT "android_app_releases_pkey" TO "mh_legacy_android_app_releases_pkey";
-- Standalone indexes of mh_legacy_android_app_releases
ALTER INDEX "android_app_releases_created_at_idx" RENAME TO "mh_legacy_android_app_releases_created_at_idx";
ALTER INDEX "android_app_releases_one_current_uniq_idx" RENAME TO "mh_legacy_android_app_releases_one_current_uniq_idx";
ALTER INDEX "android_app_releases_package_name_version_code_key" RENAME TO "mh_legacy_android_app_releases_package_name_version_code_key";
ALTER INDEX "android_app_releases_uploaded_by_id_idx" RENAME TO "mh_legacy_android_app_releases_uploaded_by_id_idx";


COMMIT;
