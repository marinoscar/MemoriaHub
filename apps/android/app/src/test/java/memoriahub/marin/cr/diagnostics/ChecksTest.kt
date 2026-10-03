package memoriahub.marin.cr.diagnostics

import kotlinx.serialization.json.JsonObject
import memoriahub.marin.cr.contract.NetworkMode
import memoriahub.marin.cr.ledger.SyncFileState
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.net.MediaSyncDevice
import memoriahub.marin.cr.pairing.PairingStatus
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.testing.ASSET_LINKS_OK
import memoriahub.marin.cr.testing.FINGERPRINT
import memoriahub.marin.cr.testing.FakeReleaseApi
import memoriahub.marin.cr.testing.PACKAGE
import memoriahub.marin.cr.testing.appInfo
import memoriahub.marin.cr.testing.bucket
import memoriahub.marin.cr.testing.config
import memoriahub.marin.cr.testing.httpFailure
import memoriahub.marin.cr.testing.ledgerRow
import memoriahub.marin.cr.testing.networkFailure
import memoriahub.marin.cr.testing.run
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Duration
import java.time.Instant
import java.time.ZoneId

class ChecksTest {
    private val now = Instant.parse("2026-10-01T12:00:00Z")
    private val utc = ZoneId.of("UTC")
    private val hour = 3_600_000L
    private val paired = PairingStatus(hasToken = true, deviceId = "dev-1", tokenExpiresAt = now.plus(Duration.ofDays(90)))

    private fun assertStatus(expected: CheckStatus, result: CheckResult) =
        assertEquals("${result.id}: ${result.detail}", expected, result.verdict)

    private fun <V> ok(value: V) = Probe.Ok(value, 12)

    @Test fun `catalogue has the 22 spec ids`() {
        assertEquals(22, CheckIds.ALL.size)
        assertEquals(22, CheckIds.ALL.toSet().size)
    }

    @Test fun `app version is informational and serializes without the action`() {
        val r = Checks.appVersion(appInfo())
        assertStatus(CheckStatus.PASS, r)
        assertTrue(r.detail.contains("2.0.0 (100)"))
        assertNull(Checks.appVersion(appInfo()).action)
    }

    @Test fun `app update ladder`() {
        val app = appInfo(versionCode = 100)
        assertStatus(CheckStatus.SKIP, Checks.appUpdate(false, app, ok(ApiResult.Success(FakeReleaseApi.release(101), 200))))
        assertStatus(CheckStatus.SKIP, Checks.appUpdate(true, app, null))
        assertStatus(CheckStatus.SKIP, Checks.appUpdate(true, app, Probe.TimedOut(5000)))
        assertStatus(CheckStatus.SKIP, Checks.appUpdate(true, app, ok(httpFailure(404, "NO_RELEASE"))))
        assertStatus(CheckStatus.SKIP, Checks.appUpdate(true, app, ok(networkFailure())))
        assertStatus(CheckStatus.SKIP, Checks.appUpdate(true, app, ok(ApiResult.Success(FakeReleaseApi.release(200, pkg = "other.app"), 200))))
        assertStatus(CheckStatus.PASS, Checks.appUpdate(true, app, ok(ApiResult.Success(FakeReleaseApi.release(100), 200))))
        val warn = Checks.appUpdate(true, app, ok(ApiResult.Success(FakeReleaseApi.release(101), 200)))
        assertStatus(CheckStatus.WARN, warn)
        assertEquals(CheckAction.GET_UPDATE, warn.action)
    }

    @Test fun `server configured and reachable`() {
        assertStatus(CheckStatus.FAIL, Checks.serverConfigured(null))
        assertEquals(CheckAction.SET_SERVER, Checks.serverConfigured("").action)
        assertStatus(CheckStatus.PASS, Checks.serverConfigured("https://x.example"))

        assertStatus(CheckStatus.SKIP, Checks.serverReachable(null, null))
        assertStatus(CheckStatus.PASS, Checks.serverReachable("https://x", ok(ApiResult.Success(JsonObject(emptyMap()), 200))))
        assertStatus(CheckStatus.FAIL, Checks.serverReachable("https://x", ok(httpFailure(503))))
        assertStatus(CheckStatus.FAIL, Checks.serverReachable("https://x", Probe.TimedOut(5000)))
        assertStatus(CheckStatus.FAIL, Checks.serverReachable("https://x", Probe.Error(RuntimeException("x"), 3)))
    }

