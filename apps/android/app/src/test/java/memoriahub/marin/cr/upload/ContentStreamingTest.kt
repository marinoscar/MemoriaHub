package memoriahub.marin.cr.upload

import memoriahub.marin.cr.testing.FakeContentSource
import okio.Buffer
import okio.buffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream

class ContentStreamingTest {
    @Test fun `sha256 is lowercase hex of the exact bytes`() {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ContentHasher.sha256(ByteArrayInputStream("abc".toByteArray())),
        )
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ContentHasher.sha256(ByteArrayInputStream(ByteArray(0))),
        )
    }

    @Test fun `hashing streams in 64 KiB chunks`() {
        val sizes = mutableListOf<Long>()
        ContentHasher.sha256(ByteArrayInputStream(ByteArray(200_000))) { sizes += it }
        assertEquals(listOf(65_536L, 131_072L, 196_608L, 200_000L), sizes)
    }

    @Test fun `the request body streams exactly the range and reopens on every write`() {
        val bytes = FakeContentSource.bytes(100)
        val source = FakeContentSource().put("u", bytes)
        val chunks = mutableListOf<Long>()
        val body = ContentRangeRequestBody(source, "u", offset = 40, length = 30, mediaType = null) { chunks += it }
        assertEquals(30L, body.contentLength())
        repeat(2) {
            val sink = Buffer()
            body.writeTo(sink)
            assertArrayEquals(bytes.copyOfRange(40, 70), sink.readByteArray())
        }
        assertEquals("retry-safe: a fresh stream per write", 2, source.opens)
        assertEquals(listOf(30L, 30L), chunks)
    }

    @Test fun `a file shorter than the range is a truncation, not a network error`() {
        val source = FakeContentSource().put("u", FakeContentSource.bytes(50))
        val body = ContentRangeRequestBody(source, "u", offset = 40, length = 30, mediaType = null)
        try {
            body.writeTo(Buffer())
            fail("expected SourceReadException")
        } catch (e: SourceReadException) {
            assertTrue(e.isTruncated)
        }
    }

    @Test fun `a vanished file and a revoked permission are told apart`() {
        val source = FakeContentSource().apply { missing += "gone"; denied += "denied" }
        try {
            ContentRangeRequestBody(source, "gone", 0, 10, null).writeTo(Buffer())
            fail()
        } catch (e: SourceReadException) {
            assertTrue(e.isMissing)
        }
        try {
            ContentRangeRequestBody(source, "denied", 0, 10, null).writeTo(Buffer())
            fail()
        } catch (e: SourceReadException) {
            assertTrue(e.isPermissionDenied)
        }
    }

    @Test fun `a large range is streamed without buffering the part`() {
        // 64 MiB generated on the fly: the body only ever holds one 64 KiB buffer.
        val size = 64L * 1024 * 1024
        val source = object : ContentSource {
            override fun open(uri: String, offset: Long): InputStream = object : InputStream() {
                var pos = offset
                override fun read(): Int = if (pos >= size) -1 else (pos++ % 251).toInt()
                override fun read(b: ByteArray, off: Int, len: Int): Int {
                    if (pos >= size) return -1
                    val n = minOf(len.toLong(), size - pos).toInt()
                    for (i in 0 until n) b[off + i] = ((pos + i) % 251).toByte()
                    pos += n
                    return n
                }
            }
        }
        var written = 0L
        val counting = object : okio.Sink {
            override fun write(source: Buffer, byteCount: Long) {
                written += byteCount
                source.skip(byteCount)
            }
            override fun flush() = Unit
            override fun timeout() = okio.Timeout.NONE
            override fun close() = Unit
        }
        val sink = counting.buffer()
        ContentRangeRequestBody(source, "big", offset = 1_000, length = size - 1_000, mediaType = null).writeTo(sink)
        sink.flush()
        assertEquals(size - 1_000, written)
    }

    @Test fun `skipFully falls back to reading when skip returns zero`() {
        val stubborn = object : InputStream() {
            var pos = 0
            override fun read(): Int = if (pos >= 10) -1 else pos++
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (pos >= 10) return -1
                val n = minOf(len, 10 - pos)
                for (i in 0 until n) b[off + i] = (pos + i).toByte()
                pos += n
                return n
            }
            override fun skip(n: Long): Long = 0
        }
        stubborn.skipFully(7)
        assertEquals(7, stubborn.read())
    }
}
