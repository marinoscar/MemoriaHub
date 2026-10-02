package memoriahub.marin.cr.upload

import memoriahub.marin.cr.media.MediaGateway
import java.io.InputStream

/**
 * The bytes of one ledger file, opened afresh for every read so a retried part never depends on
 * a stream left over from a failed attempt (docs/specs/android-media-sync.md §9).
 *
 * Implementations must hand out the SAME bytes for the hash and for every part (D24): the
 * engine hashes through [openStream] and uploads through [openRange]. The signatures mirror
 * [MediaGateway]'s, whose `AndroidMediaGateway` applies `setRequireOriginal` consistently to both.
 *
 * A file that no longer exists throws [java.io.FileNotFoundException]; a revoked permission
 * throws [SecurityException]. The engine maps both (§9.5).
 */
interface ContentSource {
    /** The whole file, for hashing. The caller closes it. */
    fun openStream(uri: String): InputStream

    /** The bytes `[offset, offset + length)`, for one part. The caller closes it. */
    fun openRange(uri: String, offset: Long, length: Long): InputStream
}

/** Production [ContentSource]: #510's MediaStore gateway (seeks when it can, D24 URI form). */
class MediaGatewayContentSource(private val gateway: MediaGateway) : ContentSource {
    override fun openStream(uri: String): InputStream = gateway.openStream(uri)

    override fun openRange(uri: String, offset: Long, length: Long): InputStream = gateway.openRange(uri, offset, length)
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
