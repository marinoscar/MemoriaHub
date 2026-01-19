-- Migration: 003_cleanup_user_settings
-- Description: Clean up user_settings table to match system_settings approach
--              Remove legacy columns and keep only preferences JSONB column
--              Also remove 'language' from user preferences (not supported in v1)
-- Created: 2025-01-18

BEGIN;

-- =============================================================================
-- Step 1: Ensure all existing data is migrated to preferences JSONB
-- =============================================================================
-- This is a safety check - migration 002 should have already done this,
-- but we handle the case where preferences might be empty/null

UPDATE user_settings
SET preferences = COALESCE(preferences, '{}')::jsonb || jsonb_build_object(
    'notifications', jsonb_build_object(
        'email', jsonb_build_object(
            'enabled', COALESCE((preferences->'notifications'->'email'->>'enabled')::boolean, COALESCE(notifications_email, true)),
            'digest', COALESCE(preferences->'notifications'->'email'->>'digest', 'daily'),
            'newShares', COALESCE((preferences->'notifications'->'email'->>'newShares')::boolean, true),
            'comments', COALESCE((preferences->'notifications'->'email'->>'comments')::boolean, true),
            'albumUpdates', COALESCE((preferences->'notifications'->'email'->>'albumUpdates')::boolean, true),
            'systemAlerts', COALESCE((preferences->'notifications'->'email'->>'systemAlerts')::boolean, true)
        ),
        'push', jsonb_build_object(
            'enabled', COALESCE((preferences->'notifications'->'push'->>'enabled')::boolean, COALESCE(notifications_push, false)),
            'newShares', COALESCE((preferences->'notifications'->'push'->>'newShares')::boolean, true),
            'comments', COALESCE((preferences->'notifications'->'push'->>'comments')::boolean, true),
            'albumUpdates', COALESCE((preferences->'notifications'->'push'->>'albumUpdates')::boolean, true)
        )
    ),
    'ui', jsonb_build_object(
        'theme', COALESCE(preferences->'ui'->>'theme', COALESCE(theme, 'dark')),
        'gridSize', COALESCE(preferences->'ui'->>'gridSize', 'medium'),
        'autoPlayVideos', COALESCE((preferences->'ui'->>'autoPlayVideos')::boolean, true),
        'showMetadata', COALESCE((preferences->'ui'->>'showMetadata')::boolean, true)
    ),
    'privacy', jsonb_build_object(
        'showOnlineStatus', COALESCE((preferences->'privacy'->>'showOnlineStatus')::boolean, true),
        'allowTagging', COALESCE((preferences->'privacy'->>'allowTagging')::boolean, true),
        'defaultAlbumVisibility', COALESCE(preferences->'privacy'->>'defaultAlbumVisibility', 'private')
    )
)
WHERE theme IS NOT NULL OR language IS NOT NULL
   OR notifications_email IS NOT NULL OR notifications_push IS NOT NULL;

-- =============================================================================
-- Step 2: Remove 'language' field from existing preferences (not supported in v1)
-- =============================================================================

UPDATE user_settings
SET preferences = preferences #- '{ui,language}'
WHERE preferences->'ui' ? 'language';

-- =============================================================================
-- Step 3: Drop legacy columns
-- =============================================================================
-- These columns are now replaced by the preferences JSONB column

ALTER TABLE user_settings DROP COLUMN IF EXISTS theme;
ALTER TABLE user_settings DROP COLUMN IF EXISTS language;
ALTER TABLE user_settings DROP COLUMN IF EXISTS notifications_email;
ALTER TABLE user_settings DROP COLUMN IF EXISTS notifications_push;

-- =============================================================================
-- Step 4: Add NOT NULL constraint to preferences with default
-- =============================================================================

ALTER TABLE user_settings
ALTER COLUMN preferences SET DEFAULT '{
    "notifications": {
        "email": {
            "enabled": true,
            "digest": "daily",
            "newShares": true,
            "comments": true,
            "albumUpdates": true,
            "systemAlerts": true
        },
        "push": {
            "enabled": false,
            "newShares": true,
            "comments": true,
            "albumUpdates": true
        }
    },
    "ui": {
        "theme": "dark",
        "gridSize": "medium",
        "autoPlayVideos": true,
        "showMetadata": true
    },
    "privacy": {
        "showOnlineStatus": true,
        "allowTagging": true,
        "defaultAlbumVisibility": "private"
    }
}'::jsonb;

ALTER TABLE user_settings
ALTER COLUMN preferences SET NOT NULL;

-- =============================================================================
-- Migration Record
-- =============================================================================

INSERT INTO schema_migrations (version) VALUES ('003_cleanup_user_settings')
ON CONFLICT (version) DO NOTHING;

COMMIT;
