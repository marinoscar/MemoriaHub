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
  model: string;
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
  providerKey: string;
  modelVersion: string;
  manuallyAssigned: boolean;
  createdAt: string;
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

export async function runFaceBackfill(circleId: string, force?: boolean): Promise<BackfillResult> {
  return api.post<BackfillResult>('/face/backfill', { circleId, force });
}

// ---------------------------------------------------------------------------
// Phase 3 Types — people management
// ---------------------------------------------------------------------------

export interface PersonCoverFace {
  faceId: string;
  mediaItemId: string;
  boundingBox: BoundingBox;
}

export interface PersonListItem {
  id: string;
  name: string | null;
  isUnlabeled: boolean;
  faceCount: number;
  coverFace: PersonCoverFace | null;
  createdAt: string;
  updatedAt: string;
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
}

export interface PersonDetail {
  id: string;
  name: string | null;
  isUnlabeled: boolean;
  circleId: string;
  coverFace: PersonCoverFace | null;
  faces: PersonFace[];
  createdAt: string;
  updatedAt: string;
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
  opts?: { includeUnlabeled?: boolean; page?: number; pageSize?: number },
): Promise<PersonListResponse> {
  const p = new URLSearchParams({ circleId });
  if (opts?.includeUnlabeled) p.set('includeUnlabeled', 'true');
  if (opts?.page) p.set('page', String(opts.page));
  if (opts?.pageSize) p.set('pageSize', String(opts.pageSize));
  return api.get<PersonListResponse>(`/people?${p.toString()}`);
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
  body: { name?: string; coverFaceId?: string | null },
): Promise<{ id: string; name: string | null; coverFaceId: string | null; updatedAt: string }> {
  return api.patch<{ id: string; name: string | null; coverFaceId: string | null; updatedAt: string }>(`/people/${id}`, body);
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

export interface CircleFaceSettings {
  faceRecognitionEnabled: boolean;
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

export async function getCircleFaceSettings(circleId: string): Promise<CircleFaceSettings> {
  return api.get<CircleFaceSettings>(`/circles/${circleId}/face-settings`);
}

export async function updateCircleFaceSettings(
  circleId: string,
  enabled: boolean,
): Promise<CircleFaceSettings> {
  return api.put<CircleFaceSettings>(`/circles/${circleId}/face-settings`, { enabled });
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
