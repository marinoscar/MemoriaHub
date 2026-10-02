package memoriahub.marin.cr.sync

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import memoriahub.marin.cr.ledger.LedgerRepository
import memoriahub.marin.cr.ledger.SyncFileState
import memoriahub.marin.cr.media.MediaScanner
import memoriahub.marin.cr.net.MediaSyncReasons
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.testing.CIRCLE
import memoriahub.marin.cr.testing.DirectTransactions
import memoriahub.marin.cr.testing.FakeCheckinApi
import memoriahub.marin.cr.testing.FakeDeviceStateReader
import memoriahub.marin.cr.testing.FakeHooks
import memoriahub.marin.cr.testing.FakeMediaGateway
import memoriahub.marin.cr.testing.FakeRunNotifier
import memoriahub.marin.cr.testing.FakeScanCursorStore
import memoriahub.marin.cr.testing.FakeSyncFileDao
import memoriahub.marin.cr.testing.FakeSyncRunDao
import memoriahub.marin.cr.testing.FakeUploader
import memoriahub.marin.cr.testing.httpError
import memoriahub.marin.cr.testing.mediaRow
import memoriahub.marin.cr.testing.networkError
import memoriahub.marin.cr.testing.syncConfig
import memoriahub.marin.cr.testing.testReactions
import memoriahub.marin.cr.upload.UploadRunResult
import memoriahub.marin.cr.upload.UploadStopReason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The run orchestration (§10.3) end to end over the real ledger and scanner, with fake I/O. */
class SyncRunnerTest {
    private var now = 1_800_000_000_000L
    private val dao = FakeSyncFileDao()
    private val runs = FakeSyncRunDao()
    private val cursors = FakeScanCursorStore()
    private val ledger = LedgerRepository(dao, runs, DirectTransactions, cursors) { now }
    private val gateway = FakeMediaGateway()
    private val scanner = MediaScanner(gateway, ledger, cursors) { now }
    private val store = InMemorySyncStateStore()
    private val api = FakeCheckinApi(syncConfig(), version = 1)
    private val events = mutableListOf<String>()
    private val uploader = FakeUploader(events)
    private val notifier = FakeRunNotifier()
    private val recorded = mutableListOf<String>()
    private var paired = true
    private var promoted = 0

    private val checkin = SyncCheckin(
        api = api,
        store = store,
        applier = ConfigApplier(store, ledger.asApplierLedger(), FakeHooks(), {}, { null }),
        reactions = testReactions,
        device = FakeDeviceStateReader(),
        deviceId = { "dev-1" },
        appVersion = "1.0.0",
        appVersionCode = 1,
        clock = { now },
    )

    private val runner = SyncRunner(
        isPaired = { paired },
        checkin = checkin,
        store = store,
        ledger = ledger,
        scanner = scanner,
        uploaderFactory = { uploader },
        permission = { gateway.permission },
        pairedAt = { null },
        deviceId = { "dev-1" },
        deviceName = "Pixel 9",
        notifier = notifier,
        tracker = SyncStatusTracker(store),
        clock = { now },
        onRunRecorded = { recorded += it },
    )

    init {
        api.onCheckin = { events += "checkin" }
        gateway.put(mediaRow(1))
        gateway.put(mediaRow(2))
    }

    private suspend fun run(trigger: SyncTrigger = SyncTrigger.PERIODIC, stop: () -> StopInfo? = { null }) =
        runner.run(trigger, stop = stop, promote = { promoted++ })

