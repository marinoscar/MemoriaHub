import { api } from './api';
import type { MediaItem, MediaListMeta } from '../types/media';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchField {
  key: string;
  label: string;
  type: 'string' | 'enum' | 'date-range' | 'boolean' | 'geo' | 'person-set';
  enumValues?: string[];
  description?: string;
}

export interface SearchFilters {
  [key: string]: unknown;
}

export interface SearchRequest {
  circleId: string;
  filters: SearchFilters;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface SearchResponse {
  items: MediaItem[];
  meta: MediaListMeta;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getSearchFields(): Promise<SearchField[]> {
  return api.get<SearchField[]>('/search/fields');
}

export async function performSearch(body: SearchRequest): Promise<SearchResponse> {
  return api.post<SearchResponse>('/search', body);
}
