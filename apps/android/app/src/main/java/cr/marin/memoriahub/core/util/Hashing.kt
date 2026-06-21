package cr.marin.memoriahub.core.util

import java.io.InputStream
import java.security.MessageDigest

/** Streams SHA-256 over [input], returning lowercase hex (matches the API's contentHash). */
fun sha256Hex(input: InputStream): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(64 * 1024)
    input.use { stream ->
        while (true) {
            val read = stream.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}
