package memoriahub.marin.cr.media

import kotlinx.serialization.Serializable
import memoriahub.marin.cr.permissions.MediaPermissionState
import java.io.InputStream

/** One MediaStore file as returned by a scan (docs/specs/android-media-sync.md §8.3). */
data class MediaRow(
    val mediaStoreId: Long,
    val volume: String,
    /** The plain `content://media/<volume>/images|video/media/<id>` URI. */
    val uri: String,
    val displayName: String,
    /** `RELATIVE_PATH` (API 29+) or the directory of `DATA` below it, e.g. `DCIM/Camera/`. */
    val relativePath: String?,
    val bucketId: String?,
    val bucketName: String?,
    val mimeType: String,
    val isVideo: Boolean,
    val sizeBytes: Long,
    /** `DATE_TAKEN`, epoch ms; null when MediaStore has none (or 0). */
    val dateTakenMs: Long?,
    /** `DATE_MODIFIED`, epoch seconds. */
    val dateModifiedSec: Long,
    /** `GENERATION_MODIFIED` (API 30+), else null. */
    val generationModified: Long?,
    /** Video `DURATION` in ms, else null. */
    val durationMs: Long?,
)

/**
 * A MediaStore bucket (folder) with its counts: the check-in `inventory[]` entry (§6.4) and the
 * web folder picker's source. Field names are the wire names.
 */
@Serializable
data class Bucket(
    val bucketId: String,
    val name: String,
    val relativePath: String,
    val photoCount: Int,
    val videoCount: Int,
    val bytes: Long,
)

/**
 * Where an incremental scan of one volume resumes. Both cursors null means a **full** scan.
 * - [sinceGeneration]: rows with `GENERATION_ADDED` or `GENERATION_MODIFIED` greater than this (API 30+).
 * - [sinceDateModifiedSec]: below API 30, rows with `DATE_MODIFIED` or `DATE_ADDED` at or after
 *   this minus [DATE_SLACK_SEC] (MediaStore dates have second granularity).
 */
data class ScanCursor(
    val volume: String,
    val sinceGeneration: Long? = null,
    val sinceDateModifiedSec: Long? = null,
) {
    val isFull: Boolean get() = sinceGeneration == null && sinceDateModifiedSec == null

    companion object {
        const val DATE_SLACK_SEC = 2L

        fun full(volume: String): ScanCursor = ScanCursor(volume)
    }
}

/**
 * MediaStore, behind a plain interface so scanning and reconcile are JVM-tested with a fake
 * ([AndroidMediaGateway] is the `ContentResolver` implementation).
 */
interface MediaGateway {
    /** External volumes to scan (`MediaStore.getExternalVolumeNames`, API 29+; `external` below). */
    fun volumes(): Set<String>

    /** `MediaStore.getGeneration(volume)` (API 30+), else null. Capture it **before** a scan. */
    fun currentGeneration(volume: String): Long?

    /** `MediaStore.getVersion(volume)`: it changes when the media database is rebuilt and generations reset. */
    fun mediaStoreVersion(volume: String): String?

    /** Every bucket with non-pending, non-trashed media, across all volumes. Empty without permission. */
    fun inventory(): List<Bucket>

    /**
     * Rows of [since]'s volume in [buckets] (empty set ⇒ empty sequence) of the included types,
     * excluding pending and trashed rows. Consume the sequence fully: the cursor closes at its end.
     */
    fun scan(since: ScanCursor, buckets: Set<String>, includePhotos: Boolean, includeVideos: Boolean): Sequence<MediaRow>

    /**
     * The bytes `[offset, offset + length)` of [uri] (the upload engine's part source). Uses the
     * same URI form as [openStream] (D24: `setRequireOriginal` for photos when `ACCESS_MEDIA_LOCATION`
     * is granted, the plain URI when that throws), so the hash and the upload read identical bytes.
     */
    fun openRange(uri: String, offset: Long, length: Long): InputStream

    /** The whole file, for hashing; same URI form as [openRange]. */
    fun openStream(uri: String): InputStream

    fun permissionState(): MediaPermissionState
}
