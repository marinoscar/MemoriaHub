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

export interface Conversation {
  id: string;
  circleId: string;
  title: string | null;
  favorite: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface ConversationDetail extends Conversation {
  messages: ConversationMessage[];
}

export interface ConversationsListResponse {
  items: Conversation[];
  total: number;
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

export async function createConversation(circleId: string): Promise<Conversation> {
  return api.post<Conversation>('/search/conversations', { circleId });
}

export async function listConversations(params: {
  circleId?: string;
  favorite?: boolean;
  archived?: boolean;
}): Promise<ConversationsListResponse> {
  const searchParams = new URLSearchParams();
  if (params.circleId) searchParams.set('circleId', params.circleId);
  if (params.favorite !== undefined) searchParams.set('favorite', String(params.favorite));
  if (params.archived !== undefined) searchParams.set('archived', String(params.archived));
  const qs = searchParams.toString();
  return api.get<ConversationsListResponse>(`/search/conversations${qs ? `?${qs}` : ''}`);
}

export async function getConversation(id: string): Promise<ConversationDetail> {
  return api.get<ConversationDetail>(`/search/conversations/${id}`);
}

export async function patchConversation(
  id: string,
  body: { title?: string; favorite?: boolean; archived?: boolean },
): Promise<Conversation> {
  return api.patch<Conversation>(`/search/conversations/${id}`, body);
}

export async function deleteConversation(id: string): Promise<void> {
  await api.delete<void>(`/search/conversations/${id}`);
}
