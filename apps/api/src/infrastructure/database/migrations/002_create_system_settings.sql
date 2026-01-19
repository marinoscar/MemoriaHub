-- Migration: 002_create_system_settings
-- Description: Create system_settings table for app-wide configuration (SMTP, push notifications, feature flags)
--              and enhance user_preferences with JSONB for flexibility
-- Created: 2024-01-15

BEGIN;

-- =============================================================================
-- System Settings Table
-- =============================================================================
-- Stores app-wide configuration organized by category (smtp, push, features, etc.)
-- Each category has a single row with JSONB settings

CREATE TABLE IF NOT EXISTS system_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Category identifier (unique per setting type)
    category VARCHAR(50) NOT NULL UNIQUE,

    -- Settings stored as JSONB for flexibility
    -- Schema is enforced at application layer via Zod
    settings JSONB NOT NULL DEFAULT '{}',

    -- Audit fields
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Constraints
    CONSTRAINT valid_category CHECK (category IN ('smtp', 'push', 'storage', 'features', 'general'))
);

-- Index for category lookups (though UNIQUE already provides this)
CREATE INDEX IF NOT EXISTS idx_system_settings_category ON system_settings (category);

-- Updated at trigger
DROP TRIGGER IF EXISTS update_system_settings_updated_at ON system_settings;
CREATE TRIGGER update_system_settings_updated_at
    BEFORE UPDATE ON system_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- User Preferences Table Enhancement
-- =============================================================================
-- Replace the rigid user_settings columns with flexible JSONB
-- This allows adding new preference categories without migrations

-- First, check if we need to migrate from old structure
DO $$
BEGIN
    -- Check if preferences column exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user_settings' AND column_name = 'preferences'
    ) THEN
        -- Add new JSONB column
        ALTER TABLE user_settings ADD COLUMN preferences JSONB DEFAULT '{}';

        -- Migrate existing data to new format
        UPDATE user_settings SET preferences = jsonb_build_object(
            'notifications', jsonb_build_object(
                'email', jsonb_build_object(
                    'enabled', COALESCE(notifications_email, true),
                    'digest', 'daily',
                    'newShares', true,
                    'comments', true
                ),
                'push', jsonb_build_object(
                    'enabled', COALESCE(notifications_push, false),
                    'newShares', true,
                    'comments', true
                )
            ),
            'ui', jsonb_build_object(
                'theme', COALESCE(theme, 'dark'),
                'language', COALESCE(language, 'en'),
                'gridSize', 'medium'
            )
        );

        -- Drop old columns (keep for now, can be dropped in future migration)
        -- ALTER TABLE user_settings DROP COLUMN IF EXISTS theme;
        -- ALTER TABLE user_settings DROP COLUMN IF EXISTS language;
        -- ALTER TABLE user_settings DROP COLUMN IF EXISTS notifications_email;
        -- ALTER TABLE user_settings DROP COLUMN IF EXISTS notifications_push;
    END IF;
END $$;

-- Index for JSONB queries on notifications preferences
CREATE INDEX IF NOT EXISTS idx_user_settings_notifications
    ON user_settings USING GIN ((preferences->'notifications'));

-- Index for JSONB queries on UI preferences
CREATE INDEX IF NOT EXISTS idx_user_settings_ui
    ON user_settings USING GIN ((preferences->'ui'));

-- =============================================================================
-- Audit Table for Settings Changes
-- =============================================================================
-- Track all changes to system settings for security and debugging

CREATE TABLE IF NOT EXISTS audit_settings_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What changed
    settings_type VARCHAR(20) NOT NULL,  -- 'system' or 'user'
    category VARCHAR(50),                 -- For system settings
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- For user prefs or who made change

    -- Change details
    action VARCHAR(20) NOT NULL,         -- 'create', 'update', 'delete'
    previous_value JSONB,                -- Old settings (null for create)
    new_value JSONB,                     -- New settings (null for delete)
    changed_fields TEXT[],               -- List of fields that changed

    -- Audit context
    changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    ip_address INET,
    user_agent TEXT,
    trace_id VARCHAR(64),

    -- Timestamp
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for audit queries
CREATE INDEX IF NOT EXISTS idx_audit_settings_type ON audit_settings_changes (settings_type);
CREATE INDEX IF NOT EXISTS idx_audit_settings_category ON audit_settings_changes (category);
CREATE INDEX IF NOT EXISTS idx_audit_settings_user_id ON audit_settings_changes (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_settings_changed_by ON audit_settings_changes (changed_by);
CREATE INDEX IF NOT EXISTS idx_audit_settings_created_at ON audit_settings_changes (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_settings_trace_id ON audit_settings_changes (trace_id);

-- =============================================================================
-- Default System Settings
-- =============================================================================
-- Insert default values for each category

INSERT INTO system_settings (category, settings) VALUES
    ('smtp', '{
        "enabled": false,
        "host": "",
        "port": 587,
        "secure": true,
        "username": "",
        "password": "",
        "fromAddress": "",
        "fromName": "MemoriaHub"
    }'),
    ('push', '{
        "enabled": false,
        "provider": null,
        "vapidPublicKey": "",
        "vapidPrivateKey": ""
    }'),
    ('features', '{
        "aiSearch": false,
        "faceRecognition": false,
        "webdavSync": true,
        "publicSharing": true,
        "guestUploads": false
    }'),
    ('general', '{
        "siteName": "MemoriaHub",
        "siteDescription": "Your family photo memories, secured.",
        "allowRegistration": true,
        "requireEmailVerification": false,
        "maxUploadSizeMB": 100,
        "supportedFormats": ["jpg", "jpeg", "png", "gif", "webp", "heic", "mp4", "mov", "avi"]
    }')
ON CONFLICT (category) DO NOTHING;

-- =============================================================================
-- Migration Record
-- =============================================================================

INSERT INTO schema_migrations (version) VALUES ('002_create_system_settings')
ON CONFLICT (version) DO NOTHING;

COMMIT;
