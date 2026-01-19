-- Migration: 006_add_job_queue_support
-- Description: Add queue, worker_id, and result columns to processing_jobs for worker service
-- Created: 2024-01-20

BEGIN;

-- =============================================================================
-- Add queue column for job routing
-- =============================================================================
-- Queue allows routing jobs to specialized workers:
-- - 'default': Standard jobs (images < 100MB)
-- - 'large_files': Large file processing (> 100MB)
-- - 'priority': High-priority jobs (user-initiated re-processing)
-- - 'ai': AI/ML processing jobs (face detection, object detection)

ALTER TABLE processing_jobs
ADD COLUMN IF NOT EXISTS queue VARCHAR(50) NOT NULL DEFAULT 'default';

-- =============================================================================
-- Add worker_id to track which worker is processing
-- =============================================================================
-- Enables identifying stuck jobs and graceful shutdown handling

ALTER TABLE processing_jobs
ADD COLUMN IF NOT EXISTS worker_id VARCHAR(100);

-- =============================================================================
-- Add result column for job output
-- =============================================================================
-- Stores processing results (output keys, sizes, timing, etc.)

ALTER TABLE processing_jobs
ADD COLUMN IF NOT EXISTS result JSONB;

-- =============================================================================
-- Add constraint for valid queue values
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_processing_jobs_queue'
    ) THEN
        ALTER TABLE processing_jobs
        ADD CONSTRAINT chk_processing_jobs_queue
        CHECK (queue IN ('default', 'large_files', 'priority', 'ai'));
    END IF;
END $$;

-- =============================================================================
-- Add index for queue-based polling
-- =============================================================================
-- Optimizes the worker's job acquisition query:
-- SELECT * FROM processing_jobs WHERE queue = $1 AND status = 'pending'
-- ORDER BY priority DESC, created_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED

CREATE INDEX IF NOT EXISTS idx_processing_jobs_queue_polling
ON processing_jobs (queue, status, priority DESC, created_at ASC)
WHERE status = 'pending';

-- =============================================================================
-- Add index for finding stuck jobs by worker
-- =============================================================================
-- Helps identify jobs that may be stuck (worker died during processing)

CREATE INDEX IF NOT EXISTS idx_processing_jobs_worker_id
ON processing_jobs (worker_id)
WHERE worker_id IS NOT NULL AND status = 'processing';

-- =============================================================================
-- Migration Record
-- =============================================================================

INSERT INTO schema_migrations (version) VALUES ('006_add_job_queue_support')
ON CONFLICT (version) DO NOTHING;

COMMIT;
