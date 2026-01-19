import { z } from 'zod';

/**
 * Query parameters for listing jobs
 */
export const listJobsQuerySchema = z.object({
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled']).optional(),
  jobType: z.enum([
    'extract_metadata',
    'generate_thumbnail',
    'generate_preview',
    'reverse_geocode',
    'detect_faces',
    'detect_objects',
    'index_search',
  ]).optional(),
  queue: z.enum(['default', 'large_files', 'priority', 'ai']).optional(),
  assetId: z.string().uuid().optional(),
  libraryId: z.string().uuid().optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sortBy: z.enum(['createdAt', 'startedAt', 'completedAt', 'priority']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

/**
 * Request body for creating a job manually
 */
export const createJobBodySchema = z.object({
  assetId: z.string().uuid(),
  jobType: z.enum([
    'extract_metadata',
    'generate_thumbnail',
    'generate_preview',
    'reverse_geocode',
    'detect_faces',
    'detect_objects',
    'index_search',
  ]),
  queue: z.enum(['default', 'large_files', 'priority', 'ai']).default('default'),
  priority: z.number().int().min(0).max(100).default(10),
  payload: z.record(z.unknown()).optional(),
});

export type CreateJobBody = z.infer<typeof createJobBodySchema>;

/**
 * Request body for batch retry
 */
export const batchRetryBodySchema = z.object({
  jobIds: z.array(z.string().uuid()).optional(),
  filters: z.object({
    jobType: z.enum([
      'extract_metadata',
      'generate_thumbnail',
      'generate_preview',
      'reverse_geocode',
      'detect_faces',
      'detect_objects',
      'index_search',
    ]).optional(),
    queue: z.enum(['default', 'large_files', 'priority', 'ai']).optional(),
  }).optional(),
});

export type BatchRetryBody = z.infer<typeof batchRetryBodySchema>;

/**
 * Job ID parameter
 */
export const jobIdParamSchema = z.object({
  id: z.string().uuid(),
});

export type JobIdParam = z.infer<typeof jobIdParamSchema>;
