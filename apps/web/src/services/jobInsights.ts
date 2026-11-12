import { api } from './api';

/**
 * Clears the lifetime job-stats rollup (`POST /api/admin/jobs/insights/reset-history`).
 *
 * Stays in the app (RETRO-J11, #626): the endpoint is the platform jobs slice's, and the one
 * caller is the platform-owned System Settings page; nothing of the MemoriaHub domain is in it.
 */
export async function resetJobHistory(): Promise<{ reset: number }> {
  return api.post<{ reset: number }>('/admin/jobs/insights/reset-history');
}
