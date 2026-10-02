package memoriahub.marin.cr.auth

import memoriahub.marin.cr.testing.FakeSharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.UUID

class SharedPrefsTokenStoreTest {
    @Test fun `stores and clears pairing state but keeps the installation id`() {
        val store = SharedPrefsTokenStore(FakeSharedPreferences())
        val installationId = store.installationId
        UUID.fromString(installationId) // valid UUID
        assertEquals(installationId, store.installationId)
        assertFalse(store.isPaired)

        val expiry = Instant.parse("2026-12-30T00:00:00Z")
        store.setToken("pat_abc", expiry)
        store.setDeviceId("dev-1")
        assertTrue(store.isPaired)
        assertEquals("pat_abc", store.token)
        assertEquals(expiry, store.expiresAt)
        assertEquals("dev-1", store.deviceId)

        store.clear()
        assertFalse(store.isPaired)
        assertNull(store.expiresAt)
        assertNull(store.deviceId)
        assertEquals(installationId, store.installationId)
    }

    @Test fun `the installation id is generated once and shared by every store over the same prefs`() {
        val prefs = FakeSharedPreferences()
        val first = SharedPrefsTokenStore(prefs).installationId
        SharedPrefsTokenStore(prefs).clear()
        assertEquals(first, SharedPrefsTokenStore(prefs).installationId)
        assertTrue(first != SharedPrefsTokenStore(FakeSharedPreferences()).installationId)
    }

    @Test fun `a token without an expiry clears a previous expiry`() {
        val store = SharedPrefsTokenStore(FakeSharedPreferences())
        store.setToken("pat_one", Instant.parse("2026-12-30T00:00:00Z"))
        store.setToken("pat_two", null)
        assertEquals("pat_two", store.token)
        assertNull(store.expiresAt)
    }

    @Test fun `an unreadable stored expiry reads as null`() {
        val prefs = FakeSharedPreferences()
        prefs.edit().putString(SharedPrefsTokenStore.KEY_EXPIRES_AT, "not-a-date").commit()
        assertNull(SharedPrefsTokenStore(prefs).expiresAt)
    }

    @Test fun `an empty token is not paired and a null device id removes it`() {
        val store = SharedPrefsTokenStore(FakeSharedPreferences())
        store.setToken("", null)
        assertFalse(store.isPaired)
        store.setDeviceId("dev-1")
        store.setDeviceId(null)
        assertNull(store.deviceId)
    }
}
