import type { NearFilterValue } from '@marinoscar/memoriahub-contract/search';
import { api } from '../../../core/headless/index.js';
import type { MediaItem, MediaListMeta } from '../../../media/headless/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Search Field.
 *
 * @stability experimental
 */
export interface SearchField {
  /** The `key`. */
  key: string;
  /** The `label`. */
  label: string;
  /** The `type`. */
  type: 'string' | 'enum' | 'date-range' | 'boolean' | 'geo' | 'person-set';
  /** The `enumValues`. */
  enumValues?: string[];
  /** The `description`. */
  description?: string;
}

/**
 * Search Filters.
 *
 * @stability experimental
 */
export interface SearchFilters {
  [key: string]: unknown;
}

/**
 * Near Filter.
 *
 * @stability experimental
 */
export type NearFilter = NearFilterValue;

/**
 * Search Request.
 *
 * @stability experimental
 */
export interface SearchRequest {
  /** The `circleId`. */
  circleId: string;
  /** The `filters`. */
  filters: SearchFilters;
  /** The `semanticQuery`. */
  semanticQuery?: string;
  /** The `page`. */
  page?: number;
  /** The `pageSize`. */
  pageSize?: number;
  /** The `sortBy`. */
  sortBy?: string;
  /** The `sortOrder`. */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Search Response.
 *
 * @stability experimental
 */
export interface SearchResponse {
  /** The `items`. */
  items: MediaItem[];
  /** The `meta`. */
  meta: MediaListMeta;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Get Search Fields.
 *
 * @stability experimental
 */
export async function getSearchFields(): Promise<SearchField[]> {
  return api.get<SearchField[]>('/search/fields');
}

/**
 * Perform Search.
 *
 * @stability experimental
 */
export async function performSearch(body: SearchRequest): Promise<SearchResponse> {
  return api.post<SearchResponse>('/search', body);
}
