package cr.marin.memoriahub.data.remote

import android.content.ContentResolver
import android.net.Uri
import okhttp3.MediaType
import okhttp3.RequestBody
import okio.BufferedSink
import java.io.IOException
import kotlin.math.min

/**
 * Streams a byte range [offset, offset+length) of a content URI directly to the
 * network sink without buffering the whole part in memory — required for large
 * 4K videos. Re-opens the stream on every [writeTo] so OkHttp can safely retry.
 */
class ContentUriRequestBody(
    private val resolver: ContentResolver,
    private val uri: Uri,
    private val offset: Long,
    private val length: Long,
    private val mediaType: MediaType?,
) : RequestBody() {

    override fun contentType(): MediaType? = mediaType

    override fun contentLength(): Long = length

    override fun writeTo(sink: BufferedSink) {
        val input = resolver.openInputStream(uri) ?: throw IOException("Cannot open $uri")
        input.use { stream ->
            var toSkip = offset
            while (toSkip > 0) {
                val skipped = stream.skip(toSkip)
                if (skipped <= 0) {
                    if (stream.read() < 0) throw IOException("Unexpected EOF skipping to offset")
                    toSkip--
                } else {
                    toSkip -= skipped
                }
            }
            val buffer = ByteArray(64 * 1024)
            var remaining = length
            while (remaining > 0) {
                val toRead = min(buffer.size.toLong(), remaining).toInt()
                val read = stream.read(buffer, 0, toRead)
                if (read < 0) break
                sink.write(buffer, 0, read)
                remaining -= read
            }
        }
    }
}
