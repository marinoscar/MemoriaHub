-- Migration: 001_create_users
-- Description: Create users table for OAuth authentication
-- Created: 2024-01-01

BEGIN;

-- Create enum for OAuth providers
DO $$ BEGIN
    CREATE TYPE oauth_provider AS ENUM ('google', 'microsoft', 'github');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- OAuth identity
    oauth_provider oauth_provider NOT NULL,
    oauth_subject VARCHAR(255) NOT NULL,  -- Provider's unique user ID

    -- Profile information (from OAuth)
    email VARCHAR(255) NOT NULL,
    email_verified BOOLEAN DEFAULT false,
    display_name VARCHAR(255),
    avatar_url TEXT,

    -- Refresh token for offline access (hashed)
    refresh_token_hash VARCHAR(255),

    -- Account status
    is_active BOOLEAN DEFAULT true,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_login_at TIMESTAMP WITH TIME ZONE,

    -- Constraints
    CONSTRAINT unique_oauth_identity UNIQUE (oauth_provider, oauth_subject),
    CONSTRAINT unique_email_per_provider UNIQUE (oauth_provider, email)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_oauth_provider ON users (oauth_provider);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users (is_active) WHERE is_active = true;

-- Updated at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Drop trigger if exists and recreate
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Audit table for login events (append-only for security)
CREATE TABLE IF NOT EXISTS audit_login_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type VARCHAR(50) NOT NULL,  -- 'login', 'logout', 'token_refresh', 'login_failed'
    oauth_provider oauth_provider,
    ip_address INET,
    user_agent TEXT,
    trace_id VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Indexes for audit queries
CREATE INDEX IF NOT EXISTS idx_audit_login_user_id ON audit_login_events (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_login_created_at ON audit_login_events (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_login_trace_id ON audit_login_events (trace_id);
CREATE INDEX IF NOT EXISTS idx_audit_login_event_type ON audit_login_events (event_type);

-- User settings table (for theme preferences, etc.)
CREATE TABLE IF NOT EXISTS user_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme VARCHAR(20) DEFAULT 'dark',
    language VARCHAR(10) DEFAULT 'en',
    notifications_email BOOLEAN DEFAULT true,
    notifications_push BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Updated at trigger for settings
DROP TRIGGER IF EXISTS update_user_settings_updated_at ON user_settings;
CREATE TRIGGER update_user_settings_updated_at
    BEFORE UPDATE ON user_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Migrations tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Record this migration
INSERT INTO schema_migrations (version) VALUES ('001_create_users')
ON CONFLICT (version) DO NOTHING;

COMMIT;
