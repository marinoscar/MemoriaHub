package memoriahub.marin.cr.upload

import kotlinx.coroutines.runBlocking
import memoriahub.marin.cr.testing.FakeContentSource
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PartUploaderTest {
    private val own = MockWebServer()
    private val foreign = MockWebServer()
    private val source = FakeContentSource().put("u", FakeContentSource.bytes(20))

    @Before fun setUp() {
        own.start()
        foreign.start()
    }

    @After fun tearDown() {
        own.shutdown()
        foreign.shutdown()
    }

    private fun uploader() = PartUploader(serverBaseUrl = { own.url("/").toString() }, tokenProvider = { "pat_secret" })

    @Test fun `bearer parts on the own origin carry the token and the quoted ETag comes back`() = runBlocking {
        own.enqueue(MockResponse().setHeader("ETag", "\"abc\""))
        val result = uploader().put(own.url("/api/storage/objects/o/upload/parts/1").toString(), PartUploadAuth.BEARER, source, "u", 0, 10)
        assertEquals(PartPutResult.Uploaded("\"abc\"", 10), result)
        val request = own.takeRequest()
        assertEquals("Bearer pat_secret", request.getHeader("Authorization"))
        assertEquals("application/octet-stream", request.getHeader("Content-Type"))
        assertEquals("10", request.getHeader("Content-Length"))
    }

    @Test fun `presigned parts never carry the token`() = runBlocking {
        own.enqueue(MockResponse().setHeader("ETag", "\"e\""))
        uploader().put(own.url("/bucket/o/1?X-Amz-Signature=x").toString(), PartUploadAuth.NONE, source, "u", 0, 10)
        assertNull(own.takeRequest().getHeader("Authorization"))
    }

    @Test fun `bearer parts on another origin are sent without the token`() = runBlocking {
        foreign.enqueue(MockResponse().setHeader("ETag", "\"e\""))
        uploader().put(foreign.url("/api/storage/objects/o/upload/parts/1").toString(), PartUploadAuth.BEARER, source, "u", 0, 10)
        assertNull(foreign.takeRequest().getHeader("Authorization"))
    }

    @Test fun `origin comparison covers scheme, host and port`() {
        val up = PartUploader(serverBaseUrl = { "https://photos.example.com" }, tokenProvider = { "t" })
        assertTrue(up.isOwnServer("https://photos.example.com/api/x".toHttpUrl()))
        assertTrue(up.isOwnServer("https://PHOTOS.example.com:443/api/x".toHttpUrl()))
        assertFalse(up.isOwnServer("http://photos.example.com/api/x".toHttpUrl()))
        assertFalse(up.isOwnServer("https://photos.example.com:8443/api/x".toHttpUrl()))
        assertFalse(up.isOwnServer("https://photos.example.com.evil.net/api/x".toHttpUrl()))
        assertFalse(PartUploader({ null }, { "t" }).isOwnServer("https://photos.example.com/".toHttpUrl()))
    }

    @Test fun `a 2xx without an ETag and an HTTP error are reported`() = runBlocking {
        own.enqueue(MockResponse())
        own.enqueue(MockResponse().setResponseCode(503).setHeader("Retry-After", "7"))
        val url = own.url("/bucket/o/1").toString()
        assertEquals(PartPutResult.MissingETag, uploader().put(url, null, source, "u", 0, 10))
        val error = uploader().put(url, null, source, "u", 0, 10) as PartPutResult.Http
        assertEquals(503, error.status)
        assertEquals(7L, error.retryAfterSeconds)
    }

    @Test fun `a vanished file is a source error, not a network error`() = runBlocking {
        own.enqueue(MockResponse().setHeader("ETag", "\"e\""))
        source.missing += "u"
        val result = uploader().put(own.url("/bucket/o/1").toString(), null, source, "u", 0, 10)
        assertTrue("got $result", result is PartPutResult.Source && result.error.isMissing)
    }
}
