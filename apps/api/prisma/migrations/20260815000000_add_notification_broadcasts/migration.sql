-- Admin notification broadcasts (epic #481, issue #488).
--
-- One row per announcement an administrator composes. The row doubles as the
-- fan-out's durable state: `broadcast_start` claims it (scheduled -> sending,
-- stamping audience_cutoff), `broadcast_chunk` enrichment jobs page the
-- audience by user id and commit cursor_user_id / processed_count with a
-- compare-and-swap after every page, and the last chunk flips it to `sent`.
--
-- Both user FKs are ON DELETE SET NULL: the record of an announcement outlives
-- the administrator who wrote or cancelled it.
--
-- The two NotificationType values the fan-out writes (admin_broadcast,
-- admin_broadcast_critical) are added in the NEXT migration on their own —
-- ALTER TYPE ... ADD VALUE cannot share a transaction with statements that
-- reference the new value (precedent: 20260810000000_add_memories_ready_...).

-- CreateEnum
CREATE TYPE "NotificationBroadcastStatus" AS ENUM ('draft', 'scheduled', 'sending', 'sent', 'canceled', 'failed');

-- CreateTable
CREATE TABLE "notification_broadcasts" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "cta_label" TEXT,
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "channels" TEXT[],
    "status" "NotificationBroadcastStatus" NOT NULL DEFAULT 'scheduled',
    "scheduled_for" TIMESTAMPTZ,
    "audience_cutoff" TIMESTAMPTZ,
    "recipient_count" INTEGER,
    "cursor_user_id" UUID,
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_by_id" UUID,
    "canceled_by_id" UUID,
    "canceled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (due-scheduled lookups / status filter)
CREATE INDEX "notification_broadcasts_status_scheduled_for_idx" ON "notification_broadcasts"("status", "scheduled_for");

-- CreateIndex (admin list, newest first)
CREATE INDEX "notification_broadcasts_created_at_idx" ON "notification_broadcasts"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "notification_broadcasts" ADD CONSTRAINT "notification_broadcasts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_broadcasts" ADD CONSTRAINT "notification_broadcasts_canceled_by_id_fkey" FOREIGN KEY ("canceled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
