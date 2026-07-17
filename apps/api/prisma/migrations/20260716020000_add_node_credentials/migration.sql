-- Durable, least-privilege worker-node credentials (`nod_` bearer tokens).
-- Mirrors personal_access_tokens minus the duration bookkeeping; expires_at is
-- NULLABLE (NULL = never expires) since worker nodes are long-lived daemons.

-- CreateTable
CREATE TABLE "node_credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,

    CONSTRAINT "node_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "node_credentials_token_hash_key" ON "node_credentials"("token_hash");

-- CreateIndex
CREATE INDEX "node_credentials_user_id_idx" ON "node_credentials"("user_id");

-- AddForeignKey
ALTER TABLE "node_credentials" ADD CONSTRAINT "node_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
