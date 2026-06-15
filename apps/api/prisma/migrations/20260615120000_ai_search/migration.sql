-- AI Search migration: add ai_provider_credentials, search_conversations,
-- and search_messages tables.
--
-- ai_provider_credentials stores AES-256-GCM encrypted API keys for AI
-- providers (e.g. openai, anthropic). The encrypted_key column is ciphertext
-- only and MUST never be exposed via the API; last4 is the only visible hint.
-- provider is kept as plain TEXT (not an enum) so new providers can be added
-- without a schema migration.
--
-- search_conversations is scoped to a circle and a user. provider/model are
-- snapshotted at creation so the conversation replay is self-contained even if
-- the credential is rotated later. favorite/archivedAt/deletedAt support the
-- full conversation lifecycle (soft delete + archive).
--
-- search_messages stores individual turns in a conversation. toolCalls holds
-- the raw assistant tool-call JSON; toolResults holds the resolved filter
-- parameters and returned item IDs so a turn can be replayed deterministically.

-- -----------------------------------------------------------------------------
-- Table: ai_provider_credentials
-- -----------------------------------------------------------------------------

CREATE TABLE "ai_provider_credentials" (
    "id"                  UUID        NOT NULL DEFAULT gen_random_uuid(),
    "provider"            TEXT        NOT NULL,
    "encrypted_key"       TEXT        NOT NULL,
    "base_url"            TEXT,
    "last4"               TEXT        NOT NULL,
    "enabled"             BOOLEAN     NOT NULL DEFAULT true,
    "updated_by_user_id"  UUID,
    "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "ai_provider_credentials_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_provider_credentials_provider_key" UNIQUE ("provider"),
    CONSTRAINT "ai_provider_credentials_updated_by_user_id_fkey"
        FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

-- -----------------------------------------------------------------------------
-- Table: search_conversations
-- -----------------------------------------------------------------------------

CREATE TABLE "search_conversations" (
    "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
    "circle_id"   UUID        NOT NULL,
    "user_id"     UUID        NOT NULL,
    "title"       TEXT,
    "provider"    TEXT        NOT NULL,
    "model"       TEXT        NOT NULL,
    "favorite"    BOOLEAN     NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ,
    "deleted_at"  TIMESTAMPTZ,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "search_conversations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "search_conversations_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "search_conversations_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE INDEX "search_conversations_circle_id_idx"  ON "search_conversations" ("circle_id");
CREATE INDEX "search_conversations_user_id_idx"    ON "search_conversations" ("user_id");
CREATE INDEX "search_conversations_archived_at_idx" ON "search_conversations" ("archived_at");
CREATE INDEX "search_conversations_favorite_idx"   ON "search_conversations" ("favorite");
CREATE INDEX "search_conversations_deleted_at_idx" ON "search_conversations" ("deleted_at");

-- -----------------------------------------------------------------------------
-- Table: search_messages
-- -----------------------------------------------------------------------------

CREATE TABLE "search_messages" (
    "id"              UUID        NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID        NOT NULL,
    "role"            TEXT        NOT NULL,
    "content"         TEXT        NOT NULL,
    "tool_calls"      JSONB,
    "tool_results"    JSONB,
    "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "search_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "search_messages_conversation_id_fkey"
        FOREIGN KEY ("conversation_id") REFERENCES "search_conversations"("id") ON DELETE CASCADE
);

CREATE INDEX "search_messages_conversation_id_idx" ON "search_messages" ("conversation_id");
