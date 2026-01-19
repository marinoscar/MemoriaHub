# Database Governance & Migrations

This document explains how MemoriaHub manages its PostgreSQL database schema, including configuration, migrations, and best practices.

## Table of Contents

- [Overview](#overview)
- [Configuration](#configuration)
  - [Local Development (Docker)](#local-development-docker)
  - [Cloud PostgreSQL](#cloud-postgresql)
  - [Full Control with DATABASE_URL](#full-control-with-database_url)
- [How Migrations Work](#how-migrations-work)
  - [Migration Lifecycle](#migration-lifecycle)
  - [Schema Tracking](#schema-tracking)
- [First-Time Setup](#first-time-setup)
- [Creating New Migrations](#creating-new-migrations)
  - [Naming Convention](#naming-convention)
  - [Migration File Structure](#migration-file-structure)
  - [Best Practices](#best-practices)
- [Running Migrations](#running-migrations)
  - [Automatic (On Startup)](#automatic-on-startup)
  - [Manual Execution](#manual-execution)
- [Rollback Strategy](#rollback-strategy)
- [Troubleshooting](#troubleshooting)

---

## Overview

MemoriaHub uses a file-based migration system that:

1. **Runs automatically on API startup** - No manual intervention required
2. **Is idempotent** - Safe to run multiple times without side effects
3. **Tracks applied migrations** - Never runs the same migration twice
4. **Supports both local and cloud databases** - Same code, different configuration

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   API Startup   │────▶│  Run Migrations  │────▶│  Start Server   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  schema_migrations   │
                    │  ─────────────────   │
                    │  001_create_users ✓  │
                    │  002_create_libs  ✓  │
                    │  003_add_tags     ✓  │
                    └──────────────────────┘
```

---

## Configuration

### Local Development (Docker)

For local development using the Docker PostgreSQL container, use these defaults:

```bash
# .env file
POSTGRES_HOST=           # Empty = local Docker
POSTGRES_PORT=5432
POSTGRES_USER=memoriahub
POSTGRES_PASSWORD=memoriahub_dev
POSTGRES_DB=memoriahub
```

When `POSTGRES_HOST` is empty, `localhost`, `127.0.0.1`, or `postgres` (Docker service name), the system treats it as a local connection with **no SSL**.

Start the local database:

```bash
docker compose -f infra/compose/dev.compose.yml up -d postgres
```

### Cloud PostgreSQL

For cloud-hosted PostgreSQL (AWS RDS, Azure, Google Cloud SQL, Supabase, Neon, etc.):

```bash
# .env file
POSTGRES_HOST=your-db.us-east-1.rds.amazonaws.com
POSTGRES_PORT=5432
POSTGRES_USER=memoriahub
POSTGRES_PASSWORD=your_secure_password
POSTGRES_DB=memoriahub
POSTGRES_SSL=true    # Enabled by default for cloud connections
```

When `POSTGRES_HOST` is set to a non-local hostname:
- **SSL is enabled by default** (`sslmode=require`)
- Password is URL-encoded automatically (safe for special characters)
- Set `POSTGRES_SSL=false` to disable SSL (not recommended)

#### Cloud Provider Examples

| Provider | POSTGRES_HOST Example |
|----------|----------------------|
| AWS RDS | `mydb.abc123.us-east-1.rds.amazonaws.com` |
| Azure | `myserver.postgres.database.azure.com` |
| Google Cloud SQL | `34.123.45.67` (public IP) |
| Supabase | `db.yourproject.supabase.co` |
| Neon | `ep-cool-name-123456.us-east-1.aws.neon.tech` |
| Railway | `containers-us-west-xxx.railway.app` |

### Full Control with DATABASE_URL

For advanced configurations or non-standard setups, use `DATABASE_URL` directly:

```bash
# .env file
DATABASE_URL=postgresql://user:pass@host:5432/dbname?sslmode=require&application_name=memoriahub
```

When `DATABASE_URL` is set, all other `POSTGRES_*` variables are ignored.

---

## How Migrations Work

### Migration Lifecycle

```
1. API starts
2. Migrator checks schema_migrations table
3. Reads .sql files from migrations directory
4. Compares applied vs. available migrations
5. Executes pending migrations in order
6. Records each successful migration
7. Server starts accepting requests
```

### Schema Tracking

The `schema_migrations` table tracks which migrations have been applied:

```sql
CREATE TABLE schema_migrations (
    version VARCHAR(255) PRIMARY KEY,  -- Migration name (e.g., '001_create_users')
    applied_at TIMESTAMPTZ DEFAULT NOW()
);
```

Example contents:

```
 version           | applied_at
-------------------+---------------------------
 001_create_users  | 2024-01-15 10:30:00+00
 002_create_libs   | 2024-01-20 14:22:00+00
```

---

## First-Time Setup

### 1. Configure Your Database

Copy the environment template and configure:

```bash
cd infra/compose
cp .env.example .env
# Edit .env with your database credentials
```

### 2. Start the Database (Local Only)

For local development:

```bash
docker compose -f infra/compose/dev.compose.yml up -d postgres
```

For cloud databases, ensure your IP is whitelisted in the firewall/security group.

### 3. Start the API

```bash
cd apps/api
npm install
npm run dev
```

The API will automatically:
1. Connect to the database
2. Create the `schema_migrations` table
3. Run all pending migrations
4. Start the HTTP server

### 4. Verify the Schema

Check the logs for migration output:

```
[INFO] Initializing application...
[INFO] Starting database migrations
[INFO] Applying migration: 001_create_users
[INFO] Successfully applied migration: 001_create_users
[INFO] Applied 1 migration(s)
[INFO] Server started on 0.0.0.0:3000
```

Or connect to the database and verify:

```sql
-- List all tables
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public';

-- Check applied migrations
SELECT * FROM schema_migrations ORDER BY version;
```

---

## Creating New Migrations

### Naming Convention

Migrations are named with a numeric prefix and descriptive name:

```
NNN_description.sql
```

- **NNN**: Three-digit sequence number (001, 002, 003...)
- **description**: Snake_case description of the change
- **Extension**: Always `.sql`

Examples:
- `001_create_users.sql`
- `002_create_libraries.sql`
- `003_add_media_assets.sql`
- `004_add_user_settings_timezone.sql`

### Migration File Structure

Location: `apps/api/src/infrastructure/database/migrations/`

Template for new migrations:

```sql
-- Migration: NNN_description
-- Description: Brief explanation of what this migration does
-- Created: YYYY-MM-DD

BEGIN;

-- Your SQL changes here
-- Use IF NOT EXISTS, IF EXISTS for idempotency

CREATE TABLE IF NOT EXISTS your_table (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- columns...
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_your_table_column ON your_table (column);

-- Record this migration (already done by migrator, but safe to include)
INSERT INTO schema_migrations (version) VALUES ('NNN_description')
ON CONFLICT (version) DO NOTHING;

COMMIT;
```

### Best Practices

#### 1. Make Migrations Idempotent

Always use `IF NOT EXISTS` / `IF EXISTS` to make migrations safe to run multiple times:

```sql
-- Good: Idempotent
CREATE TABLE IF NOT EXISTS users (...);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
DROP INDEX IF EXISTS old_index_name;

-- Bad: Will fail on second run
CREATE TABLE users (...);
CREATE INDEX idx_users_email ON users (email);
```

#### 2. Wrap in Transactions

Use `BEGIN` and `COMMIT` to ensure atomicity:

```sql
BEGIN;

-- All changes happen together or not at all
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone);

COMMIT;
```

#### 3. Handle Enums Carefully

PostgreSQL enums require special handling:

```sql
-- Add value to existing enum (PostgreSQL 9.1+)
ALTER TYPE oauth_provider ADD VALUE IF NOT EXISTS 'apple';

-- Create enum only if it doesn't exist
DO $$ BEGIN
    CREATE TYPE status_type AS ENUM ('pending', 'active', 'archived');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
```

#### 4. Add Columns with Defaults

When adding columns to existing tables with data:

```sql
-- Good: Add with default, no table lock
ALTER TABLE users
ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- For NOT NULL columns, add in two steps:
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';
-- Later migration can add NOT NULL if needed
```

#### 5. Document the Migration

Include a header comment explaining:
- What the migration does
- Why it's needed
- Any special considerations

```sql
-- Migration: 005_add_media_metadata
-- Description: Add JSONB column for storing extracted EXIF/metadata
-- Created: 2024-02-01
--
-- This supports the new media processing pipeline that extracts
-- camera info, GPS coordinates, and other metadata from uploads.
-- The JSONB type allows flexible schema for different media types.
```

#### 6. One Logical Change Per Migration

Keep migrations focused:

```
# Good: Focused migrations
003_create_libraries.sql
004_create_library_members.sql
005_add_library_visibility.sql

# Bad: Too much in one migration
003_create_libraries_members_permissions_sharing.sql
```

---

## Running Migrations

### Automatic (On Startup)

Migrations run automatically when the API starts. No manual intervention required.

```bash
# Start the API - migrations run automatically
cd apps/api && npm run dev
```

Startup logs:
```
[INFO] Initializing application...
[INFO] Starting database migrations
[INFO] Database schema is up to date  # or lists applied migrations
[INFO] Server started on 0.0.0.0:3000
```

### Manual Execution

For troubleshooting or running migrations without starting the server, connect directly to PostgreSQL:

```bash
# Using Docker
docker compose -f infra/compose/dev.compose.yml exec postgres \
  psql -U memoriahub -d memoriahub -f /path/to/migration.sql

# Using psql directly
psql -h localhost -U memoriahub -d memoriahub -f apps/api/src/infrastructure/database/migrations/001_create_users.sql
```

---

## Rollback Strategy

MemoriaHub uses **forward-only migrations**. Instead of rollback scripts, we:

1. **Create corrective migrations** to fix issues
2. **Use feature flags** for gradual rollouts
3. **Maintain backward compatibility** during transitions

### Example: Fixing a Mistake

If migration `005_add_wrong_column.sql` added a column incorrectly:

```sql
-- 006_fix_wrong_column.sql
BEGIN;

-- Remove the incorrect column
ALTER TABLE users DROP COLUMN IF EXISTS wrong_column;

-- Add the correct column
ALTER TABLE users ADD COLUMN IF NOT EXISTS correct_column VARCHAR(100);

COMMIT;
```

### Example: Renaming a Column

```sql
-- 007_rename_user_name_to_display_name.sql
BEGIN;

-- Add new column
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);

-- Copy data (only if old column exists and new column is empty)
UPDATE users SET display_name = user_name
WHERE display_name IS NULL AND user_name IS NOT NULL;

-- Note: Drop old column in a future migration after code is updated
-- ALTER TABLE users DROP COLUMN IF EXISTS user_name;

COMMIT;
```

---

## Troubleshooting

### Connection Refused

**Symptom**: `Error: connect ECONNREFUSED 127.0.0.1:5432`

**Cause**: PostgreSQL is not running or not accessible.

**Fix**:
```bash
# Check if PostgreSQL is running
docker compose -f infra/compose/dev.compose.yml ps

# Start PostgreSQL
docker compose -f infra/compose/dev.compose.yml up -d postgres

# Check logs
docker compose -f infra/compose/dev.compose.yml logs postgres
```

### Authentication Failed

**Symptom**: `Error: password authentication failed for user "memoriahub"`

**Cause**: Incorrect credentials or user doesn't exist.

**Fix**: Verify `.env` credentials match the database setup:
```bash
# Check current environment
cat infra/compose/.env | grep POSTGRES

# For Docker, reset the database
docker compose -f infra/compose/dev.compose.yml down -v
docker compose -f infra/compose/dev.compose.yml up -d postgres
```

### SSL Required

**Symptom**: `Error: SSL connection is required`

**Cause**: Cloud database requires SSL but it's disabled.

**Fix**: Ensure `POSTGRES_SSL=true` in `.env` (default for cloud connections).

### Migration Failed

**Symptom**: `Failed to apply migration: 003_create_libraries`

**Cause**: SQL error in the migration file.

**Fix**:
1. Check the error message for details
2. Fix the SQL in the migration file
3. If partially applied, manually clean up
4. Restart the API

```bash
# Connect to database and check state
docker compose -f infra/compose/dev.compose.yml exec postgres \
  psql -U memoriahub -d memoriahub

# Check what's in schema_migrations
SELECT * FROM schema_migrations;

# If needed, remove failed migration record to retry
DELETE FROM schema_migrations WHERE version = '003_create_libraries';
```

### Duplicate Migration

**Symptom**: Migration runs successfully but shows as already applied.

**Cause**: Migration was manually run or the file was renamed.

**Fix**: Check `schema_migrations` and update if needed:
```sql
-- View applied migrations
SELECT * FROM schema_migrations ORDER BY applied_at;

-- Remove duplicate if needed
DELETE FROM schema_migrations WHERE version = 'old_name';
```

---

## Settings Schema

MemoriaHub uses a flexible settings architecture with two types of settings:

### System Settings (Admin)

System-wide configuration stored by category with JSONB flexibility:

```sql
CREATE TABLE system_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category VARCHAR(50) NOT NULL UNIQUE,  -- 'smtp', 'push', 'features', 'general'
    settings JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by UUID REFERENCES users(id)
);
```

**Categories:**
- `smtp` - Email server configuration (host, port, credentials)
- `push` - Push notification settings (provider, keys)
- `features` - Feature flags (aiSearch, faceRecognition, webdavSync, etc.)
- `general` - Site name, description, upload limits

### User Preferences

Per-user settings with JSONB for flexibility (same approach as system_settings):

```sql
CREATE TABLE user_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    preferences JSONB NOT NULL DEFAULT '{...}',  -- Full default preferences JSON
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Preference Categories:**
- `notifications.email` - Email notification preferences (enabled, digest, newShares, comments, etc.)
- `notifications.push` - Push notification preferences (enabled, newShares, comments, etc.)
- `ui` - Theme, grid size, autoPlayVideos, showMetadata
- `privacy` - Album visibility, tagging preferences, online status

### Settings Audit Trail

All settings changes are tracked for security:

```sql
CREATE TABLE audit_settings_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    settings_type VARCHAR(20) NOT NULL,  -- 'system' or 'user'
    category VARCHAR(50),
    user_id UUID,
    action VARCHAR(20) NOT NULL,
    previous_value JSONB,
    new_value JSONB,
    changed_fields TEXT[],
    changed_by UUID,
    ip_address INET,
    trace_id VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## File Reference

| File | Purpose |
|------|---------|
| `apps/api/src/config/database.config.ts` | Database configuration and connection string builder |
| `apps/api/src/infrastructure/database/client.ts` | PostgreSQL connection pool and query utilities |
| `apps/api/src/infrastructure/database/migrator.ts` | Migration runner logic |
| `apps/api/src/infrastructure/database/migrations/*.sql` | Individual migration files |
| `apps/api/src/infrastructure/database/repositories/` | Repository implementations |
| `apps/api/src/index.ts` | Application bootstrap (calls `runMigrations()`) |
| `infra/compose/.env.example` | Environment variable template |

---

## Quick Reference

```bash
# Start local PostgreSQL
docker compose -f infra/compose/dev.compose.yml up -d postgres

# Start API (runs migrations automatically)
cd apps/api && npm run dev

# Connect to local database
docker compose -f infra/compose/dev.compose.yml exec postgres psql -U memoriahub

# View migration status
SELECT version, applied_at FROM schema_migrations ORDER BY version;

# Reset local database (WARNING: destroys data)
docker compose -f infra/compose/dev.compose.yml down -v
docker compose -f infra/compose/dev.compose.yml up -d postgres
```
