package cr.marin.memoriahub.core.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TokenAuthenticatorTest {

    @Test
    fun `only explicit auth rejections are terminal for the refresh token`() {
        assertTrue(TokenAuthenticator.isTerminalRefreshStatus(401))
        assertTrue(TokenAuthenticator.isTerminalRefreshStatus(403))
    }

    @Test
    fun `server trouble and throttling never condemn the refresh token`() {
        assertFalse(TokenAuthenticator.isTerminalRefreshStatus(429))
        assertFalse(TokenAuthenticator.isTerminalRefreshStatus(500))
        assertFalse(TokenAuthenticator.isTerminalRefreshStatus(502))
        assertFalse(TokenAuthenticator.isTerminalRefreshStatus(503))
        assertFalse(TokenAuthenticator.isTerminalRefreshStatus(504))
    }

    @Test
    fun `extracts rotated refresh token from Set-Cookie`() {
        val headers = listOf("refresh_token=abc123; Path=/api/auth; HttpOnly; SameSite=Lax")
        assertEquals("abc123", TokenAuthenticator.extractRefreshCookie(headers))
    }

    @Test
    fun `picks refresh_token among multiple cookies`() {
        val headers = listOf(
            "session=zzz; Path=/",
            "refresh_token=xyz789; HttpOnly",
        )
        assertEquals("xyz789", TokenAuthenticator.extractRefreshCookie(headers))
    }

    @Test
    fun `returns null when refresh cookie absent`() {
        assertNull(TokenAuthenticator.extractRefreshCookie(listOf("session=zzz; Path=/")))
    }

    @Test
    fun `returns null for empty refresh cookie value`() {
        assertNull(TokenAuthenticator.extractRefreshCookie(listOf("refresh_token=; Path=/api/auth")))
    }
}
