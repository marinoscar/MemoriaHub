import type { MemoriahubPrismaClientLike } from '../../ports/index.js';
import type { MediaDelegate } from '../../media/index.js';

// =============================================================================
// The face slice's view of the database client
// =============================================================================
//
// The slice never imports a generated client. It narrows `MEMORIAHUB_PRISMA` with
// the delegates it uses; a row is read through the columns a `select` names. A
// transaction client has the same delegates.
// =============================================================================

/**
 * A model delegate with the grouping call the face queries use.
 *
 * @stability experimental
 */
export interface FaceDelegate extends MediaDelegate {
  /** Groups rows by columns. */
  groupBy(args: any): Promise<any[]>;
}

/**
 * The models of the face slice, as `MEMORIAHUB_PRISMA` offers them.
 *
 * @stability experimental
 */
export interface FaceModels {
  /** `faces`. */
  face: FaceDelegate;
  /** `people`. */
  person: FaceDelegate;
  /** `media_face_status`. */
  mediaFaceStatus: MediaDelegate;
  /** `media_items`. */
  mediaItem: MediaDelegate;
  /** `storage_objects`. */
  storageObject: MediaDelegate;
  /** `audit_events`: written inside the transaction of the action it records. */
  auditEvent: MediaDelegate;
}

/**
 * The database client of the face slice.
 *
 * @stability experimental
 */
export type FaceDb = MemoriahubPrismaClientLike & FaceModels;
