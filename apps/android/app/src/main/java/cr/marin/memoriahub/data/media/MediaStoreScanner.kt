package cr.marin.memoriahub.data.media

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import cr.marin.memoriahub.data.db.MediaType
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

data class ScannedMedia(
    val mediaStoreId: Long,
    val contentUri: String,
    val displayName: String,
    val bucketId: String?,
    val bucket: String?,
    val mimeType: String,
    val type: MediaType,
    val sizeBytes: Long,
    val mtimeMs: Long,
    val dateAddedSec: Long,
    val dateTakenMs: Long?,
)

/** A device media folder (MediaStore bucket) that contains at least one photo or video. */
data class MediaBucket(
    val id: String,
    val displayName: String,
)

/**
 * Enumerates device photos and videos from MediaStore. The [sinceDateAddedSec]
 * high-water mark makes incremental scans cheap; callers should still periodically
 * run a full scan (sinceDateAddedSec = 0) for a complete reconcile.
 *
 * Which folders are scanned is driven by the user's selected MediaStore buckets
 * (see [scan]); [listBuckets] enumerates the candidate folders for the picker UI.
 */
@Singleton
class MediaStoreScanner @Inject constructor(
    @param:ApplicationContext private val context: Context,
) {
    /**
     * Scan the selected buckets for media.
     *
     * @param selectedBucketIds the MediaStore `bucket_id`s to scan. When `null` (never
     *   configured — e.g. an existing install that hasn't opened the folder picker), the
     *   legacy [CAMERA_BUCKETS] display-name filter is used so backups keep working. An
     *   empty set scans nothing.
     * @param sinceGeneration when non-null (API 30+ only; ignored below), items whose
     *   GENERATION_ADDED or GENERATION_MODIFIED exceed it also match — catching edits
     *   that keep their DATE_ADDED. OR-combined with [sinceDateAddedSec] so files on
     *   volumes whose generation counter we don't track are still caught by date.
     */
    fun scan(
        selectedBucketIds: Set<String>?,
        sinceDateAddedSec: Long = 0,
        sinceGeneration: Long? = null,
    ): List<ScannedMedia> {
        // Generation columns don't exist below API 30 — using them there would throw.
        val generation = sinceGeneration.takeIf { Build.VERSION.SDK_INT >= Build.VERSION_CODES.R }
        val results = ArrayList<ScannedMedia>()
        results += query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            MediaType.PHOTO,
            selectedBucketIds,
            sinceDateAddedSec,
            generation,
        )
        results += query(
            MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
            MediaType.VIDEO,
            selectedBucketIds,
            sinceDateAddedSec,
            generation,
        )
        return results
    }

    /**
     * The primary external volume's current MediaStore generation, captured BEFORE a
     * scan so mid-scan changes are re-scanned next run rather than lost. Null below
     * API 30 or when the volume is unavailable (callers fall back to date-added mode).
     */
    fun currentGeneration(): Long? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            runCatching { MediaStore.getGeneration(context, MediaStore.VOLUME_EXTERNAL_PRIMARY) }.getOrNull()
        } else {
            null
        }

    /** MediaStore version token; changes when the media DB is rebuilt (generations reset). */
    fun mediaStoreVersion(): String? = runCatching { MediaStore.getVersion(context) }.getOrNull()

    /**
     * Whether media can actually be read. Load-bearing guard for the deletion diff:
     * with permission revoked, scans return empty and a diff would wrongly treat
     * every pending row as deleted from the device.
     */
    fun canRead(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            granted(Manifest.permission.READ_MEDIA_IMAGES) &&
                granted(Manifest.permission.READ_MEDIA_VIDEO)
        } else {
            granted(Manifest.permission.READ_EXTERNAL_STORAGE)
        }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    /**
     * Enumerate distinct device folders (MediaStore buckets) that contain at least one
     * photo or video. Any bucket returned by MediaStore necessarily has media, so the
     * "only folders with media" requirement is automatic.
     */
    fun listBuckets(): List<MediaBucket> {
        val map = LinkedHashMap<String, String>()
        collectBuckets(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, map)
        collectBuckets(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, map)
        return map.map { (id, name) -> MediaBucket(id, name) }
            .sortedBy { it.displayName.lowercase() }
    }

    private fun collectBuckets(collection: Uri, into: MutableMap<String, String>) {
        val projection = arrayOf(COL_BUCKET_ID, COL_BUCKET)
        context.contentResolver.query(collection, projection, null, null, null)?.use { cursor ->
            val idCol = cursor.getColumnIndex(COL_BUCKET_ID)
            val nameCol = cursor.getColumnIndex(COL_BUCKET)
            if (idCol < 0) return
            while (cursor.moveToNext()) {
                if (cursor.isNull(idCol)) continue
                val id = cursor.getString(idCol) ?: continue
                val name = if (nameCol >= 0) cursor.getString(nameCol) else null
                into.putIfAbsent(id, name ?: id)
            }
        }
    }

    private fun query(
        collection: Uri,
        type: MediaType,
        selectedBucketIds: Set<String>?,
        sinceDateAddedSec: Long,
        sinceGeneration: Long? = null,
    ): List<ScannedMedia> {
        val projection = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_ADDED,
            MediaStore.MediaColumns.DATE_MODIFIED,
            MediaStore.MediaColumns.MIME_TYPE,
            COL_DATE_TAKEN,
            COL_BUCKET_ID,
            COL_BUCKET,
        )

        val (selection, args) = buildSelection(selectedBucketIds, sinceDateAddedSec, sinceGeneration)
        val sortOrder = "${MediaStore.MediaColumns.DATE_ADDED} ASC"

        val resolver: ContentResolver = context.contentResolver
        val out = ArrayList<ScannedMedia>()
        resolver.query(collection, projection, selection, args, sortOrder)
            ?.use { cursor ->
                val idCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
                val nameCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
                val sizeCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
                val addedCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_ADDED)
                val modifiedCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
                val mimeCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE)
                val takenCol = cursor.getColumnIndex(COL_DATE_TAKEN)
                val bucketIdCol = cursor.getColumnIndex(COL_BUCKET_ID)
                val bucketCol = cursor.getColumnIndex(COL_BUCKET)

                while (cursor.moveToNext()) {
                    val id = cursor.getLong(idCol)
                    val takenMs = if (takenCol >= 0 && !cursor.isNull(takenCol)) {
                        cursor.getLong(takenCol).takeIf { it > 0 }
                    } else {
                        null
                    }
                    out += ScannedMedia(
                        mediaStoreId = id,
                        contentUri = ContentUris.withAppendedId(collection, id).toString(),
                        displayName = cursor.getString(nameCol) ?: "media_$id",
                        bucketId = if (bucketIdCol >= 0) cursor.getString(bucketIdCol) else null,
                        bucket = if (bucketCol >= 0) cursor.getString(bucketCol) else null,
                        mimeType = cursor.getString(mimeCol) ?: defaultMime(type),
                        type = type,
                        sizeBytes = cursor.getLong(sizeCol),
                        mtimeMs = cursor.getLong(modifiedCol) * 1000L,
                        dateAddedSec = cursor.getLong(addedCol),
                        dateTakenMs = takenMs,
                    )
                }
            }
        return out
    }

    private fun defaultMime(type: MediaType): String =
        if (type == MediaType.VIDEO) "video/*" else "image/*"

    companion object {
        /**
         * Legacy fallback buckets, matched by display name, used only when the user has
         * never configured a folder selection. Stock Android cameras save to DCIM/Camera
         * (bucket "Camera"); some OEMs and the Android emulator save to Pictures or DCIM
         * root. These are the folders pre-selected by default in the picker.
         */
        val CAMERA_BUCKETS = listOf("Camera", "DCIM", "Pictures")

        // Raw column names work across API 26+, avoiding API-gated MediaColumns constants.
        const val COL_DATE_TAKEN = "datetaken"
        const val COL_BUCKET = "bucket_display_name"
        const val COL_BUCKET_ID = "bucket_id"

        // Generation columns exist only on API 30+; callers gate on Build.VERSION.
        const val COL_GENERATION_ADDED = "generation_added"
        const val COL_GENERATION_MODIFIED = "generation_modified"

        /** Legacy two-arg form kept for callers/tests; delegates with no generation. */
        internal fun buildBucketSelection(
            selectedBucketIds: Set<String>?,
            sinceDateAddedSec: Long,
        ): Pair<String, Array<String>> = buildSelection(selectedBucketIds, sinceDateAddedSec, null)

        /**
         * Build the MediaStore selection clause and args. Extracted for unit testing.
         *
         * Bucket filter:
         * - `selectedBucketIds == null` → legacy `bucket_display_name IN (CAMERA_BUCKETS)`.
         * - non-null, non-empty → `bucket_id IN (…)`.
         * - empty set → `0 = 1` (matches nothing).
         *
         * Change filter (appended with AND):
         * - generation + mark → `(generation_added > ? OR generation_modified > ? OR date_added >= ?)`
         *   — generation catches adds AND edits on the tracked volume; the date branch
         *   is belt-and-braces for volumes whose generation isn't tracked.
         * - mark only → `date_added >= ?` (byte-identical to the pre-generation builder).
         * - generation only → `(generation_added > ? OR generation_modified > ?)`.
         */
        internal fun buildSelection(
            selectedBucketIds: Set<String>?,
            sinceDateAddedSec: Long,
            sinceGeneration: Long?,
        ): Pair<String, Array<String>> {
            val selection = StringBuilder()
            val args = ArrayList<String>()

            if (selectedBucketIds == null) {
                selection.append("$COL_BUCKET IN (${CAMERA_BUCKETS.joinToString(", ") { "?" }})")
                args.addAll(CAMERA_BUCKETS)
            } else if (selectedBucketIds.isEmpty()) {
                selection.append("0 = 1")
            } else {
                val ids = selectedBucketIds.toList()
                selection.append("$COL_BUCKET_ID IN (${ids.joinToString(", ") { "?" }})")
                args.addAll(ids)
            }

            val dateClause = if (sinceDateAddedSec > 0) "${MediaStore.MediaColumns.DATE_ADDED} >= ?" else null
            val genClause = "$COL_GENERATION_ADDED > ? OR $COL_GENERATION_MODIFIED > ?"
            when {
                sinceGeneration != null && dateClause != null -> {
                    selection.append(" AND ($genClause OR $dateClause)")
                    args.add(sinceGeneration.toString())
                    args.add(sinceGeneration.toString())
                    args.add(sinceDateAddedSec.toString())
                }
                sinceGeneration != null -> {
                    selection.append(" AND ($genClause)")
                    args.add(sinceGeneration.toString())
                    args.add(sinceGeneration.toString())
                }
                dateClause != null -> {
                    selection.append(" AND $dateClause")
                    args.add(sinceDateAddedSec.toString())
                }
            }
            return selection.toString() to args.toTypedArray()
        }
    }
}
