package memoriahub.marin.cr.upload

import okhttp3.MediaType
import okhttp3.RequestBody
import okio.BufferedSink
import java.io.EOFException
import java.io.FileNotFoundException
import java.io.IOException

/**
 * Thrown from inside [ContentRangeRequestBody.writeTo] when the FILE (not the network) failed:
 * the source vanished, the permission was revoked, or it ended early. OkHttp surfaces it from
 * `execute()`, and the engine tells it apart from a network failure by this type (§9.5).
 */
class SourceReadException(message: String, cause: Throwable) : IOException(message, cause) {
    /** The file no longer exists ([FileNotFoundException]). */
    val isMissing: Boolean get() = cause is FileNotFoundException

    /** The media permission was revoked ([SecurityException]). */
    val isPermissionDenied: Boolean get() = cause is SecurityException

    /** The file is shorter than the ledger says: it changed since it was scanned. */
    val isTruncated: Boolean get() = cause is EOFException
}

/**
 * One multipart part, streamed from [source] (docs/specs/android-media-sync.md §9.1 step 4).
 *
 * - **Retry-safe:** every [writeTo] reopens the stream, so OkHttp can replay the body after a
 *   connection failure without depending on a half-consumed stream.
 * - **Constant memory:** the stream is positioned at [offset] by the source (seek or skip) and
 *   exactly [length] bytes are copied 64 KiB at a time. There is no part buffer.
 * - [contentLength] is [length], so S3 gets the `Content-Length` its presigned PUT requires.
 * - [onBytes] receives each chunk's size as it is written (progress); it must be cheap.
 */
class ContentRangeRequestBody(
    private val source: ContentSource,
    private val uri: String,
    private val offset: Long,
    private val length: Long,
    private val mediaType: MediaType?,
    private val onBytes: (Long) -> Unit = {},
) : RequestBody() {
    override fun contentType(): MediaType? = mediaType

    override fun contentLength(): Long = length

    override fun writeTo(sink: BufferedSink) {
        val input = try {
            source.openRange(uri, offset, length)
        } catch (e: IOException) {
            throw SourceReadException("Could not open the file", e)
        } catch (e: SecurityException) {
            throw SourceReadException("Permission to read the file was revoked", e)
        } catch (e: RuntimeException) {
            throw SourceReadException("Could not open the file", e)
        }
        input.use { stream ->
            val buffer = ByteArray(ContentHasher.BUFFER_SIZE)
            var remaining = length
            while (remaining > 0) {
                val read = try {
                    stream.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                } catch (e: IOException) {
                    throw SourceReadException("Could not read the file", e)
                } catch (e: SecurityException) {
                    throw SourceReadException("Permission to read the file was revoked", e)
                }
                if (read < 0) {
                    throw SourceReadException(
                        "The file ended $remaining bytes early",
                        EOFException("Expected $length bytes from offset $offset"),
                    )
                }
                if (read == 0) continue
                sink.write(buffer, 0, read)
                remaining -= read
                onBytes(read.toLong())
            }
        }
    }
}
