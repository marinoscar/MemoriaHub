import { api } from './api';
import type { Circle, CircleMember, CircleInvite, CircleRole } from '../types/circles';

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

export interface CircleMembersResponse {
  items: CircleMember[];
  total: number;
}

export interface CircleInvitesResponse {
  items: CircleInvite[];
  total: number;
}

// ---------------------------------------------------------------------------
// Circle CRUD
// ---------------------------------------------------------------------------

export async function listCircles(all?: boolean): Promise<CirclesListResponse> {
  const qs = all ? '?all=true' : '';
  return api.get<CirclesListResponse>(`/circles${qs}`);
}

export async function getCircle(id: string): Promise<Circle> {
  return api.get<Circle>(`/circles/${id}`);
}

export async function createCircle(dto: {
  name: string;
  description?: string;
}): Promise<Circle> {
  return api.post<Circle>('/circles', dto);
}

export async function updateCircle(
  id: string,
  dto: { name?: string; description?: string },
): Promise<Circle> {
  return api.patch<Circle>(`/circles/${id}`, dto);
}

export async function deleteCircle(id: string): Promise<void> {
  await api.delete<void>(`/circles/${id}`);
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export async function listMembers(circleId: string): Promise<CircleMembersResponse> {
  return api.get<CircleMembersResponse>(`/circles/${circleId}/members`);
}

export async function addMember(
  circleId: string,
  dto: { userId: string; role: CircleRole },
): Promise<CircleMember> {
  return api.post<CircleMember>(`/circles/${circleId}/members`, dto);
}

export async function updateMemberRole(
  circleId: string,
  userId: string,
  role: CircleRole,
): Promise<CircleMember> {
  return api.patch<CircleMember>(`/circles/${circleId}/members/${userId}`, { role });
}

export async function removeMember(circleId: string, userId: string): Promise<void> {
  await api.delete<void>(`/circles/${circleId}/members/${userId}`);
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export async function listInvites(circleId: string): Promise<CircleInvitesResponse> {
  return api.get<CircleInvitesResponse>(`/circles/${circleId}/invites`);
}

export async function createInvite(
  circleId: string,
  dto: { email: string; role: CircleRole; notes?: string },
): Promise<CircleInvite> {
  return api.post<CircleInvite>(`/circles/${circleId}/invites`, dto);
}

export async function revokeInvite(circleId: string, inviteId: string): Promise<void> {
  await api.delete<void>(`/circles/${circleId}/invites/${inviteId}`);
}
