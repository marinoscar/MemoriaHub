package memoriahub.marin.cr.media

import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.permissions.MediaPermissions
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.InputStream

/** [MediaGateway] over `ContentResolver` (docs/specs/android-media-sync.md §8.3). */
class AndroidMediaGateway(
    context: Context,
    private val sdkInt: Int = Build.VERSION.SDK_INT,
) : MediaGateway {
    private val appContext = context.applicationContext
    private val resolver: ContentResolver = appContext.contentResolver

    override fun volumes(): Set<String> =
        if (sdkInt >= 29) {
            runCatching { MediaStore.getExternalVolumeNames(appContext) }.getOrNull()?.takeIf { it.isNotEmpty() }
                ?: setOf(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        } else {
            setOf(LEGACY_VOLUME)
        }

    override fun currentGeneration(volume: String): Long? =
        if (sdkInt >= 30) runCatching { MediaStore.getGeneration(appContext, volume) }.getOrNull() else null

    override fun mediaStoreVersion(volume: String): String? =
        if (sdkInt >= 30) runCatching { MediaStore.getVersion(appContext, volume) }.getOrNull() else null

    override fun permissionState(): MediaPermissionState = MediaPermissions.state(appContext)

    override fun inventory(): List<Bucket> {
        val aggregator = InventoryAggregator()
        val selection = MediaStoreQueries.inventorySelection(sdkInt)
        for (volume in volumes()) {
            for (isVideo in listOf(false, true)) {
                try {
                    query(collection(volume, isVideo), MediaStoreQueries.inventoryProjection(sdkInt), selection, null)?.use { c ->
                        val bucketId = c.getColumnIndex(MediaStoreQueries.BUCKET_ID)
                        val name = c.getColumnIndex(MediaStoreQueries.BUCKET_DISPLAY_NAME)
                        val path = c.getColumnIndex(if (sdkInt >= 29) MediaStoreQueries.RELATIVE_PATH else MediaStoreQueries.DATA)
                        val size = c.getColumnIndex(MediaStoreQueries.SIZE)
                        while (c.moveToNext()) {
                            val rawPath = c.stringOrNull(path)
                            aggregator.add(
                                bucketId = c.stringOrNull(bucketId),
                                name = c.stringOrNull(name),
                                relativePath = if (sdkInt >= 29) rawPath else RelativePaths.fromData(rawPath),
                                isVideo = isVideo,
                                sizeBytes = c.longOrNull(size) ?: 0L,
                            )
                        }
                    }
                } catch (e: SecurityException) {
                    AppLog.w(TAG, "media.inventory.denied volume=$volume video=$isVideo")
                } catch (e: IllegalArgumentException) {
                    // A volume that disappeared between volumes() and the query (SD card ejected).
                    AppLog.w(TAG, "media.inventory.volume_gone volume=$volume")
                }
            }
        }
        return aggregator.result()
    }

    override fun scan(since: ScanCursor, buckets: Set<String>, includePhotos: Boolean, includeVideos: Boolean): Sequence<MediaRow> {
        if (buckets.isEmpty()) return emptySequence()
        val types = buildList {
            if (includePhotos) add(false)
            if (includeVideos) add(true)
        }
        val chunks = buckets.sorted().chunked(MediaStoreQueries.MAX_BUCKET_ARGS)
        return types.asSequence().flatMap { isVideo -> chunks.asSequence().flatMap { chunk -> scanOne(since, chunk, isVideo) } }
    }

    private fun scanOne(since: ScanCursor, buckets: List<String>, isVideo: Boolean): Sequence<MediaRow> = sequence {
        val selection = MediaStoreQueries.scanSelection(sdkInt, since, buckets) ?: return@sequence
        val collection = collection(since.volume, isVideo)
        val cursor = query(collection, MediaStoreQueries.scanProjection(sdkInt, isVideo), selection, MediaStoreQueries.SCAN_ORDER)
            ?: return@sequence
        cursor.use { c ->
            val id = c.getColumnIndexOrThrow(MediaStoreQueries.ID)
            val name = c.getColumnIndex(MediaStoreQueries.DISPLAY_NAME)
            val mime = c.getColumnIndex(MediaStoreQueries.MIME_TYPE)
            val size = c.getColumnIndex(MediaStoreQueries.SIZE)
            val taken = c.getColumnIndex(MediaStoreQueries.DATE_TAKEN)
            val modified = c.getColumnIndex(MediaStoreQueries.DATE_MODIFIED)
            val bucketId = c.getColumnIndex(MediaStoreQueries.BUCKET_ID)
            val bucketName = c.getColumnIndex(MediaStoreQueries.BUCKET_DISPLAY_NAME)
            val path = c.getColumnIndex(if (sdkInt >= 29) MediaStoreQueries.RELATIVE_PATH else MediaStoreQueries.DATA)
            val generation = c.getColumnIndex(MediaStoreQueries.GENERATION_MODIFIED)
            val duration = c.getColumnIndex(MediaStoreQueries.DURATION)
            while (c.moveToNext()) {
                val mediaStoreId = c.getLong(id)
                val sizeBytes = c.longOrNull(size) ?: 0L
                // Zero-byte rows are placeholders (or broken files): nothing to upload.
                if (sizeBytes <= 0L) continue
                val rawPath = c.stringOrNull(path)
                val displayName = c.stringOrNull(name)?.takeIf { it.isNotBlank() } ?: "media-$mediaStoreId"
                yield(
                    MediaRow(
                        mediaStoreId = mediaStoreId,
                        volume = since.volume,
                        uri = ContentUris.withAppendedId(collection, mediaStoreId).toString(),
                        displayName = displayName,
                        relativePath = if (sdkInt >= 29) rawPath else RelativePaths.fromData(rawPath),
                        bucketId = c.stringOrNull(bucketId),
                        bucketName = c.stringOrNull(bucketName),
                        mimeType = c.stringOrNull(mime)?.takeIf { it.isNotBlank() } ?: DEFAULT_MIME,
                        isVideo = isVideo,
                        sizeBytes = sizeBytes,
                        dateTakenMs = c.longOrNull(taken)?.takeIf { it > 0 },
                        dateModifiedSec = c.longOrNull(modified) ?: 0L,
                        generationModified = if (generation >= 0) c.longOrNull(generation) else null,
                        durationMs = if (duration >= 0) c.longOrNull(duration) else null,
                    ),
                )
            }
        }
    }

    override fun openStream(uri: String): InputStream = withReadableUri(uri) { resolved ->
        resolver.openInputStream(resolved) ?: throw FileNotFoundException("no stream for $uri")
    }

    override fun openRange(uri: String, offset: Long, length: Long): InputStream = withReadableUri(uri) { resolved ->
        // A seekable descriptor avoids reading `offset` bytes; providers without one fall back to skip.
        val pfd = runCatching { resolver.openFileDescriptor(resolved, "r") }.getOrNull()
        if (pfd != null) {
            val input = ParcelFileInputStream(pfd)
            try {
                input.channel.position(offset)
            } catch (e: Exception) {
                input.close()
                throw e
            }
            BoundedInputStream(input, length)
        } else {
            val input = resolver.openInputStream(resolved) ?: throw FileNotFoundException("no stream for $uri")
            RangeStreams.range(input, offset, length)
        }
    }

    /**
     * D24: photos and videos are read through `setRequireOriginal` when `ACCESS_MEDIA_LOCATION` is
     * granted (the plain URI returns location-redacted bytes: EXIF GPS in photos, the location atom
     * in videos); when that form throws, the plain URI is used. Both [openStream] and [openRange] go
     * through here, so the hash and the upload always agree.
     */
    private fun <T> withReadableUri(uri: String, open: (Uri) -> T): T {
        val plain = Uri.parse(uri)
        if (!wantsOriginal(plain)) return open(plain)
        val original = runCatching { MediaStore.setRequireOriginal(plain) }.getOrNull() ?: return open(plain)
        return try {
            open(original)
        } catch (e: SecurityException) {
            open(plain)
        } catch (e: UnsupportedOperationException) {
            open(plain)
        }
    }

    private fun wantsOriginal(uri: Uri): Boolean =
        OriginalReads.wantsOriginal(
            sdkInt = sdkInt,
            authority = uri.authority,
            pathSegments = uri.pathSegments,
            locationGranted = sdkInt >= OriginalReads.MIN_SDK &&
                ContextCompat.checkSelfPermission(appContext, MediaPermissions.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED,
        )

    private fun collection(volume: String, isVideo: Boolean): Uri = when {
        sdkInt >= 29 && isVideo -> MediaStore.Video.Media.getContentUri(volume)
        sdkInt >= 29 -> MediaStore.Images.Media.getContentUri(volume)
        isVideo -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        else -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    }

    private fun query(uri: Uri, projection: Array<String>, selection: Selection?, order: String?): Cursor? =
        resolver.query(uri, projection, selection?.sql, selection?.args?.toTypedArray(), order)

    private fun Cursor.stringOrNull(index: Int): String? = if (index < 0 || isNull(index)) null else getString(index)

    private fun Cursor.longOrNull(index: Int): Long? = if (index < 0 || isNull(index)) null else getLong(index)

    /** Closes the descriptor together with the stream. */
    private class ParcelFileInputStream(private val pfd: android.os.ParcelFileDescriptor) : FileInputStream(pfd.fileDescriptor) {
        override fun close() {
            try {
                super.close()
            } finally {
                pfd.close()
            }
        }
    }

    companion object {
        private const val TAG = "Media"
        const val LEGACY_VOLUME = "external"
        const val DEFAULT_MIME = "application/octet-stream"
    }
}
