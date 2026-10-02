package memoriahub.marin.cr.upload

import memoriahub.marin.cr.net.ApiError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UploadErrorPolicyTest {
    private fun http(status: Int, reason: String? = null) = ApiError(ApiError.Kind.HTTP, status, message = "x", reason = reason)

    @Test fun `network and transient HTTP errors are retryable`() {
        assertEquals(UploadDecision.Retry("NETWORK_ERROR", network = true), UploadErrorPolicy.classify(ApiError(ApiError.Kind.NETWORK, message = "x"), UploadStep.INIT))
        for (status in listOf(408, 429, 500, 502, 503)) {
            assertEquals(UploadDecision.Retry("HTTP_$status"), UploadErrorPolicy.classify(http(status), UploadStep.INIT))
        }
        assertEquals(UploadDecision.Retry("BAD_RESPONSE"), UploadErrorPolicy.classify(ApiError(ApiError.Kind.PARSE, 200, message = "x"), UploadStep.INIT))
    }

    @Test fun `run-wide stops`() {
        assertEquals(UploadDecision.StopRun(UploadStopReason.PAIRING_EXPIRED), UploadErrorPolicy.classify(http(401), UploadStep.PART_PUT))
        assertEquals(UploadDecision.StopRun(UploadStopReason.DEVICE_REVOKED), UploadErrorPolicy.classify(http(409, "DEVICE_REVOKED"), UploadStep.REGISTER))
        assertEquals(UploadDecision.StopRun(UploadStopReason.TARGET_CIRCLE_FORBIDDEN), UploadErrorPolicy.classify(http(403, "TARGET_CIRCLE_FORBIDDEN"), UploadStep.REGISTER))
        assertEquals(UploadDecision.StopRun(UploadStopReason.TARGET_CIRCLE_FORBIDDEN), UploadErrorPolicy.classify(http(403), UploadStep.DEDUP_CHECK))
        assertEquals(UploadDecision.StopRun(UploadStopReason.UNKNOWN_SOURCE_DEVICE), UploadErrorPolicy.classify(http(400, "UNKNOWN_SOURCE_DEVICE"), UploadStep.REGISTER))
        assertEquals(UploadDecision.StopRun(UploadStopReason.SERVER_UNREACHABLE), UploadErrorPolicy.classify(ApiError(ApiError.Kind.NOT_CONFIGURED, message = "x"), UploadStep.INIT))
    }

    @Test fun `session problems reset the session`() {
        assertEquals(UploadDecision.ResetSession, UploadErrorPolicy.classify(http(409, "UPLOAD_SESSION_INVALID"), UploadStep.COMPLETE))
        assertEquals(UploadDecision.ResetSession, UploadErrorPolicy.classify(http(409), UploadStep.COMPLETE)) // D18
        assertEquals(UploadDecision.ResetSession, UploadErrorPolicy.classify(http(404), UploadStep.STATUS))
        assertEquals(UploadDecision.ResetSession, UploadErrorPolicy.classify(http(403), UploadStep.STATUS))
        assertEquals(UploadDecision.ResetSession, UploadErrorPolicy.classify(http(404), UploadStep.PART_URLS))
        assertEquals(UploadDecision.ResetSession, UploadErrorPolicy.classify(http(400), UploadStep.PART_URLS))
        assertEquals(UploadDecision.ResetSession, UploadErrorPolicy.classify(http(400, "UPLOAD_NOT_ACTIVE"), UploadStep.PART_PUT))
        assertEquals(UploadDecision.ResetSession, UploadErrorPolicy.classify(http(404), UploadStep.REGISTER))
    }

    @Test fun `validation errors block`() {
        assertEquals(UploadDecision.Block("HTTP_400"), UploadErrorPolicy.classify(http(400), UploadStep.INIT))
        assertEquals(UploadDecision.Block("HTTP_413"), UploadErrorPolicy.classify(http(413), UploadStep.INIT))
        assertEquals(UploadDecision.Block("PART_SIZE_MISMATCH"), UploadErrorPolicy.classify(http(400, "PART_SIZE_MISMATCH"), UploadStep.PART_PUT))
        assertEquals(UploadDecision.Block("HTTP_400"), UploadErrorPolicy.classify(http(400), UploadStep.REGISTER))
    }

    @Test fun `storage part errors`() {
        assertEquals(UploadDecision.ResetSession, UploadErrorPolicy.classifyStoragePut(404))
        assertEquals(UploadDecision.Retry("STORAGE_FORBIDDEN"), UploadErrorPolicy.classifyStoragePut(403))
        assertEquals(UploadDecision.Retry("STORAGE_HTTP_503"), UploadErrorPolicy.classifyStoragePut(503))
    }

    @Test fun `stop reasons carry the run error codes`() {
        assertEquals("NETWORK_POLICY", UploadStopReason.NETWORK_POLICY.errorCode)
        assertEquals("PAIRING_EXPIRED", UploadStopReason.PAIRING_EXPIRED.errorCode)
        assertEquals("DEVICE_REVOKED", UploadStopReason.DEVICE_REVOKED.errorCode)
        assertEquals("TARGET_CIRCLE_FORBIDDEN", UploadStopReason.TARGET_CIRCLE_FORBIDDEN.errorCode)
        assertNull(UploadStopReason.STOPPED.errorCode)
    }

    @Test fun `backoff schedule is 30s, 2m, 10m, 1h, then blocked`() {
        assertEquals(30_000L, UploadBackoff.delayMs(1))
        assertEquals(120_000L, UploadBackoff.delayMs(2))
        assertEquals(600_000L, UploadBackoff.delayMs(3))
        assertEquals(3_600_000L, UploadBackoff.delayMs(4))
        assertNull(UploadBackoff.delayMs(5))
        assertFalse(UploadBackoff.blocks(4))
        assertTrue(UploadBackoff.blocks(5))
    }

    @Test fun `Retry-After raises the delay but is capped at an hour`() {
        assertEquals(90_000L, UploadBackoff.delayMs(1, retryAfterMs = 90_000))
        assertEquals(120_000L, UploadBackoff.delayMs(2, retryAfterMs = 1_000))
        assertEquals(3_600_000L, UploadBackoff.delayMs(1, retryAfterMs = 99_000_000))
    }

    @Test fun `source path joins relative path and name`() {
        assertEquals("DCIM/Camera/IMG_1.jpg", UploadEngine.sourcePath("DCIM/Camera/", "IMG_1.jpg"))
        assertEquals("IMG_1.jpg", UploadEngine.sourcePath(null, "IMG_1.jpg"))
        assertEquals("IMG_1.jpg", UploadEngine.sourcePath("  ", "IMG_1.jpg"))
    }
}
