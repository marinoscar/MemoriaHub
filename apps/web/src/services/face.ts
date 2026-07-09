import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FaceCapabilities {
  detect: boolean;
  embed: boolean;
  delegatedRecognize: boolean;
}

export interface FaceProvider {
  provider: string; // 'compreface' | 'rekognition' | 'human'
  configured: boolean;
  enabled: boolean;
  requiresCredentials?: boolean;
  last4: string | null;
  baseUrl: string | null;
  region: string | null;
  capabilities?: FaceCapabilities;
}

export interface FaceSettingsResponse {
  providers: FaceProvider[];
  knownProviders: FaceProvider[];
  features: {
    detection: { provider: string | null; model: string | null } | null;
  };
}

export interface FaceTestResult {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getFaceSettings(): Promise<FaceSettingsResponse> {
  return api.get<FaceSettingsResponse>('/face/settings');
}

export async function putFaceCredentials(
  provider: string,
  body: { apiKey?: string; baseUrl?: string; region?: string; enabled?: boolean },
): Promise<void> {
  await api.put<void>(`/face/credentials/${provider}`, body);
}

export async function deleteFaceCredentials(provider: string): Promise<void> {
  await api.delete<void>(`/face/credentials/${provider}`);
}

export async function testFaceProvider(body: {
  provider: string;
  model?: string;
}): Promise<FaceTestResult> {
  return api.post<FaceTestResult>('/face/test', body);
}

export async function getFaceModels(provider: string): Promise<string[]> {
  return api.get<string[]>(`/face/models?provider=${encodeURIComponent(provider)}`);
}

export async function putFaceDetectionFeature(body: {
  provider: string;
  model: string;
}): Promise<void> {
  await api.put<void>('/face/features/detection', body);
}

// ---------------------------------------------------------------------------
// Phase 2 Types — per-media face detection
// ---------------------------------------------------------------------------

export interface BoundingBox {
  x: number; // normalized 0–1
  y: number;
  w: number;
  h: number;
}

export interface DetectedFaceDto {
  id: string;
  boundingBox: BoundingBox;
  confidence: number | null;
  personId: string | null;
  personName: string | null;
  providerKey: string;
  modelVersion: string;
  manuallyAssigned: boolean;
  createdAt: string;
  /** Representative timestamp within the video (ms from start). Null for photos. */
  videoTimestampMs: number | null;
  /** All sampled timestamps where this face appears (ms from start). Empty for photos. */
  videoTimestamps: number[];
  /** Signed URL of the representative video frame JPEG used for face crops. Null for photos. */
  faceThumbnailUrl: string | null;
}

export type MediaFaceStatusType =
  | 'not_processed'
  | 'pending'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'no_faces';

export interface MediaFaceStatusDto {
  status: MediaFaceStatusType;
  faceCount: number;
  providerKey: string | null;
  modelVersion: string | null;
  processedAt: string | null;
  lastError: string | null;
}

export interface RerunResult {
  jobId: string;
  status: string;
}

export interface BackfillResult {
  queued: number;
}

// ---------------------------------------------------------------------------
// Phase 2 API functions
// ---------------------------------------------------------------------------

export async function getMediaFaces(mediaId: string): Promise<DetectedFaceDto[]> {
  return api.get<DetectedFaceDto[]>(`/media/${mediaId}/faces`);
}

export async function getMediaFaceStatus(mediaId: string): Promise<MediaFaceStatusDto> {
  return api.get<MediaFaceStatusDto>(`/media/${mediaId}/faces/status`);
}

export async function rerunMediaFaces(mediaId: string): Promise<RerunResult> {
  return api.post<RerunResult>(`/media/${mediaId}/faces/rerun`);
}

// ---------------------------------------------------------------------------
// Phase 3 Types — people management
// ---------------------------------------------------------------------------

export interface PersonCoverFace {
  faceId: string;
  mediaItemId: string;
  boundingBox: BoundingBox;
  /** Signed URL of the representative video frame JPEG used for face crops. Null for photos. */
  faceThumbnailUrl: string | null;
}

export interface PersonListItem {
  id: string;
  name: string | null;
  isUnlabeled: boolean;
  faceCount: number;
  coverFace: PersonCoverFace | null;
  profileMediaItemId?: string | null;
  profileCrop?: { x: number; y: number; w: number; h: number } | null;
  createdAt: string;
  updatedAt: string;
  favorite: boolean;
}

export interface PersonListResponse {
  items: PersonListItem[];
  meta: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export interface PersonFace {
  faceId: string;
  mediaItemId: string;
  boundingBox: BoundingBox;
  confidence: number | null;
  manuallyAssigned: boolean;
  createdAt: string;
  /** Signed URL of the representative video frame JPEG used for face crops. Null for photos. */
  faceThumbnailUrl: string | null;
}

export interface PersonDetail {
  id: string;
  name: string | null;
  isUnlabeled: boolean;
  circleId: string;
  coverFace: PersonCoverFace | null;
  profileMediaItemId?: string | null;
  profileCrop?: { x: number; y: number; w: number; h: number } | null;
  faces: PersonFace[];
  createdAt: string;
  updatedAt: string;
  favorite?: boolean;
}

export interface ClusterResult {
  clustersCreated: number;
  facesAssigned: number;
}

// ---------------------------------------------------------------------------
// Phase 3 API functions
// ---------------------------------------------------------------------------

export async function listPeople(
  circleId: string,
  opts?: { includeUnlabeled?: boolean; page?: number; pageSize?: number; hidden?: boolean },
): Promise<PersonListResponse> {
  const p = new URLSearchParams({ circleId });
  if (opts?.includeUnlabeled) p.set('includeUnlabeled', 'true');
  if (opts?.page) p.set('page', String(opts.page));
  if (opts?.pageSize) p.set('pageSize', String(opts.pageSize));
  if (opts?.hidden) p.set('hidden', 'true');
  return api.get<PersonListResponse>(`/people?${p.toString()}`);
}

// ---------------------------------------------------------------------------
// Bulk hide / unhide / purge
// ---------------------------------------------------------------------------

export async function bulkHidePeople(
  circleId: string,
  ids: string[],
): Promise<{ hidden: number }> {
  return api.patch<{ hidden: number }>('/people/bulk/hide', { circleId, ids });
}

export async function bulkUnhidePeople(
  circleId: string,
  ids: string[],
): Promise<{ unhidden: number }> {
  return api.patch<{ unhidden: number }>('/people/bulk/unhide', { circleId, ids });
}

export async function purgePeople(
  circleId: string,
  ids: string[],
): Promise<{ deleted: number }> {
  return api.post<{ deleted: number }>('/people/bulk/purge', { circleId, ids });
}

export async function getPerson(id: string): Promise<PersonDetail> {
  return api.get<PersonDetail>(`/people/${id}`);
}

export async function createPerson(body: {
  circleId: string;
  name?: string;
  faceIds?: string[];
}): Promise<{ id: string; name: string | null; circleId: string }> {
  return api.post<{ id: string; name: string | null; circleId: string }>('/people', body);
}

export async function updatePerson(
  id: string,
  body: {
    name?: string;
    coverFaceId?: string | null;
    profileMediaItemId?: string | null;
    profileCrop?: { x: number; y: number; w: number; h: number } | null;
    favorite?: boolean;
  },
): Promise<{ id: string; name: string | null; coverFaceId: string | null; updatedAt: string }> {
  return api.patch<{ id: string; name: string | null; coverFaceId: string | null; updatedAt: string }>(`/people/${id}`, body);
}

export async function setPersonFavorite(id: string, favorite: boolean): Promise<void> {
  await updatePerson(id, { favorite });
}

export async function assignFaces(
  personId: string,
  faceIds: string[],
): Promise<{ personId: string; assignedCount: number }> {
  return api.post<{ personId: string; assignedCount: number }>(`/people/${personId}/faces`, { faceIds });
}

export async function unassignFace(personId: string, faceId: string): Promise<void> {
  await api.delete<void>(`/people/${personId}/faces/${faceId}`);
}

export async function clusterUnknownFaces(circleId: string): Promise<ClusterResult> {
  return api.post<ClusterResult>('/people/cluster', { circleId });
}

// ---------------------------------------------------------------------------
// Phase 4 Types — merge, delete, circle face settings, biometrics
// ---------------------------------------------------------------------------

export interface MergePeopleResult {
  id: string;
  name: string | null;
  circleId: string;
  faceCount: number;
  updatedAt: string;
}

export interface DeleteBiometricsResult {
  deletedFaces: number;
  deletedPeople: number;
}

// ---------------------------------------------------------------------------
// Phase 4 API functions
// ---------------------------------------------------------------------------

export async function mergePeople(
  sourceId: string,
  targetId: string,
): Promise<MergePeopleResult> {
  return api.post<MergePeopleResult>('/people/merge', { sourceId, targetId });
}

export async function deletePerson(personId: string): Promise<void> {
  await api.delete<void>(`/people/${personId}`);
}

export async function deleteCircleBiometrics(circleId: string): Promise<DeleteBiometricsResult> {
  const result = await api.delete<{ data: DeleteBiometricsResult } | DeleteBiometricsResult>(
    `/face/biometrics?circleId=${encodeURIComponent(circleId)}`,
  );
  // Unwrap { data: {...} } envelope if present
  if (result && typeof result === 'object' && 'data' in result) {
    return (result as { data: DeleteBiometricsResult }).data;
  }
  return result as DeleteBiometricsResult;
}

// ---------------------------------------------------------------------------
// Phase 5 Types — unassigned faces (lone detected faces not yet in any Person)
// ---------------------------------------------------------------------------

export interface UnassignedFaceDto {
  faceId: string;
  mediaItemId: string;
  boundingBox: BoundingBox;
  confidence: number | null;
  createdAt: string;
  /** Signed URL of the representative video frame JPEG used for face crops. Null for photos. */
  faceThumbnailUrl: string | null;
  /** Archive timestamp; null when the face is live (not archived). */
  hiddenAt: string | null;
}

export interface UnassignedFacesResponse {
  items: UnassignedFaceDto[];
  meta: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

// ---------------------------------------------------------------------------
// Phase 5 API functions
// ---------------------------------------------------------------------------

export async function listUnassignedFaces(
  circleId: string,
  opts?: { page?: number; pageSize?: number; archived?: boolean },
): Promise<UnassignedFacesResponse> {
  const p = new URLSearchParams({ circleId });
  if (opts?.page) p.set('page', String(opts.page));
  if (opts?.pageSize) p.set('pageSize', String(opts.pageSize));
  if (opts?.archived) p.set('archived', 'true');
  return api.get<UnassignedFacesResponse>(`/people/unassigned?${p.toString()}`);
}

// ---------------------------------------------------------------------------
// Bulk hide / unhide / purge — individual faces
// ---------------------------------------------------------------------------

export async function bulkHideFaces(
  circleId: string,
  ids: string[],
): Promise<{ hidden: number }> {
  return api.patch<{ hidden: number }>('/people/faces/bulk/hide', { circleId, ids });
}

export async function bulkUnhideFaces(
  circleId: string,
  ids: string[],
): Promise<{ unhidden: number }> {
  return api.patch<{ unhidden: number }>('/people/faces/bulk/unhide', { circleId, ids });
}

export async function purgeFaces(
  circleId: string,
  ids: string[],
): Promise<{ deleted: number }> {
  return api.post<{ deleted: number }>('/people/faces/bulk/purge', { circleId, ids });
}

export async function purgeArchivedFaces(
  circleId: string,
): Promise<{ deleted: number }> {
  return api.post<{ deleted: number }>('/people/faces/purge-archived', { circleId });
}

// ---------------------------------------------------------------------------
// Manual people association
// ---------------------------------------------------------------------------

export interface AddPersonToMediaResult {
  personId: string;
  personName: string | null;
  faceId: string;
  mediaItemId: string;
}

export async function addPersonToMedia(
  mediaId: string,
  body: { personId?: string; name?: string },
): Promise<AddPersonToMediaResult> {
  const result = await api.post<{ data: AddPersonToMediaResult }>(`/media/${mediaId}/people`, body);
  return result.data;
}

export async function removePersonFromMedia(
  mediaId: string,
  personId: string,
): Promise<void> {
  await api.delete<void>(`/media/${mediaId}/people/${personId}`);
}
