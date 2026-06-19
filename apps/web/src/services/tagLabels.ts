import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TagLabel {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function listTagLabels(): Promise<TagLabel[]> {
  return api.get<TagLabel[]>('/tag-labels');
}

export async function createTagLabel(body: {
  name: string;
  description?: string;
}): Promise<TagLabel> {
  return api.post<TagLabel>('/tag-labels', body);
}

export async function updateTagLabel(
  id: string,
  body: { name?: string; description?: string; enabled?: boolean },
): Promise<TagLabel> {
  return api.patch<TagLabel>(`/tag-labels/${id}`, body);
}

export async function deleteTagLabel(id: string): Promise<void> {
  await api.delete<void>(`/tag-labels/${id}`);
}