    @Test fun `pairing token ladder`() {
        assertStatus(CheckStatus.FAIL, Checks.pairingToken(PairingStatus(), now, utc))
        assertStatus(CheckStatus.FAIL, Checks.pairingToken(PairingStatus(hasToken = true), now, utc))
        assertStatus(CheckStatus.FAIL, Checks.pairingToken(paired.copy(expired = true), now, utc))
        val expiring = Checks.pairingToken(paired.copy(tokenExpiresAt = now.plus(Duration.ofDays(5))), now, utc)
        assertStatus(CheckStatus.WARN, expiring)
        assertEquals(CheckAction.REPAIR, expiring.action)
        assertStatus(CheckStatus.WARN, Checks.pairingToken(paired.copy(tokenExpiresAt = now.plus(Duration.ofDays(13))), now, utc))
        assertStatus(CheckStatus.PASS, Checks.pairingToken(paired.copy(tokenExpiresAt = now.plus(Duration.ofDays(14))), now, utc))
        assertStatus(CheckStatus.PASS, Checks.pairingToken(paired.copy(tokenExpiresAt = null), now, utc))
    }

    @Test fun `auth valid ladder`() {
        val dev = MediaSyncDevice(id = "dev-1", name = "Pixel", status = "active")
        assertStatus(CheckStatus.SKIP, Checks.authValid(null, true, null))
        assertStatus(CheckStatus.SKIP, Checks.authValid("https://x", false, null))
        assertStatus(CheckStatus.PASS, Checks.authValid("https://x", true, ok(ApiResult.Success(dev, 200))))
        assertStatus(CheckStatus.FAIL, Checks.authValid("https://x", true, ok(ApiResult.Success(dev.copy(status = "revoked"), 200))))
        val expired = Checks.authValid("https://x", true, ok(httpFailure(401)))
        assertStatus(CheckStatus.FAIL, expired)
        assertTrue(expired.detail.contains("expired"))
        assertTrue(Checks.authValid("https://x", true, ok(httpFailure(404))).detail.contains("revoked"))
        assertTrue(Checks.authValid("https://x", true, ok(httpFailure(409, "DEVICE_REVOKED"))).detail.contains("revoked"))
        assertEquals(CheckAction.REPAIR, Checks.authValid("https://x", true, ok(httpFailure(409, "DEVICE_REVOKED"))).action)
        assertStatus(CheckStatus.FAIL, Checks.authValid("https://x", true, Probe.TimedOut(5000)))
    }

    @Test fun `api connection uses the last successful check-in`() {
        assertStatus(CheckStatus.SKIP, Checks.apiConnection(false, null, now))
        assertStatus(CheckStatus.WARN, Checks.apiConnection(true, null, now))
        assertStatus(CheckStatus.PASS, Checks.apiConnection(true, now.minus(Duration.ofHours(23)), now))
        val stale = Checks.apiConnection(true, now.minus(Duration.ofHours(25)), now)
        assertStatus(CheckStatus.FAIL, stale)
        assertEquals(CheckAction.SYNC_NOW, stale.action)
    }

    @Test fun `media permission and location`() {
        assertStatus(CheckStatus.PASS, Checks.mediaPermission(MediaPermissionState.FULL))
        assertStatus(CheckStatus.WARN, Checks.mediaPermission(MediaPermissionState.PARTIAL))
        val denied = Checks.mediaPermission(MediaPermissionState.DENIED)
        assertStatus(CheckStatus.FAIL, denied)
        assertEquals(CheckAction.GRANT_MEDIA, denied.action)
        assertStatus(CheckStatus.SKIP, Checks.mediaPermission(null))

        assertStatus(CheckStatus.PASS, Checks.mediaLocation(28, false))
        assertStatus(CheckStatus.PASS, Checks.mediaLocation(34, true))
        val noLocation = Checks.mediaLocation(34, false)
        assertStatus(CheckStatus.WARN, noLocation)
        assertTrue("videos lose their location too (#545)", "videos" in noLocation.detail)
        assertEquals(CheckAction.GRANT_MEDIA, noLocation.action)
        assertStatus(CheckStatus.SKIP, Checks.mediaLocation(34, null))
    }

    @Test fun `media folders ladder`() {
        val inventory = listOf(bucket("camera"), bucket("screens"))
        assertStatus(CheckStatus.SKIP, Checks.mediaFolders(false, config(), inventory))
        assertStatus(CheckStatus.SKIP, Checks.mediaFolders(true, null, inventory))
        val none = Checks.mediaFolders(true, config(folders = emptyList()), inventory)
        assertStatus(CheckStatus.FAIL, none)
        assertEquals(CheckAction.CHOOSE_FOLDERS, none.action)
        assertStatus(CheckStatus.WARN, Checks.mediaFolders(true, config(folders = listOf("camera", "gone")), inventory))
        // Unknown inventory (no permission) does not judge the selection.
        assertStatus(CheckStatus.PASS, Checks.mediaFolders(true, config(folders = listOf("gone")), null))
        val pass = Checks.mediaFolders(true, config(folders = listOf("camera")), inventory)
        assertStatus(CheckStatus.PASS, pass)
        assertTrue(pass.detail.contains("Camera"))
    }

