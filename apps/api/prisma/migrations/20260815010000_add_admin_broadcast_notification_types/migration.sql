-- AlterEnum
--
-- Admin broadcast notification types (epic #481, issue #488).
--
-- `ALTER TYPE ... ADD VALUE` cannot run in the same transaction as statements
-- that REFERENCE the new value, so these get their own migration containing
-- nothing else — same precedent as 20260810000000_add_memories_ready_notification_type.
--
--   admin_broadcast          — an ordinary announcement (user-mutable EVENT type)
--   admin_broadcast_critical — a critical one: its inbox row is MANDATORY and
--                              bypasses both the user's preference and the admin
--                              `disabledTypes` kill switch (see notification-channels.ts)
--
-- No index change: both are per-occurrence EVENT types written with emit(), so
-- the partial unique index notifications_review_queue_live_uniq_idx (whose
-- predicate lists only the review_queue_* values) does not apply.
--
-- IF NOT EXISTS keeps a re-applied migration a no-op.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'admin_broadcast';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'admin_broadcast_critical';
