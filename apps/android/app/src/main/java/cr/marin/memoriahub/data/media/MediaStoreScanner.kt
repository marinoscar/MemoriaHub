package cr.marin.memoriahub.data.media

import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import cr.marin.memoriahub.data.db.MediaType
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

data class ScannedMedia(
    val mediaStoreId: Long,
    val contentUri: String,
    val displayName: String,
    val bucket: String?,
    val mimeType: String,
    val type: MediaType,
    val sizeBytes: Long,
    val mtimeMs: Long,
    val dateAddedSec: Long,
    val dateTakenMs: Long?,
)

/**
 * Enumerates camera photos and videos from MediaStore. The [sinceDateAddedSec]
 * high-water mark makes incremental scans cheap; callers should still periodically
 * run a full scan (sinceDateAddedSec = 0) for a complete reconcile.
 */
@Singleton
class MediaStoreScanner @Inject constructor(
    @param:ApplicationContext private val context: Context,
) {
    fun scanCamera(sinceDateAddedSec: Long = 0): List<ScannedMedia> {
        val results = ArrayList<ScannedMedia>()
        results += query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            MediaType.PHOTO,
            sinceDateAddedSec,
        )
        results += query(
            MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
            MediaType.VIDEO,
            sinceDateAddedSec,
        )
        return results
    }

    private fun query(collection: Uri, type: MediaType, sinceDateAddedSec: Long): List<ScannedMedia> {
        val projection = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_ADDED,
            MediaStore.MediaColumns.DATE_MODIFIED,
            MediaStore.MediaColumns.MIME_TYPE,
            COL_DATE_TAKEN,
            COL_BUCKET,
        )

        val (selection, args) = buildBucketSelection(CAMERA_BUCKETS, sinceDateAddedSec)
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
         * MediaStore buckets scanned for backup. Different cameras/devices save
         * captures to different folders: stock Android cameras use DCIM/Camera
         * (bucket "Camera"), some OEMs and the Android emulator save to Pictures
         * or DCIM root. Scanning all three catches the common cases instead of
         * silently missing photos that aren't under DCIM/Camera.
         */
        val CAMERA_BUCKETS = listOf("Camera", "DCIM", "Pictures")

        // Raw column names work across API 26+, avoiding API-gated MediaColumns constants.
        const val COL_DATE_TAKEN = "datetaken"
        const val COL_BUCKET = "bucket_display_name"

        /**
         * Build the MediaStore selection clause and args for the given buckets,
         * optionally bounded by a DATE_ADDED high-water mark. Extracted for unit testing.
         */
        internal fun buildBucketSelection(
            buckets: List<String>,
            sinceDateAddedSec: Long,
        ): Pair<String, Array<String>> {
            val placeholders = buckets.joinToString(", ") { "?" }
            val selection = StringBuilder("$COL_BUCKET IN ($placeholders)")
            val args = ArrayList(buckets)
            if (sinceDateAddedSec > 0) {
                selection.append(" AND ${MediaStore.MediaColumns.DATE_ADDED} >= ?")
                args.add(sinceDateAddedSec.toString())
            }
            return selection.toString() to args.toTypedArray()
        }
    }
}
