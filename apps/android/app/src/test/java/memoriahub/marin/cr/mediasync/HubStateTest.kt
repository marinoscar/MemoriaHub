package memoriahub.marin.cr.mediasync

import memoriahub.marin.cr.contract.HealthLine
import memoriahub.marin.cr.contract.NetworkMode
import memoriahub.marin.cr.contract.SyncConfigView
import memoriahub.marin.cr.contract.SyncStatusView
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.pairing.PairingStatus
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.testing.idleStatus
import memoriahub.marin.cr.testing.syncConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class HubStateTest {
    private val paired = PairingStatus(hasToken = true, deviceId = "dev-1", tokenExpiresAt = Instant.parse("2027-01-01T00:00:00Z"))
    private val pending = SyncStats(eligible = 10, uploaded = 4, deduplicated = 1, pending = 3, failed = 1, blocked = 1, bytesPending = 2_500_000_000)

    private fun inputs(
        pairing: PairingStatus = paired,
        stats: SyncStats? = pending,
        status: SyncStatusView = idleStatus,
        config: SyncConfigView? = syncConfig(),
        permission: MediaPermissionState = MediaPermissionState.FULL,
        conditions: DeviceConditions = DeviceConditions(connected = true, unmetered = true, charging = false),
        health: HealthLine? = null,
        circleName: String? = "Familia",
    ) = HubInputs("https://photos.example.com", pairing, stats, status, config, permission, conditions, health, circleName, nowMs = 10_000_000)

    private fun status(i: HubInputs) = HubState.derive(i).status

    @Test fun `counts synced, missing, failed, blocked and bytes left`() {
        val s = HubState.derive(inputs())
        assertEquals(5, s.synced)
        assertEquals(5, s.missing)
        assertEquals(1, s.failed)
        assertEquals(1, s.blocked)
        assertEquals("2.5 GB left", s.bytesLeftText)
        assertEquals("Familia", s.targetCircle)
        assertEquals(1, s.foldersSelected)
    }

    @Test fun `no bytes-left text when nothing is missing`() {
        assertNull(HubState.derive(inputs(stats = SyncStats(eligible = 2, uploaded = 2))).bytesLeftText)
    }

    @Test fun `status line priority`() {
        assertEquals(HubStatus.NOT_PAIRED, status(inputs(pairing = PairingStatus())))
        assertEquals(HubStatus.PAIRING_EXPIRED, status(inputs(pairing = paired.copy(expired = true))))
        assertEquals(HubStatus.SYNCING, status(inputs(status = idleStatus.copy(running = true), config = syncConfig(paused = true))))
        assertEquals(HubStatus.PAUSED, status(inputs(config = syncConfig(paused = true), permission = MediaPermissionState.DENIED)))
        assertEquals(HubStatus.PERMISSION_NEEDED, status(inputs(permission = MediaPermissionState.DENIED)))
        assertEquals(HubStatus.NO_FOLDERS, status(inputs(config = syncConfig(folderIds = emptyList()))))
        assertEquals(
            HubStatus.WAITING_FOR_NETWORK,
            status(inputs(conditions = DeviceConditions(connected = false, unmetered = false, charging = false))),
        )
        assertEquals(
            HubStatus.WAITING_FOR_WIFI,
            status(inputs(conditions = DeviceConditions(connected = true, unmetered = false, charging = true))),
        )
        assertEquals(
            HubStatus.WAITING_FOR_CHARGING,
            status(inputs(config = syncConfig(requireCharging = true))),
        )
        assertEquals(HubStatus.PARTIAL_ACCESS, status(inputs(permission = MediaPermissionState.PARTIAL)))
        assertEquals(HubStatus.IDLE, status(inputs()))
    }

    @Test fun `mobile data allowed means no waiting for wifi`() {
        val i = inputs(
            config = syncConfig(network = NetworkMode.ANY),
            conditions = DeviceConditions(connected = true, unmetered = false, charging = false),
        )
        assertEquals(HubStatus.IDLE, status(i))
    }

    @Test fun `nothing to upload never waits for wifi or charging`() {
        val done = SyncStats(eligible = 3, uploaded = 3)
        val i = inputs(stats = done, config = syncConfig(requireCharging = true), conditions = DeviceConditions(true, false, false))
        val s = HubState.derive(i)
        assertEquals(HubStatus.IDLE, s.status)
        assertTrue(s.statusText.startsWith("Idle · everything is synced"))
    }

    @Test fun `blocked rows alone do not wait for wifi`() {
        val i = inputs(stats = SyncStats(eligible = 2, uploaded = 1, blocked = 1), conditions = DeviceConditions(true, false, false))
        assertEquals(HubStatus.IDLE, status(i))
    }

    @Test fun `syncing text shows file, position and percent`() {
        val running = idleStatus.copy(running = true, currentFile = "IMG_1234.jpg", filesDone = 2, filesTotal = 120, bytesSent = 45, bytesTotal = 100)
        val s = HubState.derive(inputs(status = running))
        assertEquals("Syncing · 3 of 120 · IMG_1234.jpg · 45%", s.statusText)
        assertEquals(0.45f, s.progress!!, 0.001f)
        assertFalse(s.canSyncNow)
    }

    @Test fun `idle text includes last sync age`() {
        val s = HubState.derive(inputs(status = idleStatus.copy(lastRunAtMs = 10_000_000 - 12 * 60_000)))
        assertEquals("Idle · last sync 12 min ago", s.statusText)
    }

    @Test fun `primary action is stop, start or none`() {
        assertEquals(PrimaryAction.STOP, HubState.derive(inputs()).primaryAction)
        assertEquals(PrimaryAction.START, HubState.derive(inputs(config = syncConfig(paused = true))).primaryAction)
        assertEquals(PrimaryAction.NONE, HubState.derive(inputs(pairing = PairingStatus())).primaryAction)
        assertFalse(HubState.derive(inputs(config = syncConfig(paused = true))).canSyncNow)
        assertTrue(HubState.derive(inputs()).canSyncNow)
    }

    @Test fun `permission and pairing problems open connect, no folders opens folders`() {
        assertTrue(HubState.derive(inputs(permission = MediaPermissionState.DENIED)).statusOpensConnect)
        assertTrue(HubState.derive(inputs(permission = MediaPermissionState.PARTIAL)).statusOpensConnect)
        assertTrue(HubState.derive(inputs(config = syncConfig(folderIds = emptyList()))).statusOpensFolders)
        assertFalse(HubState.derive(inputs()).statusOpensConnect)
    }

    @Test fun `health line`() {
        assertNull(HubState.healthLine(null))
        assertEquals(HealthLineView("All checks pass", HealthSeverity.OK), HubState.healthLine(HealthLine(12, 0, 0, 1)))
        assertEquals(HealthLineView("1 problem — open Diagnostics", HealthSeverity.WARN), HubState.healthLine(HealthLine(11, 1, 0, 1)))
        assertEquals(HealthLineView("3 problems — open Diagnostics", HealthSeverity.FAIL), HubState.healthLine(HealthLine(9, 2, 1, 1)))
        assertTrue(HubState.derive(inputs(health = HealthLine(9, 2, 1, 1))).health!!.opensDiagnostics)
    }

    @Test fun `target circle falls back to a short id, none without config`() {
        assertEquals("Circle c0ffee00", HubState.derive(inputs(circleName = null)).targetCircle)
        assertNull(HubState.derive(inputs(config = null)).targetCircle)
        assertEquals(0, HubState.derive(inputs(config = null)).foldersSelected)
    }

    @Test fun `no stats yet shows zeros`() {
        val s = HubState.derive(inputs(stats = null))
        assertEquals(0, s.synced)
        assertEquals(0, s.missing)
    }

    @Test fun `pairing card text and connect label`() {
        assertEquals("Paired. Token expires Jan 1, 2027.", HubState.pairingText(paired, "Jan 1, 2027"))
        assertTrue(HubState.pairingText(paired.copy(expired = true), "x").startsWith("Pairing expired"))
        assertEquals("Signed in, but this phone is not registered yet.", HubState.pairingText(PairingStatus(hasToken = true), "x"))
        assertTrue(HubState.pairingText(PairingStatus(), "x").startsWith("Not paired with your "))
        assertEquals("Pairing and permissions", HubState.connectLabel(paired))
        assertEquals("Connect", HubState.connectLabel(PairingStatus()))
    }
}
