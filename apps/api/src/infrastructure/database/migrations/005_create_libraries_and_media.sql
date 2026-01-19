-- Migration: 005_create_libraries_and_media
-- Description: Create tables for libraries, media assets, ingestion events, and processing jobs
-- Created: 2024-01-20

BEGIN;

-- =============================================================================
-- Enums
-- =============================================================================

-- Library visibility enum
DO $$ BEGIN
    CREATE TYPE library_visibility AS ENUM ('private', 'shared', 'public');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Media asset status lifecycle enum
DO $$ BEGIN
    CREATE TYPE media_asset_status AS ENUM (
        'UPLOADED',
        'METADATA_EXTRACTED',
        'DERIVATIVES_READY',
        'ENRICHED',
        'INDEXED',
        'READY',
        'ERROR'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Media type enum
DO $$ BEGIN
    CREATE TYPE media_type AS ENUM ('image', 'video');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- Libraries Table
-- =============================================================================
-- Organizes media assets into collections owned by users

CREATE TABLE IF NOT EXISTS libraries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Owner
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Library info
    name VARCHAR(255) NOT NULL,
    description TEXT,
    visibility library_visibility NOT NULL DEFAULT 'private',

    -- Cover image (set after first asset is uploaded)
    cover_asset_id UUID,  -- FK added later to avoid circular reference

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT unique_library_name_per_user UNIQUE (owner_id, name)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_libraries_owner ON libraries (owner_id);
CREATE INDEX IF NOT EXISTS idx_libraries_visibility ON libraries (visibility);
CREATE INDEX IF NOT EXISTS idx_libraries_created_at ON libraries (created_at);

-- Updated at trigger
DROP TRIGGER IF EXISTS update_libraries_updated_at ON libraries;
CREATE TRIGGER update_libraries_updated_at
    BEFORE UPDATE ON libraries
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- Library Members Table
-- =============================================================================
-- Tracks membership for shared libraries

CREATE TABLE IF NOT EXISTS library_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- References
    library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Role: viewer (read-only), contributor (can upload), admin (can manage)
    role VARCHAR(20) NOT NULL DEFAULT 'viewer',

    -- Who invited this member
    invited_by UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Timestamp
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT unique_library_member UNIQUE (library_id, user_id),
    CONSTRAINT valid_member_role CHECK (role IN ('viewer', 'contributor', 'admin'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_library_members_library ON library_members (library_id);
CREATE INDEX IF NOT EXISTS idx_library_members_user ON library_members (user_id);

-- =============================================================================
-- Media Assets Table
-- =============================================================================
-- Stores metadata for all uploaded media (photos and videos)

CREATE TABLE IF NOT EXISTS media_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Parent library
    library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,

    -- Storage info
    storage_key VARCHAR(1024) NOT NULL,          -- S3 key for original file
    storage_bucket VARCHAR(255) NOT NULL,        -- S3 bucket name
    thumbnail_key VARCHAR(1024),                 -- S3 key for thumbnail
    preview_key VARCHAR(1024),                   -- S3 key for preview/web size

    -- File info (searchable columns)
    original_filename VARCHAR(512) NOT NULL,     -- Original file name at upload
    media_type media_type NOT NULL,              -- 'image' | 'video'
    mime_type VARCHAR(100) NOT NULL,             -- e.g., 'image/jpeg'
    file_size BIGINT NOT NULL,                   -- Size in bytes
    file_source VARCHAR(50) NOT NULL,            -- 'web' | 'webdav' | 'api'

    -- Dimensions
    width INTEGER,                               -- Pixel width
    height INTEGER,                              -- Pixel height
    duration_seconds NUMERIC(10, 3),             -- For videos only

    -- Camera info (searchable columns from EXIF)
    camera_make VARCHAR(100),                    -- e.g., "Apple", "Canon", "Sony"
    camera_model VARCHAR(100),                   -- e.g., "iPhone 15 Pro", "EOS R5"

    -- Location (searchable columns)
    latitude NUMERIC(10, 7),                     -- GPS latitude
    longitude NUMERIC(10, 7),                    -- GPS longitude
    country VARCHAR(100),                        -- Country name
    state VARCHAR(100),                          -- State/province/region
    city VARCHAR(100),                           -- City name
    location_name VARCHAR(255),                  -- Full address or place name

    -- Time (searchable columns from EXIF)
    captured_at_utc TIMESTAMP WITH TIME ZONE,   -- UTC time from EXIF DateTimeOriginal
    timezone_offset INTEGER,                     -- Offset in minutes from UTC

    -- Full EXIF data (JSONB for flexibility and additional fields)
    exif_data JSONB DEFAULT '{}',

    -- AI enrichment data (for future use)
    faces JSONB DEFAULT '[]',                    -- Detected faces and embeddings
    tags JSONB DEFAULT '[]',                     -- Object/scene labels

    -- Processing status
    status media_asset_status NOT NULL DEFAULT 'UPLOADED',
    error_message TEXT,                          -- Error details if status is ERROR

    -- Tracing (for end-to-end observability)
    trace_id VARCHAR(64),

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for search optimization
CREATE INDEX IF NOT EXISTS idx_media_assets_library ON media_assets (library_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_status ON media_assets (status);
CREATE INDEX IF NOT EXISTS idx_media_assets_captured_at ON media_assets (captured_at_utc);
CREATE INDEX IF NOT EXISTS idx_media_assets_country ON media_assets (country);
CREATE INDEX IF NOT EXISTS idx_media_assets_state ON media_assets (state);
CREATE INDEX IF NOT EXISTS idx_media_assets_city ON media_assets (city);
CREATE INDEX IF NOT EXISTS idx_media_assets_camera_make ON media_assets (camera_make);
CREATE INDEX IF NOT EXISTS idx_media_assets_camera_model ON media_assets (camera_model);
CREATE INDEX IF NOT EXISTS idx_media_assets_media_type ON media_assets (media_type);
CREATE INDEX IF NOT EXISTS idx_media_assets_location ON media_assets (latitude, longitude) WHERE latitude IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_assets_filename ON media_assets (original_filename);
CREATE INDEX IF NOT EXISTS idx_media_assets_trace_id ON media_assets (trace_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_created_at ON media_assets (created_at);

-- GIN index for JSONB queries on exif_data
CREATE INDEX IF NOT EXISTS idx_media_assets_exif ON media_assets USING GIN (exif_data);

-- GIN index for JSONB queries on tags (for future search)
CREATE INDEX IF NOT EXISTS idx_media_assets_tags ON media_assets USING GIN (tags);

-- Updated at trigger
DROP TRIGGER IF EXISTS update_media_assets_updated_at ON media_assets;
CREATE TRIGGER update_media_assets_updated_at
    BEFORE UPDATE ON media_assets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- Add FK for library cover_asset_id (deferred to avoid circular reference)
-- =============================================================================

ALTER TABLE libraries DROP CONSTRAINT IF EXISTS fk_cover_asset;
ALTER TABLE libraries ADD CONSTRAINT fk_cover_asset
    FOREIGN KEY (cover_asset_id) REFERENCES media_assets(id) ON DELETE SET NULL;

-- =============================================================================
-- Ingestion Events Table
-- =============================================================================
-- Tracks upload/ingestion events for observability

CREATE TABLE IF NOT EXISTS ingestion_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Reference to asset
    asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,

    -- Upload context
    source VARCHAR(50) NOT NULL,                 -- 'web' | 'webdav' | 'api'
    client_info JSONB DEFAULT '{}',              -- User agent, IP, etc.

    -- Tracing
    trace_id VARCHAR(64) NOT NULL,

    -- Status tracking
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- 'pending' | 'completed' | 'failed'
    error_message TEXT,

    -- Constraints
    CONSTRAINT valid_ingestion_status CHECK (status IN ('pending', 'completed', 'failed'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ingestion_events_asset ON ingestion_events (asset_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_events_trace_id ON ingestion_events (trace_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_events_status ON ingestion_events (status);
CREATE INDEX IF NOT EXISTS idx_ingestion_events_started_at ON ingestion_events (started_at);

-- =============================================================================
-- Processing Jobs Table
-- =============================================================================
-- Queue for background processing tasks (metadata extraction, thumbnails, AI enrichment)

CREATE TABLE IF NOT EXISTS processing_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Reference to asset
    asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,

    -- Job details
    job_type VARCHAR(50) NOT NULL,               -- Job type identifier
    priority INTEGER NOT NULL DEFAULT 0,         -- Higher = more urgent
    payload JSONB DEFAULT '{}',                  -- Job-specific parameters

    -- Status tracking
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    last_error TEXT,

    -- Tracing
    trace_id VARCHAR(64),

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    next_retry_at TIMESTAMP WITH TIME ZONE,

    -- Constraints
    CONSTRAINT valid_job_status CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
    CONSTRAINT valid_job_type CHECK (job_type IN (
        'extract_metadata',
        'generate_thumbnail',
        'generate_preview',
        'reverse_geocode',
        'detect_faces',
        'detect_objects',
        'index_search'
    ))
);

-- Indexes for job queue queries
CREATE INDEX IF NOT EXISTS idx_processing_jobs_asset ON processing_jobs (asset_id);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_status_priority ON processing_jobs (status, priority DESC, created_at)
    WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_processing_jobs_retry ON processing_jobs (next_retry_at)
    WHERE status = 'pending' AND next_retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_processing_jobs_trace_id ON processing_jobs (trace_id);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_type ON processing_jobs (job_type);

-- =============================================================================
-- Audit Table for Library Changes
-- =============================================================================
-- Track library visibility changes and membership modifications

CREATE TABLE IF NOT EXISTS audit_library_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What changed
    library_id UUID REFERENCES libraries(id) ON DELETE SET NULL,
    event_type VARCHAR(50) NOT NULL,             -- 'created', 'updated', 'deleted', 'member_added', 'member_removed', 'visibility_changed'

    -- Change details
    previous_value JSONB,
    new_value JSONB,

    -- Actor
    performed_by UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Context
    ip_address INET,
    user_agent TEXT,
    trace_id VARCHAR(64),

    -- Timestamp
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_audit_library_events_library ON audit_library_events (library_id);
CREATE INDEX IF NOT EXISTS idx_audit_library_events_type ON audit_library_events (event_type);
CREATE INDEX IF NOT EXISTS idx_audit_library_events_performed_by ON audit_library_events (performed_by);
CREATE INDEX IF NOT EXISTS idx_audit_library_events_created_at ON audit_library_events (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_library_events_trace_id ON audit_library_events (trace_id);

-- =============================================================================
-- Migration Record
-- =============================================================================

INSERT INTO schema_migrations (version) VALUES ('005_create_libraries_and_media')
ON CONFLICT (version) DO NOTHING;

COMMIT;