    @Test fun `steps run in order - check in, scan, upload, record, check in after`() = runTest {
        uploader.onRun = {
            events += "scanned=${dao.all().size} runs=${runs.runs.size}"
        }
        uploader.result = UploadRunResult(uploaded = 2, bytesUploaded = 2_000)

        val outcome = run()

        assertEquals(SyncOutcome.Kind.SUCCESS, outcome.kind)
        assertEquals(listOf("checkin", "upload", "scanned=2 runs=0", "checkin"), events)
        assertEquals(1, runs.runs.size)
        with(runs.runs.single()) {
            assertEquals("periodic", trigger)
            assertEquals("ok", status)
            assertEquals(2, filesUploaded)
            assertEquals(2_000L, bytesUploaded)
        }
        assertNull(api.checkins.first().run)
        assertEquals("ok", api.checkins.last().run!!.status)
        assertEquals(listOf("ok"), recorded)
        with(uploader.targets.single()) {
            assertEquals(CIRCLE, circleId)
            assertEquals("dev-1", sourceDeviceId)
            assertEquals("Pixel 9", sourceDeviceName)
        }
        assertEquals(1, promoted)
        assertEquals(listOf(2), notifier.uploads)
    }

    @Test fun `a single small pending file is not promoted to the foreground`() = runTest {
        gateway.delete(2)
        run()
        assertEquals(0, promoted)
    }

    @Test fun `failures make the run partial with a failed sample`() = runTest {
        uploader.onRun = { dao.all().first().let { dao.update(it.copy(state = SyncFileState.FAILED, lastError = "boom")) } }
        uploader.result = UploadRunResult(uploaded = 1, failed = 1)
        run()
        val sent = api.checkins.last().run!!
        assertEquals("partial", sent.status)
        assertEquals(1, sent.failedSample!!.size)
        assertEquals("boom", sent.failedSample!!.single().lastError)
    }

    @Test fun `NETWORK_POLICY stops the run as partial and retries`() = runTest {
        uploader.result = UploadRunResult(uploaded = 1, stopReason = UploadStopReason.NETWORK_POLICY)
        val outcome = run()
        assertEquals(SyncOutcome.Kind.RETRY, outcome.kind)
        assertEquals("partial", outcome.run!!.status)
        assertEquals(RunErrorCodes.NETWORK_POLICY, outcome.run!!.errorCode)
        assertEquals(WorkResult.RETRY, outcome.toWorkResult(runAttemptCount = 0))
        assertEquals(WorkResult.FAILURE, outcome.toWorkResult(runAttemptCount = SyncRunner.MAX_RETRIES))
    }

    @Test fun `a revoked device at check-in stops before scanning and does not check in after`() = runTest {
        api.checkinError = httpError(409, MediaSyncReasons.DEVICE_REVOKED)
        val outcome = run()
        assertEquals(SyncOutcome.Kind.UNPAIRED, outcome.kind)
        assertEquals(WorkResult.SUCCESS, outcome.toWorkResult(0))
        assertTrue(uploader.targets.isEmpty())
        assertTrue(gateway.scans.isEmpty())
        assertEquals(1, api.checkins.size)
        with(runs.runs.single()) {
            assertEquals("failed", status)
            assertEquals(RunErrorCodes.DEVICE_REVOKED, errorCode)
        }
    }

    @Test fun `a 401 at check-in records pairing expired`() = runTest {
        api.checkinError = httpError(401)
        val outcome = run()
        assertEquals(SyncOutcome.Kind.UNPAIRED, outcome.kind)
        assertEquals(RunErrorCodes.PAIRING_EXPIRED, runs.runs.single().errorCode)
    }

    @Test fun `revoked mid-upload is unpaired with no check-in after`() = runTest {
        uploader.result = UploadRunResult(uploaded = 1, stopReason = UploadStopReason.DEVICE_REVOKED)
        val outcome = run()
        assertEquals(SyncOutcome.Kind.UNPAIRED, outcome.kind)
        assertEquals("failed", outcome.run!!.status)
        assertEquals("DEVICE_REVOKED", outcome.run!!.errorCode)
        assertEquals(1, api.checkins.size)
    }

    @Test fun `offline before the first config retries without running`() = runTest {
        api.checkinError = networkError()
        val outcome = run()
        assertEquals(SyncOutcome.Kind.RETRY, outcome.kind)
        assertTrue(uploader.targets.isEmpty())
        assertTrue(runs.runs.isEmpty())
    }

