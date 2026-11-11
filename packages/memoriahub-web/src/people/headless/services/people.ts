import { api } from '../../../core/headless/index.js';

// ---------------------------------------------------------------------------
// Phase 2 Types — per-media face detection
// ---------------------------------------------------------------------------

/**
 * A face bounding box, normalized to 0..1.
 *
 * @stability experimental
 */
export interface BoundingBox {
  x: number; // normalized 0–1
  y: number;
  w: number;
  h: number;
}

/**
 * One detected face of a media item.
 *
 * @stability experimental
 */
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

/**
 * The face-detection status of a media item.
 *
 * @stability experimental
 */
export type MediaFaceStatusType =
  | 'not_processed'
  | 'pending'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'no_faces';

/**
 * The face-detection status record of a media item.
 *
 * @stability experimental
 */
export interface MediaFaceStatusDto {
  status: MediaFaceStatusType;
  faceCount: number;
  providerKey: string | null;
  modelVersion: string | null;
  processedAt: string | null;
  lastError: string | null;
}

/**
 * The answer of a face-detection re-run.
 *
 * @stability experimental
 */
export interface RerunResult {
  jobId: string;
  status: string;
}

/**
 * The answer of a face-detection backfill.
 *
 * @stability experimental
 */
export interface BackfillResult {
  queued: number;
}

// ---------------------------------------------------------------------------
// Phase 2 API functions
// ---------------------------------------------------------------------------

/**
 * Lists the faces detected on a media item.
 *
 * @stability experimental
 */
export async function getMediaFaces(mediaId: string): Promise<DetectedFaceDto[]> {
  return api.get<DetectedFaceDto[]>(`/media/${mediaId}/faces`);
}

/**
 * Reads the face-detection status of a media item.
 *
 * @stability experimental
 */
export async function getMediaFaceStatus(mediaId: string): Promise<MediaFaceStatusDto> {
  return api.get<MediaFaceStatusDto>(`/media/${mediaId}/faces/status`);
}

/**
 * Re-enqueues face detection for a media item (photo or video).
 *
 * @stability experimental
 */
export async function rerunMediaFaces(mediaId: string): Promise<RerunResult> {
  return api.post<RerunResult>(`/media/${mediaId}/faces/rerun`);
}

// ---------------------------------------------------------------------------
// Phase 3 Types — people management
// ---------------------------------------------------------------------------

/**
 * The face a person card crops its picture from.
 *
 * @stability experimental
 */
export interface PersonCoverFace {
  faceId: string;
  mediaItemId: string;
  boundingBox: BoundingBox;
  /** Signed URL of the representative video frame JPEG used for face crops. Null for photos. */
  faceThumbnailUrl: string | null;
}

/**
 * A person as the list shows them.
 *
 * @stability experimental
 */
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

/**
 * One page of people.
 *
 * @stability experimental
 */
