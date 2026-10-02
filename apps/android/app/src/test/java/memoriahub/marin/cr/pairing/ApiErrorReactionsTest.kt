package memoriahub.marin.cr.pairing

import memoriahub.marin.cr.auth.SharedPrefsTokenStore
import memoriahub.marin.cr.net.ApiClient
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.testing.FakeNotifier
import memoriahub.marin.cr.testing.FakeScheduler
import memoriahub.marin.cr.testing.FakeSharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class ApiErrorReactionsTest {
    private val tokens = SharedPrefsTokenStore(FakeSharedPreferences())
    private val state = SharedPrefsPairingStateStore(FakeSharedPreferences())
    private val scheduler = FakeScheduler()
    private val notifier = FakeNotifier()
    private val reactions = ApiErrorReactions(tokens, state, { scheduler }, notifier)

    private fun paired() {
        tokens.setToken("pat_x", Instant.parse("2027-01-01T00:00:00Z"))
        tokens.setDeviceId("dev-1")
        state.pairedAt = Instant.parse("2026-10-01T00:00:00Z")
    }

    @Test fun `401 marks the pairing expired and notifies once per expiry`() {
        paired()
        val unauthorized = ApiClient.parseError(401, """{"statusCode":401,"code":"UNAUTHORIZED","message":"Invalid token"}""")
        assertEquals(ApiErrorReaction.PAIRING_EXPIRED, reactions.handle(unauthorized))
        assertEquals(ApiErrorReaction.PAIRING_EXPIRED, reactions.handle(unauthorized))
        assertTrue(state.pairingExpired)
        assertEquals("posted only on the transition", 1, notifier.expiredPosted)
        // The token stays (diagnostics describe it; Connect offers Re-pair); no work is cancelled.
        assertEquals("pat_x", tokens.token)
        assertEquals(0, scheduler.cancelled)
        val status = PairingStatus.read(tokens, state, Instant.parse("2026-10-02T00:00:00Z"))
        assertTrue(status.expired)
        assertFalse(status.paired)
    }

    @Test fun `401 with no stored token neither flags nor notifies`() {
        reactions.handle(ApiError(ApiError.Kind.HTTP, 401, message = "x"))
        assertFalse(state.pairingExpired)
        assertEquals(0, notifier.expiredPosted)
    }

    @Test fun `409 DEVICE_REVOKED forgets the pairing but keeps the installation id`() {
        paired()
        val installation = tokens.installationId
        state.pairingExpired = true
        val revoked = ApiClient.parseError(
            409,
            """{"statusCode":409,"code":"CONFLICT","message":"Device revoked","details":{"reason":"DEVICE_REVOKED"}}""",
        )
        val result = reactions.check(ApiResult.Failure(revoked))
        assertTrue(result is ApiResult.Failure)
        assertNull(tokens.token)
        assertNull(tokens.deviceId)
        assertNull(tokens.expiresAt)
        assertEquals(installation, tokens.installationId)
        assertFalse(state.pairingExpired)
        assertNull(state.pairedAt)
        assertEquals(1, scheduler.cancelled)
        assertEquals(1, notifier.cancelled)
    }

    @Test fun `other errors are left to the caller`() {
        paired()
        val other409 = ApiError(ApiError.Kind.HTTP, 409, message = "x", reason = "UPLOAD_PARTS_MISSING")
        assertEquals(ApiErrorReaction.NONE, reactions.handle(other409))
        assertEquals(ApiErrorReaction.NONE, reactions.handle(ApiError(ApiError.Kind.HTTP, 404, message = "x")))
        assertEquals(ApiErrorReaction.NONE, reactions.handle(ApiError(ApiError.Kind.NETWORK, message = "x")))
        assertEquals(ApiErrorReaction.NONE, reactions.handle(ApiError(ApiError.Kind.HTTP, 500, message = "x")))
        assertEquals("pat_x", tokens.token)
        assertFalse(state.pairingExpired)
        assertEquals(0, scheduler.cancelled)
    }

    @Test fun `check passes successes through untouched`() {
        paired()
        val ok = ApiResult.Success("x", 200)
        assertEquals(ok, reactions.check(ok))
        assertEquals("pat_x", tokens.token)
    }

    @Test fun `status treats a passed token expiry as expired`() {
        paired()
        assertTrue(PairingStatus.read(tokens, state, Instant.parse("2026-12-31T00:00:00Z")).paired)
        assertTrue(PairingStatus.read(tokens, state, Instant.parse("2027-01-02T00:00:00Z")).expired)
    }
}
