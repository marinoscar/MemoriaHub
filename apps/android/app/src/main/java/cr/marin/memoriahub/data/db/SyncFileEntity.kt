package cr.marin.memoriahub.data.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * One row per device media item (keyed by its stable MediaStore `_ID`). This is the
 * durable, crash-safe state machine that guarantees no photo is left unsynced: every
 * scan reconciles MediaStore against these rows, and the upload pipeline advances
 * each row through [SyncStatus].
 */
@Entity(
    tableName = "sync_files",
    indices = [
        Index(value = ["status"]),
        Index(value = ["sha256"]),
    ],
)
data class SyncFileEntity(
    @PrimaryKey
    val mediaStoreId: Long,

    val contentUri: String,
    val displayName: String,
    /** MediaStore `bucket_id` of the folder this item lives in; drives folder-scoped cleanup. */
    val bucketId: String? = null,
    val bucket: String? = null,
    val relativePath: String? = null,
    val mimeType: String,
    val type: MediaType,

    val sizeBytes: Long,
    /** DATE_MODIFIED in millis — used with [sizeBytes] to detect edits and stable-file state. */
    val mtimeMs: Long,
    /** DATE_ADDED in seconds — feeds the incremental-scan high-water mark. */
    val dateAddedSec: Long,
    /** DATE_TAKEN in millis when available (capture time), used for capturedAt + grouping. */
    val dateTakenMs: Long? = null,

    val sha256: String? = null,
    val circleId: String? = null,

    val status: SyncStatus = SyncStatus.QUEUED,
    val attemptCount: Int = 0,
    val lastError: String? = null,

    val mediaItemId: String? = null,
    val storageObjectId: String? = null,
    val uploadId: String? = null,
    /** JSON array of completed multipart parts ({partNumber, eTag}) for resume. */
    val partProgressJson: String? = null,

    val uploadedAt: Long? = null,
    val updatedAt: Long,
)