    @Test fun `new photo trigger and periodic work`() {
        assertStatus(CheckStatus.SKIP, Checks.mediaTrigger(false, false, ok(true), null, now))
        assertStatus(CheckStatus.SKIP, Checks.mediaTrigger(true, true, ok(false), null, now))
        assertStatus(CheckStatus.PASS, Checks.mediaTrigger(true, false, ok(true), now.minusSeconds(60), now))
        val off = Checks.mediaTrigger(true, false, ok(false), null, now)
        assertStatus(CheckStatus.FAIL, off)
        assertEquals(CheckAction.SYNC_NOW, off.action)
        assertStatus(CheckStatus.FAIL, Checks.mediaTrigger(true, false, Probe.TimedOut(5000), null, now))

        assertStatus(CheckStatus.SKIP, Checks.workPeriodic(false, false, ok(true)))
        assertStatus(CheckStatus.SKIP, Checks.workPeriodic(true, true, ok(false)))
        assertStatus(CheckStatus.PASS, Checks.workPeriodic(true, false, ok(true)))
        assertStatus(CheckStatus.FAIL, Checks.workPeriodic(true, false, ok(false)))
        assertStatus(CheckStatus.FAIL, Checks.workPeriodic(true, false, Probe.Error(IllegalStateException(), 1)))
    }

    @Test fun `sync paused and network policy`() {
        assertStatus(CheckStatus.SKIP, Checks.syncPaused(false, config()))
        assertStatus(CheckStatus.PASS, Checks.syncPaused(true, config()))
        val paused = Checks.syncPaused(true, config(paused = true))
        assertStatus(CheckStatus.WARN, paused)
        assertEquals(CheckAction.RESUME, paused.action)

        assertStatus(CheckStatus.SKIP, Checks.networkPolicy(null, true, 5))
        val waiting = Checks.networkPolicy(config(network = NetworkMode.WIFI), true, 5)
        assertStatus(CheckStatus.WARN, waiting)
        assertEquals(CheckAction.NETWORK_SETTINGS, waiting.action)
        assertStatus(CheckStatus.PASS, Checks.networkPolicy(config(network = NetworkMode.WIFI), true, 0))
        assertStatus(CheckStatus.PASS, Checks.networkPolicy(config(network = NetworkMode.WIFI), false, 5))
        assertStatus(CheckStatus.PASS, Checks.networkPolicy(config(network = NetworkMode.ANY), true, 5))
    }

    @Test fun `battery, notifications and storage`() {
        assertStatus(CheckStatus.PASS, Checks.batteryOptimization(true))
        val battery = Checks.batteryOptimization(false)
        assertStatus(CheckStatus.WARN, battery)
        assertEquals(CheckAction.BATTERY_SETTINGS, battery.action)
        assertStatus(CheckStatus.SKIP, Checks.batteryOptimization(null))

        assertStatus(CheckStatus.PASS, Checks.notifications(34, true, true))
        assertStatus(CheckStatus.WARN, Checks.notifications(34, false, true))
        assertStatus(CheckStatus.PASS, Checks.notifications(32, false, true))
        assertStatus(CheckStatus.WARN, Checks.notifications(32, true, false))
        assertEquals(CheckAction.NOTIFICATION_SETTINGS, Checks.notifications(34, false, false).action)

        assertStatus(CheckStatus.PASS, Checks.storageSpace(2L shl 30))
        assertStatus(CheckStatus.WARN, Checks.storageSpace(100L shl 20))
        assertStatus(CheckStatus.SKIP, Checks.storageSpace(null))
    }

    @Test fun `last sync ladder`() {
        val t = now.toEpochMilli()
        assertStatus(CheckStatus.SKIP, Checks.syncLast(false, emptyList(), 0, now))
        assertStatus(CheckStatus.SKIP, Checks.syncLast(true, null, 0, now))
        assertStatus(CheckStatus.WARN, Checks.syncLast(true, emptyList(), 0, now))
        assertStatus(CheckStatus.PASS, Checks.syncLast(true, listOf(run("ok", t - hour)), 3, now))
        // Old but nothing pending: fine.
        assertStatus(CheckStatus.PASS, Checks.syncLast(true, listOf(run("ok", t - 30 * hour)), 0, now))
        val stale = Checks.syncLast(true, listOf(run("ok", t - 30 * hour)), 4, now)
        assertStatus(CheckStatus.WARN, stale)
        assertEquals(CheckAction.SYNC_NOW, stale.action)
        val failing = listOf(run("failed", t - hour), run("failed", t - 2 * hour), run("failed", t - 3 * hour), run("ok", t - 4 * hour))
        assertStatus(CheckStatus.FAIL, Checks.syncLast(true, failing, 0, now))
        val twoFailed = listOf(run("failed", t - hour), run("failed", t - 2 * hour), run("ok", t - 3 * hour))
        assertStatus(CheckStatus.PASS, Checks.syncLast(true, twoFailed, 4, now))
    }

