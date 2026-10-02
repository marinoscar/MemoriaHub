package memoriahub.marin.cr.upload

import java.io.InputStream
import java.security.MessageDigest

/**
 * Streaming SHA-256 of a file's bytes (docs/specs/android-media-sync.md §9.1 step 1): a 64 KiB
 * buffer, never the whole file in memory. The lowercase hex digest is the API's `contentHash`
 * (`createMediaSchema` accepts 64 hex characters) and keys the circle-scoped dedup pre-check.
 */
object ContentHasher {
    const val BUFFER_SIZE = 64 * 1024

    /**
     * Hashes [uri] through [source] (the same URI form the upload reads, D24).
     * [onProgress] receives the running byte count after every buffer, for progress and for
     * cooperative cancellation (it may throw to abort).
     */
    fun sha256(source: ContentSource, uri: String, onProgress: (Long) -> Unit = {}): String =
        source.openStream(uri).use { sha256(it, onProgress) }

    fun sha256(input: InputStream, onProgress: (Long) -> Unit = {}): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(BUFFER_SIZE)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            if (read == 0) continue
            digest.update(buffer, 0, read)
            total += read
            onProgress(total)
        }
        return toHex(digest.digest())
    }

    fun toHex(bytes: ByteArray): String {
        val chars = CharArray(bytes.size * 2)
        bytes.forEachIndexed { i, b ->
            val v = b.toInt() and 0xFF
            chars[i * 2] = HEX[v ushr 4]
            chars[i * 2 + 1] = HEX[v and 0x0F]
        }
        return String(chars)
    }

    private val HEX = "0123456789abcdef".toCharArray()
}
