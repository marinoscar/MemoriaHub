package memoriahub.marin.cr.upload

import android.Manifest
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * The bytes of one ledger file, opened afresh for every read so a retried part never depends on
 * a stream left over from a failed attempt (docs/specs/android-media-sync.md §9).
 *
 * Implementations must hand out the SAME bytes for the hash and for every part (D24): the
 * engine hashes through [open] at offset 0 and uploads through [open] at each part's offset.
 *
 * A file that no longer exists throws [java.io.FileNotFoundException]; a revoked permission
 * throws [SecurityException]. The engine maps both (§9.5).
 */
interface ContentSource {
    /** A new stream over [uri] positioned at [offset]. The caller closes it. */
    fun open(uri: String, offset: Long = 0): InputStream
}

/**
 * Skips exactly [count] bytes. `InputStream.skip` may legitimately return 0 (some content
 * providers' streams), so this falls back to reading; an early end of stream throws.
 */
fun InputStream.skipFully(count: Long) {
    var remaining = count
    val scratch = ByteArray(8 * 1024)
    while (remaining > 0) {
        val skipped = skip(remaining)
        if (skipped > 0) {
            remaining -= skipped
            continue
        }
        val read = read(scratch, 0, minOf(scratch.size.toLong(), remaining).toInt())
        if (read < 0) throw java.io.EOFException("End of file $remaining bytes before offset $count")
        remaining -= read
    }
}

/**
 * [ContentSource] over the [ContentResolver].
 *
 * - **Same URI form for hash and upload (D24).** When `ACCESS_MEDIA_LOCATION` is granted (API
 *   29+) the photo is opened through `MediaStore.setRequireOriginal`, which returns the bytes
 *   with GPS intact; the plain URI would hand out redacted bytes and a different SHA-256. If
 *   the original cannot be opened, the plain URI is used, and that choice is remembered per
 *   URI for the life of this source so the hash and every part read the same form.
 * - **Seek, not read, to the part offset.** A seekable descriptor is positioned with
 *   `FileChannel.position`; anything else falls back to [skipFully]. No part buffer: the
 *   request body streams 64 KiB at a time.
 */
class AndroidContentSource(context: Context) : ContentSource {
    private val app = context.applicationContext
    private val resolver: ContentResolver = app.contentResolver

    /** URIs whose original form failed to open; they use the plain URI from then on. */
    private val plainOnly = ConcurrentHashMap.newKeySet<String>()

    override fun open(uri: String, offset: Long): InputStream {
        val plain = Uri.parse(uri)
        val original = originalFormOrNull(plain)
        if (original != null && uri !in plainOnly) {
            try {
                return openAt(original, offset)
            } catch (e: UnsupportedOperationException) {
                plainOnly += uri
            } catch (e: SecurityException) {
                plainOnly += uri
            }
        }
        return openAt(plain, offset)
    }

    private fun openAt(uri: Uri, offset: Long): InputStream {
        val afd = resolver.openAssetFileDescriptor(uri, "r")
        if (afd != null) {
            val stream = afd.createInputStream()
            if (offset > 0) {
                val positioned = (stream as? FileInputStream)?.let { fis ->
                    runCatching { fis.channel.position(fis.channel.position() + offset) }.isSuccess
                } ?: false
                if (!positioned) stream.skipFully(offset)
            }
            return stream
        }
        val stream = resolver.openInputStream(uri) ?: throw IOException("The content provider returned no stream")
        if (offset > 0) stream.skipFully(offset)
        return stream
    }

    private fun originalFormOrNull(uri: Uri): Uri? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        if (app.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) != PackageManager.PERMISSION_GRANTED) return null
        return runCatching { MediaStore.setRequireOriginal(uri) }.getOrNull()
    }
}