    @Test fun `offline with a cached config still syncs`() = runTest {
        run()
        api.checkinError = networkError()
        events.clear()
        val outcome = run()
        assertEquals(SyncOutcome.Kind.SUCCESS, outcome.kind)
        assertEquals(2, uploader.targets.size)
    }

    @Test fun `paused records a paused run and uploads nothing`() = runTest {
        api.config = syncConfig(paused = true)
        val outcome = run()
        assertEquals(SyncOutcome.Kind.SUCCESS, outcome.kind)
        assertEquals("paused", outcome.run!!.status)
        assertTrue(uploader.targets.isEmpty())
        assertEquals("paused", api.checkins.last().run!!.status)
    }

    @Test fun `denied permission skips the run and notifies at most once a day`() = runTest {
        gateway.permission = MediaPermissionState.DENIED
        val first = run()
        assertEquals("skipped", first.run!!.status)
        assertEquals(RunErrorCodes.MEDIA_PERMISSION_MISSING, first.run!!.errorCode)
        assertTrue(uploader.targets.isEmpty())
        assertEquals(1, notifier.permissionNotices)

        now += 60_000
        run()
        assertEquals(1, notifier.permissionNotices)

        now += SyncRunner.PERMISSION_NOTIFY_INTERVAL_MS
        run()
        assertEquals(2, notifier.permissionNotices)
    }

    @Test fun `a server sync-now delta turns the run into a manual one without a summary notification`() = runTest {
        run()
        api.config = api.config.copy(syncNowGeneration = 1)
        api.version++
        uploader.result = UploadRunResult(uploaded = 1)
        notifier.uploads.clear()
        val outcome = run(SyncTrigger.PERIODIC)
        assertEquals(SyncTrigger.MANUAL, outcome.run!!.trigger)
        assertTrue(notifier.uploads.isEmpty())
    }

    @Test fun `a system stop mid-upload is recorded as partial FGS_TIMEOUT and the cancellation propagates`() = runTest {
        var stopped: StopInfo? = null
        uploader.onRun = {
            dao.all().first().let { dao.update(it.copy(state = SyncFileState.UPLOADED, uploadedAt = now)) }
            stopped = StopInfo(RunStatus.PARTIAL, RunErrorCodes.FGS_TIMEOUT, retry = true)
            throw CancellationException("stopped by the system")
        }
        try {
            run(stop = { stopped })
            fail("the cancellation must propagate")
        } catch (_: CancellationException) {
        }
        with(runs.runs.single()) {
            assertEquals("partial", status)
            assertEquals(RunErrorCodes.FGS_TIMEOUT, errorCode)
            assertEquals(1, filesUploaded)
        }
        assertEquals(RunErrorCodes.FGS_TIMEOUT, api.checkins.last().run!!.errorCode)
        assertEquals(listOf("partial"), recorded)
    }

    @Test fun `a cooperative stop uses the stop reason`() = runTest {
        uploader.result = UploadRunResult(uploaded = 1, stopReason = UploadStopReason.STOPPED)
        val outcome = run(stop = { StopInfo(RunStatus.PARTIAL, RunErrorCodes.FGS_TIMEOUT, retry = true) })
        assertEquals(SyncOutcome.Kind.RETRY, outcome.kind)
        assertEquals(RunErrorCodes.FGS_TIMEOUT, outcome.run!!.errorCode)
    }

    @Test fun `a local pause during the upload stops it and records paused`() = runTest {
        uploader.onRun = { shouldStop ->
            assertFalse(shouldStop())
            store.outbox = listOf(OutboxEntry(command = "pause"))
            assertTrue(shouldStop())
        }
        uploader.result = UploadRunResult(uploaded = 1, stopReason = UploadStopReason.STOPPED)
        api.editErrors += networkError() // the pause stays queued for the check-in after
        val outcome = run()
        assertEquals("paused", outcome.run!!.status)
        assertEquals(SyncOutcome.Kind.SUCCESS, outcome.kind)
    }

