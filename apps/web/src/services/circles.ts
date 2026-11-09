import { api } from './api';
import type { Circle } from '../types/circles';

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface CirclesListResponse {
  items: Circle[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Admin circle listing (RETRO-I6, #588: the only remaining caller of /api/circles, the
// admin Memories backfill's circle picker; member/invite management is the platform
// groups pages')
// ---------------------------------------------------------------------------

export async function listCircles(all?: boolean): Promise<CirclesListResponse> {
  const qs = all ? '?all=true' : '';
  return api.get<CirclesListResponse>(`/circles${qs}`);
}
