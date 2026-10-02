package memoriahub.marin.cr.media

import java.io.EOFException
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream

/** Byte-range helpers for content streams (pure JVM; the legacy `ContentUriRequestBody` lessons). */
object RangeStreams {
    /**
     * Skips exactly [count] bytes, falling back to `read()` when `skip()` returns 0 (some content
     * providers never skip). Throws [EOFException] when the stream ends first.
     */
    fun skipFully(input: InputStream, count: Long) {
        var remaining = count
        while (remaining > 0) {
            val skipped = input.skip(remaining)
            if (skipped > 0) {
                remaining -= skipped
                continue
            }
            if (input.read() < 0) throw EOFException("stream ended $remaining bytes before offset $count")
            remaining--
        }
    }

    /** [input] positioned at [offset] and limited to [length] bytes; closing it closes [input]. */
    fun range(input: InputStream, offset: Long, length: Long): InputStream {
        require(offset >= 0 && length >= 0) { "offset and length must be >= 0" }
        try {
            skipFully(input, offset)
        } catch (e: IOException) {
            input.close()
            throw e
        }
        return BoundedInputStream(input, length)
    }
}

/** Reads at most [limit] bytes of [input]. */
class BoundedInputStream(input: InputStream, private val limit: Long) : FilterInputStream(input) {
    private var remaining = limit

    override fun read(): Int {
        if (remaining <= 0) return -1
        val b = super.read()
        if (b >= 0) remaining--
        return b
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (remaining <= 0) return -1
        val n = super.read(b, off, minOf(len.toLong(), remaining).toInt())
        if (n > 0) remaining -= n
        return n
    }

    override fun skip(n: Long): Long {
        val skipped = super.skip(minOf(n, remaining))
        if (skipped > 0) remaining -= skipped
        return skipped
    }

    override fun available(): Int = minOf(super.available().toLong(), remaining).toInt()

    override fun markSupported(): Boolean = false
}
