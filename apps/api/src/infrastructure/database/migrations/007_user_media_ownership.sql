-- Migration: 007_user_media_ownership
-- Description: Refactor to user-owned media with many-to-many library relationships
--              - Add owner_id to media_assets (user owns media)
--              - Create library_assets junction table (many-to-many)
--              - Create media_shares table (direct user-to-user sharing)
--              - Remove library_id from media_assets
-- Created: 2024-01-20

BEGIN;

-- =============================================================================
-- Media Shares Table
-- =============================================================================
-- Direct user-to-user sharing of media assets

CREATE TABLE IF NOT EXISTS media_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The media being shared
    asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,

    -- User receiving the share (not the owner)
    shared_with_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- User who created the share (typically the owner)
    shared_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,

    -- Timestamp
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Prevent duplicate shares
    CONSTRAINT unique_media_share UNIQUE (asset_id, shared_with_user_id)
);

-- Indexes for media_shares
CREATE INDEX IF NOT EXISTS idx_media_shares_asset ON media_shares (asset_id);
CREATE INDEX IF NOT EXISTS idx_media_shares_shared_with ON media_shares (shared_with_user_id);
CREATE INDEX IF NOT EXISTS idx_media_shares_shared_by ON media_shares (shared_by_user_id);
CREATE INDEX IF NOT EXISTS idx_media_shares_created_at ON media_shares (created_at);

-- =============================================================================
-- Library Assets Junction Table
-- =============================================================================
-- Many-to-many relationship between libraries and media assets

CREATE TABLE IF NOT EXISTS library_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Junction references
    library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,

    -- Who added this asset to this library
    added_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Prevent duplicate entries
    CONSTRAINT unique_library_asset UNIQUE (library_id, asset_id)
);

-- Indexes for library_assets
CREATE INDEX IF NOT EXISTS idx_library_assets_library ON library_assets (library_id);
CREATE INDEX IF NOT EXISTS idx_library_assets_asset ON library_assets (asset_id);
CREATE INDEX IF NOT EXISTS idx_library_assets_added_by ON library_assets (added_by_user_id);
CREATE INDEX IF NOT EXISTS idx_library_assets_created_at ON library_assets (created_at);

-- =============================================================================
-- Modify Media Assets Table
-- =============================================================================
-- Add owner_id column and remove library_id

-- Step 1: Add owner_id column (initially nullable for safe migration)
ALTER TABLE media_assets
ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Step 2: Drop the old library_id foreign key constraint
ALTER TABLE media_assets
DROP CONSTRAINT IF EXISTS media_assets_library_id_fkey;

-- Step 3: Drop the old library_id index
DROP INDEX IF EXISTS idx_media_assets_library;

-- Step 4: Drop the library_id column
ALTER TABLE media_assets
DROP COLUMN IF EXISTS library_id;

-- Step 5: Make owner_id NOT NULL (safe since we dropped library_id which had existing data)
ALTER TABLE media_assets
ALTER COLUMN owner_id SET NOT NULL;

-- Step 6: Add index for owner_id
CREATE INDEX IF NOT EXISTS idx_media_assets_owner ON media_assets (owner_id);

-- =============================================================================
-- Add Audit Table for Media Share Events
-- =============================================================================
-- Track sharing and unsharing events

CREATE TABLE IF NOT EXISTS audit_media_share_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What changed
    asset_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
    event_type VARCHAR(50) NOT NULL,  -- 'shared', 'unshared'

    -- Who was involved
    shared_with_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    performed_by UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Context
    ip_address INET,
    user_agent TEXT,
    trace_id VARCHAR(64),

    -- Timestamp
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for audit
CREATE INDEX IF NOT EXISTS idx_audit_media_share_asset ON audit_media_share_events (asset_id);
CREATE INDEX IF NOT EXISTS idx_audit_media_share_performed_by ON audit_media_share_events (performed_by);
CREATE INDEX IF NOT EXISTS idx_audit_media_share_created_at ON audit_media_share_events (created_at);

-- =============================================================================
-- Migration Record
-- =============================================================================

INSERT INTO schema_migrations (version) VALUES ('007_user_media_ownership')
ON CONFLICT (version) DO NOTHING;

COMMIT;
