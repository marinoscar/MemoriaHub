package memoriahub.marin.cr.update

import kotlinx.coroutines.runBlocking
import memoriahub.marin.cr.contract.AvailableUpdate
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.testing.FakeReleaseApi
import memoriahub.marin.cr.testing.FakeSharedPreferences
import memoriahub.marin.cr.testing.PACKAGE
import memoriahub.marin.cr.testing.httpFailure
import memoriahub.marin.cr.testing.networkFailure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Duration
import java.time.Instant

class UpdateTest {
    private var now = Instant.parse("2026-10-01T12:00:00Z")
    private var paired = true
    private val api = FakeReleaseApi()
    private val store = InMemoryUpdateStore()
    private val opened = mutableListOf<String>()
    private var browser = true
    private val failures = mutableListOf<ApiError>()

    private fun checker(versionCode: Long = 100) = UpdateChecker(
        api = api,
        store = store,
        ownPackage = PACKAGE,
        ownVersionCode = versionCode,
        isPaired = { paired },
        serverUrl = { "https://photos.example" },
        openUrl = { opened += it; browser },
        onApiFailure = { failures += it },
        clock = { now },
    )

    // --- policy ----------------------------------------------------------------------------

    @Test fun `check is due after 12 hours, never before, and when the clock goes back`() {
        val t = now
        assertTrue(UpdatePolicy.checkDue(null, t))
        assertFalse(UpdatePolicy.checkDue(t, t.plus(Duration.ofHours(11))))
        assertTrue(UpdatePolicy.checkDue(t, t.plus(Duration.ofHours(12))))
        assertTrue(UpdatePolicy.checkDue(t, t.minusSeconds(1)))
    }

    @Test fun `isUpdate needs the same package and a strictly higher versionCode`() {
        assertTrue(UpdatePolicy.isUpdate(FakeReleaseApi.release(101), PACKAGE, 100))
        assertFalse(UpdatePolicy.isUpdate(FakeReleaseApi.release(100), PACKAGE, 100))
        assertFalse(UpdatePolicy.isUpdate(FakeReleaseApi.release(99), PACKAGE, 100))
        assertFalse(UpdatePolicy.isUpdate(FakeReleaseApi.release(101), "$PACKAGE.debug", 100))
    }

    @Test fun `download url must be same-origin`() {
        val server = "https://photos.example"
        assertEquals("https://photos.example/api/android-app/download/tok", UpdatePolicy.downloadUrl(server, "/api/android-app/download/tok"))
        assertEquals("https://photos.example/api/android-app/download/tok", UpdatePolicy.downloadUrl("$server/", "https://photos.example/api/android-app/download/tok"))
        assertNull(UpdatePolicy.downloadUrl(server, "https://evil.example/x.apk"))
        assertNull(UpdatePolicy.downloadUrl(server, "//evil.example/x.apk"))
        assertNull(UpdatePolicy.downloadUrl(server, "http://photos.example/x.apk"))
        assertNull(UpdatePolicy.downloadUrl(server, "https://photos.example:8443/x.apk"))
        assertNull(UpdatePolicy.downloadUrl(server, "javascript:alert(1)"))
        assertNull(UpdatePolicy.downloadUrl("not a url", "/x"))
    }

    @Test fun `no release and size formatting`() {
        assertTrue(UpdatePolicy.isNoRelease(ApiError(ApiError.Kind.HTTP, 404, message = "x", reason = "NO_RELEASE")))
        assertFalse(UpdatePolicy.isNoRelease(ApiError(ApiError.Kind.HTTP, 404, message = "x", reason = "RELEASE_NOT_FOUND")))
        assertFalse(UpdatePolicy.isNoRelease(ApiError(ApiError.Kind.HTTP, 500, message = "x")))
        assertEquals("12.3 MB", UpdatePolicy.formatSize(12_345_678))
        assertNull(UpdatePolicy.formatSize(0))
        assertEquals(12_345_678L, FakeReleaseApi.release(101).sizeBytesValue)
        assertFalse(UpdatePolicy.isValidReleaseId("../x"))
    }

    @Test fun `card headline`() {
        val update = AvailableUpdate("rel", "2.1.0", 110, 0, null)
        assertTrue(UpdateText.headline(update, "2.0.0", 100).endsWith("2.1.0 is available (you have 2.0.0 (100))."))
    }

