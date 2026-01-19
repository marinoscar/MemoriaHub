/**
 * Library Types
 * Types for photo/video library organization and sharing
 */

// Library visibility levels
export type LibraryVisibility = 'private' | 'shared' | 'public';

// Library member roles
export type LibraryMemberRole = 'viewer' | 'contributor' | 'admin';

/**
 * Library entity (internal representation)
 */
export interface Library {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  visibility: LibraryVisibility;
  coverAssetId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Library DTO for API responses
 */
export interface LibraryDTO {
  id: string;
  ownerId: string;
  ownerName?: string;
  ownerEmail?: string;
  name: string;
  description: string | null;
  visibility: LibraryVisibility;
  coverAssetId: string | null;
  coverUrl?: string | null;
  assetCount?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Library member entity (internal representation)
 */
export interface LibraryMember {
  id: string;
  libraryId: string;
  userId: string;
  role: LibraryMemberRole;
  invitedBy: string | null;
  createdAt: Date;
}

/**
 * Library member DTO for API responses
 */
export interface LibraryMemberDTO {
  id: string;
  libraryId: string;
  userId: string;
  userEmail: string;
  userName?: string;
  userAvatar?: string | null;
  role: LibraryMemberRole;
  invitedBy: string | null;
  createdAt: string;
}

/**
 * Input for creating a new library
 */
export interface CreateLibraryInput {
  name: string;
  description?: string | null;
  visibility?: LibraryVisibility;
}

/**
 * Input for updating a library
 */
export interface UpdateLibraryInput {
  name?: string;
  description?: string | null;
  visibility?: LibraryVisibility;
  coverAssetId?: string | null;
}

/**
 * Input for adding a library member
 */
export interface AddLibraryMemberInput {
  userId: string;
  role?: LibraryMemberRole;
}

/**
 * Input for updating a library member's role
 */
export interface UpdateLibraryMemberInput {
  role: LibraryMemberRole;
}

/**
 * Library with member count for list views
 */
export interface LibraryWithStats extends LibraryDTO {
  memberCount?: number;
  assetCount?: number;
  totalSize?: number;
}

/**
 * Library event types for audit logging
 */
export type LibraryEventType =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'member_added'
  | 'member_removed'
  | 'member_role_changed'
  | 'visibility_changed';

/**
 * Library audit event
 */
export interface LibraryAuditEvent {
  id: string;
  libraryId: string | null;
  eventType: LibraryEventType;
  previousValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  performedBy: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  traceId: string | null;
  createdAt: Date;
}

/**
 * Default values
 */
export const DEFAULT_LIBRARY_VISIBILITY: LibraryVisibility = 'private';
export const DEFAULT_MEMBER_ROLE: LibraryMemberRole = 'viewer';

// =============================================================================
// Library Asset Management Types
// =============================================================================

/**
 * Input for listing assets in a library
 */
export interface ListLibraryAssetsInput {
  page?: number;
  limit?: number;
  sortBy?: 'addedAt' | 'capturedAt' | 'filename';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Library event types for audit logging (extended)
 */
export type LibraryAssetEventType =
  | 'asset_added'
  | 'asset_removed';

/**
 * Library asset audit event
 */
export interface LibraryAssetAuditEvent {
  id: string;
  libraryId: string | null;
  assetId: string | null;
  eventType: LibraryAssetEventType;
  performedBy: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  traceId: string | null;
  createdAt: Date;
}
