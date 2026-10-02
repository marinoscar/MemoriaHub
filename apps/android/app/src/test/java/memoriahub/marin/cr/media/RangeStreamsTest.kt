package memoriahub.marin.cr.media

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.EOFException
import java.io.InputStream

class RangeStreamsTest {
    private val data = ByteArray(1_000) { it.toByte() }

    /** A provider stream whose skip() never skips (some content providers). */
    private class NoSkip(bytes: ByteArray) : InputStream() {
        private val inner = ByteArrayInputStream(bytes)
        override fun read(): Int = inner.read()
        override fun read(b: ByteArray, off: Int, len: Int): Int = inner.read(b, off, len)
        override fun skip(n: Long): Long = 0
    }

    @Test fun `range returns exactly offset to offset plus length`() {
        val out = RangeStreams.range(ByteArrayInputStream(data), 100, 50).readBytes()
        assertArrayEquals(data.copyOfRange(100, 150), out)
    }

    @Test fun `skip falls back to read when skip returns 0`() {
        val out = RangeStreams.range(NoSkip(data), 990, 100).readBytes()
        assertArrayEquals(data.copyOfRange(990, 1_000), out)
    }

    @Test fun `offset beyond the end is an EOF`() {
        try {
            RangeStreams.range(NoSkip(data), 2_000, 1)
            fail("expected EOF")
        } catch (_: EOFException) {
        }
    }

    @Test fun `bounded stream single-byte reads and skip respect the limit`() {
        val s = BoundedInputStream(ByteArrayInputStream(data), 3)
        assertEquals(0, s.read())
        assertEquals(1, s.skip(1))
        assertEquals(2, s.read())
        assertEquals(0, s.skip(10))
        assertEquals(-1, s.read())
        assertEquals(-1, s.read(ByteArray(4), 0, 4))
    }
}
