-- CreateEnum
CREATE TYPE "NodeStatus" AS ENUM ('online', 'draining', 'offline', 'disabled');

-- AlterTable
ALTER TABLE "enrichment_jobs" ADD COLUMN     "claimed_by_node_id" UUID,
ADD COLUMN     "lease_expires_at" TIMESTAMPTZ,
ADD COLUMN     "executor" TEXT;

-- CreateTable
CREATE TABLE "worker_nodes" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "cli_version" TEXT NOT NULL,
    "eligible_types" TEXT[],
    "concurrency" INTEGER NOT NULL DEFAULT 1,
    "status" "NodeStatus" NOT NULL DEFAULT 'online',
    "capabilities" JSONB,
    "registered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_heartbeat_at" TIMESTAMPTZ,
    "created_by_id" UUID NOT NULL,

    CONSTRAINT "worker_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "worker_nodes_status_idx" ON "worker_nodes"("status");

-- CreateIndex
CREATE INDEX "worker_nodes_created_by_id_idx" ON "worker_nodes"("created_by_id");

-- CreateIndex
CREATE INDEX "enrichment_jobs_status_lease_expires_at_idx" ON "enrichment_jobs"("status", "lease_expires_at");

-- AddForeignKey
ALTER TABLE "worker_nodes" ADD CONSTRAINT "worker_nodes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_claimed_by_node_id_fkey" FOREIGN KEY ("claimed_by_node_id") REFERENCES "worker_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