    // --- checker ---------------------------------------------------------------------------

    @Test fun `offers a newer release and throttles for 12 hours`() = runBlocking {
        api.latestResult = ApiResult.Success(FakeReleaseApi.release(101), 200)
        val c = checker()
        assertTrue(c.check() is UpdateCheckOutcome.Available)
        assertEquals(101L, c.available.value?.versionCode)
        assertEquals(12_345_678L, c.available.value?.sizeBytes)
        now = now.plus(Duration.ofHours(1))
        assertEquals(UpdateCheckOutcome.Throttled, c.check())
        assertEquals(1, api.latestCalls)
        // force bypasses the throttle (Diagnostics → Get the update).
        c.checkNow(force = true)
        assertEquals(2, api.latestCalls)
        now = now.plus(Duration.ofHours(12))
        c.checkNow()
        assertEquals(3, api.latestCalls)
    }

    @Test fun `not paired never asks`() = runBlocking {
        paired = false
        assertEquals(UpdateCheckOutcome.NotPaired, checker().check(force = true))
        assertEquals(0, api.latestCalls)
    }

    @Test fun `up to date, no release, and failure keeps the throttle open`() = runBlocking {
        api.latestResult = ApiResult.Success(FakeReleaseApi.release(100), 200)
        val c = checker()
        assertEquals(UpdateCheckOutcome.UpToDate, c.check())
        assertNull(c.available.value)

        api.latestResult = httpFailure(404, "NO_RELEASE")
        assertEquals(UpdateCheckOutcome.NoRelease, c.check(force = true))

        store.lastCheckAt = null
        api.latestResult = networkFailure()
        assertTrue(c.check() is UpdateCheckOutcome.Failed)
        assertNull(store.lastCheckAt)
        assertEquals(1, failures.size)
    }

    @Test fun `an update installed since the last run forgets the offer and the throttle`() = runBlocking {
        store.lastSeenVersionCode = 100
        store.lastCheckAt = now
        store.available = AvailableUpdate("rel-101", "2.1.0", 101, 10, null)
        val c = checker(versionCode = 101)
        assertNull(c.available.value)
        assertNull(store.lastCheckAt)
        assertEquals(101L, store.lastSeenVersionCode)
    }

    @Test fun `get the update opens the same-origin link in the browser`() = runBlocking {
        api.latestResult = ApiResult.Success(FakeReleaseApi.release(101), 200)
        val c = checker()
        c.check()
        assertTrue(c.openDownload().isSuccess)
        assertEquals(listOf("rel-101"), api.linkRequests)
        assertEquals(listOf("https://photos.example/api/android-app/download/tok"), opened)
    }

    @Test fun `get the update refuses a foreign link, a missing browser and a deleted release`() = runBlocking {
        api.latestResult = ApiResult.Success(FakeReleaseApi.release(101), 200)
        val c = checker()
        c.check()
        api.linkResult = ApiResult.Success(DownloadLink("https://evil.example/x.apk"), 200)
        assertTrue(c.openDownload().isFailure)
        assertTrue(opened.isEmpty())

        api.linkResult = ApiResult.Success(DownloadLink("/api/android-app/download/tok"), 200)
        browser = false
        assertTrue(c.openDownload().isFailure)

        api.linkResult = httpFailure(404, "RELEASE_NOT_FOUND")
        assertTrue(c.openDownload().isFailure)
        assertNull(c.available.value)
        assertNull(store.lastCheckAt)
    }

    @Test fun `nothing to download without an update`() = runBlocking {
        assertTrue(checker().openDownload().isFailure)
        assertTrue(api.linkRequests.isEmpty())
    }

    @Test fun `prefs store round-trips`() {
        val prefs = PrefsUpdateStore(FakeSharedPreferences())
        assertNull(prefs.available)
        val update = AvailableUpdate("rel", "2.1.0", 110, 99, "notes")
        prefs.available = update
        prefs.lastCheckAt = now
        prefs.lastSeenVersionCode = 100
        assertEquals(update, prefs.available)
        assertEquals(now, prefs.lastCheckAt)
        assertEquals(100L, prefs.lastSeenVersionCode)
        prefs.available = null
        assertNull(prefs.available)
    }
}
