-- Notification channel deliveries (epic #481, issue #484).
--
-- One row per (notification, non-inbox channel) delivery attempt — today only
-- Web Push. An audit/diagnostic record, purged nightly by notification_purge
-- after notifications.retentionDays (by created_at).
--
-- Both FKs are ON DELETE SET NULL: the delivery history outlives the inbox row
-- and the user it was about; `type` is denormalized so it stays readable.

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('queued', 'sent', 'failed');

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "notification_id" UUID,
    "user_id" UUID,
    "type" "NotificationType" NOT NULL,
    "channel" TEXT NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL,
    "provider_message_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_deliveries_user_id_type_idx" ON "notification_deliveries"("user_id", "type");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_created_at_idx" ON "notification_deliveries"("status", "created_at");

-- CreateIndex (serves the retention purge)
CREATE INDEX "notification_deliveries_created_at_idx" ON "notification_deliveries"("created_at");

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