    @Test fun `upload backlog, stalled and target`() {
        assertStatus(CheckStatus.SKIP, Checks.uploadBacklog(null))
        assertStatus(CheckStatus.PASS, Checks.uploadBacklog(SyncStats(uploaded = 5)))
        assertStatus(CheckStatus.WARN, Checks.uploadBacklog(SyncStats(failed = 2)))
        val blocked = Checks.uploadBacklog(SyncStats(failed = 2, blocked = 1))
        assertStatus(CheckStatus.FAIL, blocked)
        assertTrue(blocked.detail.contains("1 file"))
        assertEquals(CheckAction.RETRY_FAILED, blocked.action)

        val t = now.toEpochMilli()
        assertStatus(CheckStatus.SKIP, Checks.uploadStalled(null, now))
        assertStatus(CheckStatus.PASS, Checks.uploadStalled(emptyList(), now))
        assertStatus(CheckStatus.PASS, Checks.uploadStalled(listOf(ledgerRow(SyncFileState.UPLOADING, 1, updatedAt = t - 10 * 60_000)), now))
        val stalled = Checks.uploadStalled(listOf(ledgerRow(SyncFileState.UPLOADING, 1, updatedAt = t - 2 * hour)), now)
        assertStatus(CheckStatus.WARN, stalled)
        assertEquals(CheckAction.RETRY_FAILED, stalled.action)

        assertStatus(CheckStatus.SKIP, Checks.uploadTarget(false, config(), emptyList()))
        assertStatus(CheckStatus.PASS, Checks.uploadTarget(true, config(), listOf(run("ok", t))))
        val forbidden = Checks.uploadTarget(true, config(), listOf(run("paused", t), run("failed", t - hour, "TARGET_CIRCLE_FORBIDDEN")))
        assertStatus(CheckStatus.FAIL, forbidden)
        assertEquals(CheckAction.OPEN_WEB_SETTINGS, forbidden.action)
        assertStatus(CheckStatus.PASS, Checks.uploadTarget(true, config(), listOf(run("ok", t), run("failed", t - hour, "TARGET_CIRCLE_FORBIDDEN"))))
        assertStatus(CheckStatus.SKIP, Checks.uploadTarget(true, config(target = null), emptyList()))
    }

    @Test fun `twa verification only warns`() {
        val app = appInfo()
        assertStatus(CheckStatus.SKIP, Checks.twaVerification(null, app, null))
        assertStatus(CheckStatus.PASS, Checks.twaVerification("https://x", app, ok(ApiResult.Success(ASSET_LINKS_OK, 200))))
        // Lowercase, colon-less fingerprints match too.
        val lower = ASSET_LINKS_OK.replace(FINGERPRINT, "aabbccdd")
        assertStatus(CheckStatus.PASS, Checks.twaVerification("https://x", app, ok(ApiResult.Success(lower, 200))))
        val other = ASSET_LINKS_OK.replace(FINGERPRINT, "11:22")
        val mismatch = Checks.twaVerification("https://x", app, ok(ApiResult.Success(other, 200)))
        assertStatus(CheckStatus.WARN, mismatch)
        assertEquals(CheckAction.OPEN_ANDROID_APP_ADMIN, mismatch.action)
        assertStatus(CheckStatus.WARN, Checks.twaVerification("https://x", app, ok(ApiResult.Success("[]", 200))))
        assertStatus(CheckStatus.WARN, Checks.twaVerification("https://x", app, ok(ApiResult.Success("not json", 200))))
        assertStatus(CheckStatus.WARN, Checks.twaVerification("https://x", app, ok(httpFailure(404))))
        assertStatus(CheckStatus.WARN, Checks.twaVerification("https://x", appInfo(signing = null), ok(ApiResult.Success(ASSET_LINKS_OK, 200))))
        listOf(
            Checks.twaVerification("https://x", app, Probe.TimedOut(5000)),
            Checks.twaVerification("https://x", app, ok(ApiResult.Success(other, 200))),
        ).forEach { assertFalse(it.verdict == CheckStatus.FAIL) }
    }

    @Test fun `asset links parser`() {
        assertEquals(listOf(FINGERPRINT), AssetLinks.fingerprintsFor(ASSET_LINKS_OK, PACKAGE))
        assertEquals(emptyList<String>(), AssetLinks.fingerprintsFor(ASSET_LINKS_OK, "other"))
        assertNull(AssetLinks.fingerprintsFor("{}", PACKAGE))
        assertTrue(AssetLinks.sameFingerprint("AA:BB", "aabb"))
    }
}
