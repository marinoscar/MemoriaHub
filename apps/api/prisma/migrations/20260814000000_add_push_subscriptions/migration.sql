-- Web Push subscriptions (epic #481, issue #483).
--
-- One row per browser PushSubscription. `endpoint` is unique on its own (not
-- per user) so a browser re-subscribing under a different signed-in user moves
-- the row to the new owner instead of forking a duplicate.
--
-- `p256dh` / `auth` are the browser's payload-encryption key and auth secret;
-- they are never returned by any API route.

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "expiration_time" TIMESTAMPTZ,
    "user_agent" TEXT,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "last_success_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");

-- A subscription belongs to exactly one account and must not outlive it.
-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