    @Test fun `not paired does nothing`() = runTest {
        paired = false
        val outcome = run()
        assertEquals(SyncOutcome.Kind.NOT_PAIRED, outcome.kind)
        assertTrue(api.calls.isEmpty())
        assertTrue(runs.runs.isEmpty())
    }

    @Test fun `RETRY becomes FAILURE after the retry budget, other kinds map directly`() {
        assertEquals(WorkResult.RETRY, SyncOutcome(SyncOutcome.Kind.RETRY).toWorkResult(3))
        assertEquals(WorkResult.FAILURE, SyncOutcome(SyncOutcome.Kind.RETRY).toWorkResult(4))
        assertEquals(WorkResult.FAILURE, SyncOutcome(SyncOutcome.Kind.FAILURE).toWorkResult(0))
        assertEquals(WorkResult.SUCCESS, SyncOutcome(SyncOutcome.Kind.NOT_PAIRED).toWorkResult(0))
    }
}

class StopReasonsTest {
    @Test fun `stop reasons map to run records`() {
        assertEquals(StopInfo(RunStatus.PAUSED, null, false), StopReasons.classify(androidx.work.WorkInfo.STOP_REASON_CANCELLED_BY_APP, paused = true))
        assertEquals(
            StopInfo(RunStatus.PARTIAL, RunErrorCodes.FGS_TIMEOUT, true),
            StopReasons.classify(androidx.work.WorkInfo.STOP_REASON_FOREGROUND_SERVICE_TIMEOUT, paused = false),
        )
        assertEquals(
            StopInfo(RunStatus.PARTIAL, RunErrorCodes.NETWORK_POLICY, true),
            StopReasons.classify(androidx.work.WorkInfo.STOP_REASON_CONSTRAINT_CONNECTIVITY, paused = false),
        )
        assertEquals(StopInfo(RunStatus.PARTIAL, null, true), StopReasons.classify(androidx.work.WorkInfo.STOP_REASON_QUOTA, paused = false))
        assertEquals("fgs_timeout", StopReasons.describe(androidx.work.WorkInfo.STOP_REASON_FOREGROUND_SERVICE_TIMEOUT))
    }

    @Test fun `foreground promotion needs more than one file or 50 MB`() {
        assertFalse(ForegroundPolicy.shouldPromote(memoriahub.marin.cr.ledger.SyncStats(pending = 1, bytesPending = 1_000)))
        assertTrue(ForegroundPolicy.shouldPromote(memoriahub.marin.cr.ledger.SyncStats(pending = 1, failed = 1)))
        assertTrue(ForegroundPolicy.shouldPromote(memoriahub.marin.cr.ledger.SyncStats(pending = 1, bytesPending = ForegroundPolicy.BYTES_THRESHOLD + 1)))
    }

    @Test fun `network state and progress text`() {
        assertEquals(NetworkState.NONE, NetworkState.of(hasNetwork = false, hasInternet = false, notMetered = false))
        assertEquals(NetworkState.NONE, NetworkState.of(hasNetwork = true, hasInternet = false, notMetered = true))
        assertEquals(NetworkState.WIFI, NetworkState.of(hasNetwork = true, hasInternet = true, notMetered = true))
        assertEquals(NetworkState.CELLULAR, NetworkState.of(hasNetwork = true, hasInternet = true, notMetered = false))

        val idle = memoriahub.marin.cr.contract.SyncStatusView(
            running = true, currentFile = null, bytesSent = 0, bytesTotal = 0, filesDone = 0, filesTotal = 0,
            lastRunAtMs = null, lastRunStatus = null, lastError = null, lastCheckinAtMs = null,
        )
        assertEquals("Preparing…", SyncNotifications.progressText(idle))
        assertEquals(
            "Uploading 3 of 120 · IMG_1234.jpg · 45%",
            SyncNotifications.progressText(idle.copy(currentFile = "IMG_1234.jpg", filesDone = 2, filesTotal = 120, bytesSent = 45, bytesTotal = 100)),
        )
    }
}
