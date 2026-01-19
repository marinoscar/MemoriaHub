-- Migration: 004_add_user_roles
-- Description: Add role column to users table for admin/user separation
-- The first user to register becomes an admin (self-hosted model)

BEGIN;

-- Create enum for user roles
DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('user', 'admin');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Add role column with default 'user'
ALTER TABLE users ADD COLUMN IF NOT EXISTS role user_role NOT NULL DEFAULT 'user';

-- Index for role-based queries
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- Set first user as admin (if exists and no admins yet)
-- This ensures the first registered user becomes admin
UPDATE users
SET role = 'admin'
WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');

-- Record migration
INSERT INTO schema_migrations (version) VALUES ('004_add_user_roles')
ON CONFLICT (version) DO NOTHING;

COMMIT;
