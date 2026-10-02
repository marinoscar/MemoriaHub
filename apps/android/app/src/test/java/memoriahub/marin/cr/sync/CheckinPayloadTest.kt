package memoriahub.marin.cr.sync

import kotlinx.serialization.json.jsonObject
import memoriahub.marin.cr.ledger.CheckinStats
import memoriahub.marin.cr.ledger.FailedSampleEntry
import memoriahub.marin.cr.media.Bucket
import memoriahub.marin.cr.net.ApiClient
import memoriahub.marin.cr.net.CheckinRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CheckinPayloadTest {
    private val day = CheckinPayload.INVENTORY_RESEND_MS
    private val camera = Bucket("camera", "Camera", "DCIM/Camera/", 3, 1, 4_000)
    private val stats = CheckinStats(10, 4, 1, 3, 1, 1, 0, 2_000, 9_000)
    private fun snapshot(inventory: List<Bucket> = listOf(camera), s: CheckinStats = stats) =
        DeviceSnapshot(s, "full", "wifi", batteryOptimized = true, inventory = inventory)

    @Test fun `inventory hash is order-independent and changes with any field`() {
        val screenshots = Bucket("shots", "Screenshots", "Pictures/Screenshots/", 2, 0, 100)
        val hash = CheckinPayload.inventoryHash(listOf(camera, screenshots))
        assertEquals(hash, CheckinPayload.inventoryHash(listOf(screenshots, camera)))
        assertNotEquals(hash, CheckinPayload.inventoryHash(listOf(camera, screenshots.copy(photoCount = 3))))
        assertNotEquals(hash, CheckinPayload.inventoryHash(listOf(camera)))
    }

    @Test fun `inventory is sent when changed, never sent, every 24h, or after a clock jump back`() {
        val now = 10 * day
        assertTrue(CheckinPayload.shouldSendInventory("h", null, null, now))
        assertTrue(CheckinPayload.shouldSendInventory("h2", "h", now - 1, now))
        assertTrue(CheckinPayload.shouldSendInventory("h", "h", null, now))
        assertFalse(CheckinPayload.shouldSendInventory("h", "h", now - day + 1, now))
        assertTrue(CheckinPayload.shouldSendInventory("h", "h", now - day, now))
        assertTrue(CheckinPayload.shouldSendInventory("h", "h", now + 5, now))
    }

    @Test fun `inventory is capped at 500 with blank names replaced and counts clamped`() {
        val many = (1..600).map { Bucket("b$it", "B$it", "p/", 1, 0, 1) }
        assertEquals(500, CheckinPayload.sanitizeInventory(many).size)
        val odd = CheckinPayload.sanitizeInventory(
            listOf(Bucket("id-1", "   ", "p/", -1, -2, -3), Bucket("id-2", "x".repeat(300), "p/", 1, 1, 1)),
        )
        assertEquals("id-1", odd[0].name)
        assertEquals(0, odd[0].photoCount)
        assertEquals(0, odd[0].videoCount)
        assertEquals(0L, odd[0].bytes)
        assertEquals(255, odd[1].name.length)
    }

    @Test fun `run block uses ISO instants, never ends before it starts, and enforces field limits`() {
        val record = SyncRunRecord(
            trigger = SyncTrigger.CONTENT_TRIGGER,
            status = RunStatus.PARTIAL,
            startedAtMs = 1_800_000_000_000,
            finishedAtMs = 1_799_999_999_000, // clock moved back
            filesUploaded = 3,
            filesDeduplicated = -1,
            filesFailed = 60,
            bytesUploaded = 12_345,
            errorCode = "  " + "E".repeat(80),
            failedSample = (1..60).map { FailedSampleEntry("n".repeat(300), null, -5, -1, "e".repeat(700)) },
        )
        val run = CheckinPayload.run(record)
        assertEquals("content_trigger", run.trigger)
        assertEquals("partial", run.status)
        assertEquals("2027-01-15T08:00:00Z", run.startedAt)
        assertEquals(run.startedAt, run.finishedAt)
        assertEquals(0, run.filesDeduplicated)
        assertEquals(64, run.errorCode!!.length)
        assertEquals(50, run.failedSample!!.size)
        with(run.failedSample!!.first()) {
            assertEquals(255, name.length)
            assertEquals(500, lastError!!.length)
            assertEquals(0L, sizeBytes)
            assertEquals(0, attempts)
        }
    }

    @Test fun `an empty failed sample and a blank error code are omitted`() {
        val run = CheckinPayload.run(SyncRunRecord(SyncTrigger.MANUAL, RunStatus.OK, 0, 1, errorCode = "  "))
        assertNull(run.errorCode)
        assertNull(run.failedSample)
    }

    @Test fun `build includes the inventory only when asked and omits nulls on the wire`() {
        val with = CheckinPayload.build(7, snapshot(), includeInventory = true, appVersion = "1.2.3", appVersionCode = 12, run = null)
        assertEquals(7, with.appliedConfigVersion)
        assertEquals(listOf(camera), with.inventory)
        assertEquals("1.2.3", with.appVersion)

        val without = CheckinPayload.build(7, snapshot(), includeInventory = false, appVersion = "", appVersionCode = null, run = null)
        assertNull(without.inventory)
        assertNull(without.appVersion)
        val wire = ApiClient.ApiJson.encodeToJsonElement(CheckinRequest.serializer(), without).jsonObject
        assertFalse("inventory" in wire)
        assertFalse("run" in wire)
        assertFalse("appVersion" in wire)
        assertTrue("stats" in wire)
        assertEquals(setOf("appliedConfigVersion", "stats", "permission", "networkState", "batteryOptimized"), wire.keys)
    }

    @Test fun `build clamps negative stats and a negative applied version`() {
        val bad = CheckinStats(-1, -1, -1, -1, -1, -1, -1, -1, -1)
        val req = CheckinPayload.build(-3, snapshot(s = bad), includeInventory = false, appVersion = null, appVersionCode = null, run = null)
        assertEquals(0, req.appliedConfigVersion)
        assertEquals(CheckinStats(0, 0, 0, 0, 0, 0, 0, 0, 0), req.stats)
    }

    @Test fun `build carries the run block`() {
        val record = SyncRunRecord(SyncTrigger.PERIODIC, RunStatus.OK, 1_000, 2_000, filesUploaded = 2, bytesUploaded = 10)
        val req = CheckinPayload.build(1, snapshot(), includeInventory = false, appVersion = null, appVersionCode = null, run = record)
        assertEquals("periodic", req.run!!.trigger)
        assertEquals(2, req.run!!.filesUploaded)
        assertEquals(10L, req.run!!.bytesUploaded)
    }
}