export interface PersonListResponse {
  items: PersonListItem[];
  meta: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

/**
 * A face of a person.
 *
 * @stability experimental
 */
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

/**
 * A person with their faces.
 *
 * @stability experimental
 */
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

/**
 * The answer of clustering the unknown faces.
 *
 * @stability experimental
 */
export interface ClusterResult {
  clustersCreated: number;
  facesAssigned: number;
}

// ---------------------------------------------------------------------------
// Phase 3 API functions
// ---------------------------------------------------------------------------

/**
 * Lists the people of a circle (paginated, optionally the hidden ones).
 *
 * @stability experimental
 */
export async function listPeople(
  circleId: string,
  opts?: {
    includeUnlabeled?: boolean;
    page?: number;
    pageSize?: number;
    hidden?: boolean;
    /** Scope the people list to those appearing in a single album. */
    albumId?: string;
  },
): Promise<PersonListResponse> {
  const p = new URLSearchParams({ circleId });
  if (opts?.includeUnlabeled) p.set('includeUnlabeled', 'true');
  if (opts?.page) p.set('page', String(opts.page));
  if (opts?.pageSize) p.set('pageSize', String(opts.pageSize));
  if (opts?.hidden) p.set('hidden', 'true');
  if (opts?.albumId) p.set('albumId', opts.albumId);
  return api.get<PersonListResponse>(`/people?${p.toString()}`);
}

// ---------------------------------------------------------------------------
// Bulk hide / unhide / purge
// ---------------------------------------------------------------------------

/**
 * Hides people from the People surfaces; faces and media are untouched.
 *
 * @stability experimental
 */
export async function bulkHidePeople(
  circleId: string,
  ids: string[],
): Promise<{ hidden: number }> {
  return api.patch<{ hidden: number }>('/people/bulk/hide', { circleId, ids });
}

/**
 * Restores hidden people.
 *
 * @stability experimental
 */
export async function bulkUnhidePeople(
  circleId: string,
  ids: string[],
): Promise<{ unhidden: number }> {
  return api.patch<{ unhidden: number }>('/people/bulk/unhide', { circleId, ids });
}

/**
 * Permanently deletes people and their faces; the media is kept.
 *
 * @stability experimental
 */
export async function purgePeople(
  circleId: string,
  ids: string[],
): Promise<{ deleted: number }> {
  return api.post<{ deleted: number }>('/people/bulk/purge', { circleId, ids });
}

/**
 * Reads one person with their faces.
 *
 * @stability experimental
 */
export async function getPerson(id: string): Promise<PersonDetail> {
  return api.get<PersonDetail>(`/people/${id}`);
}

/**
 * Creates a person, optionally with initial faces.
 *
 * @stability experimental
 */
export async function createPerson(body: {
  circleId: string;
  name?: string;
  faceIds?: string[];
}): Promise<{ id: string; name: string | null; circleId: string }> {
  return api.post<{ id: string; name: string | null; circleId: string }>('/people', body);
}

/**
 * Renames a person or sets the cover face.
 *
 * @stability experimental
 */
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

/**
 * Marks or unmarks a person as a favorite.
 *
 * @stability experimental
 */
export async function setPersonFavorite(id: string, favorite: boolean): Promise<void> {
  await updatePerson(id, { favorite });
}

/**
 * Assigns faces to a person (a manual assignment).
 *
 * @stability experimental
 */
export async function assignFaces(
  personId: string,
  faceIds: string[],
): Promise<{ personId: string; assignedCount: number }> {
  return api.post<{ personId: string; assignedCount: number }>(`/people/${personId}/faces`, { faceIds });
}

/**
 * Returns a face to the unknown pool.
 *
 * @stability experimental
 */
export async function unassignFace(personId: string, faceId: string): Promise<void> {
  await api.delete<void>(`/people/${personId}/faces/${faceId}`);
}

/**
 * Groups the unknown faces of a circle into provisional people.
 *
 * @stability experimental
 */
export async function clusterUnknownFaces(circleId: string): Promise<ClusterResult> {
  return api.post<ClusterResult>('/people/cluster', { circleId });
}

// ---------------------------------------------------------------------------
// Phase 4 Types — merge, delete, circle face settings, biometrics
// ---------------------------------------------------------------------------

/**
 * The answer of a merge.
 *
 * @stability experimental
 */
export interface MergePeopleResult {
  id: string;
  name: string | null;
  circleId: string;
  faceCount: number;
  updatedAt: string;
}

/**
 * The answer of erasing a circle's biometrics.
 *
 * @stability experimental
 */
export interface DeleteBiometricsResult {
  deletedFaces: number;
  deletedPeople: number;
}

// ---------------------------------------------------------------------------
// Phase 4 API functions
// ---------------------------------------------------------------------------

/**
 * Merges one person into another.
 *
 * @stability experimental
 */
export async function mergePeople(
  sourceId: string,
  targetId: string,
): Promise<MergePeopleResult> {
  return api.post<MergePeopleResult>('/people/merge', { sourceId, targetId });
}

/**
 * Deletes a person; their faces return to the unknown pool.
 *
 * @stability experimental
 */
export async function deletePerson(personId: string): Promise<void> {
  await api.delete<void>(`/people/${personId}`);
}

/**
 * Permanently erases every face and person of a circle.
 *
 * @stability experimental
 */
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

/**
 * A face that belongs to no person.
 *
 * @stability experimental
 */
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

/**
 * One page of unassigned faces.
 *
 * @stability experimental
 */
export interface UnassignedFacesResponse {
  items: UnassignedFaceDto[];
  meta: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

// ---------------------------------------------------------------------------
// Phase 5 API functions
// ---------------------------------------------------------------------------

/**
 * Lists the faces that belong to no person (live, or the archived ones).
 *
 * @stability experimental
 */
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

/**
 * Archives unassigned faces.
 *
 * @stability experimental
 */
export async function bulkHideFaces(
  circleId: string,
  ids: string[],
): Promise<{ hidden: number }> {
  return api.patch<{ hidden: number }>('/people/faces/bulk/hide', { circleId, ids });
}

/**
 * Restores archived unassigned faces.
 *
 * @stability experimental
 */
export async function bulkUnhideFaces(
  circleId: string,
  ids: string[],
): Promise<{ unhidden: number }> {
  return api.patch<{ unhidden: number }>('/people/faces/bulk/unhide', { circleId, ids });
}

/**
 * Permanently deletes unassigned faces.
 *
 * @stability experimental
 */
export async function purgeFaces(
  circleId: string,
  ids: string[],
): Promise<{ deleted: number }> {
  return api.post<{ deleted: number }>('/people/faces/bulk/purge', { circleId, ids });
}

/**
 * Permanently deletes every archived unassigned face of a circle.
 *
 * @stability experimental
 */
export async function purgeArchivedFaces(
  circleId: string,
): Promise<{ deleted: number }> {
  return api.post<{ deleted: number }>('/people/faces/purge-archived', { circleId });
}

// ---------------------------------------------------------------------------
// Manual people association
// ---------------------------------------------------------------------------

/**
 * The answer of associating a person with a media item.
 *
 * @stability experimental
 */
export interface AddPersonToMediaResult {
  personId: string;
  personName: string | null;
  faceId: string;
  mediaItemId: string;
}

/**
 * Associates a person (by id, or by name, created when new) with a media item without a bounding box.
 *
 * @stability experimental
 */
export async function addPersonToMedia(
  mediaId: string,
  body: { personId?: string; name?: string },
): Promise<AddPersonToMediaResult> {
  const result = await api.post<{ data: AddPersonToMediaResult }>(`/media/${mediaId}/people`, body);
  return result.data;
}

/**
 * Removes the manual association of a person with a media item.
 *
 * @stability experimental
 */
export async function removePersonFromMedia(
  mediaId: string,
  personId: string,
): Promise<void> {
  await api.delete<void>(`/media/${mediaId}/people/${personId}`);
}
