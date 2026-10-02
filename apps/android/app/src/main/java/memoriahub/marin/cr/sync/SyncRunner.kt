package memoriahub.marin.cr.sync

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.ledger.LedgerRepository
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.media.MediaScanner
import memoriahub.marin.cr.pairing.ApiErrorReaction
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.upload.NetworkPreference
import memoriahub.marin.cr.upload.UploadEngine
import memoriahub.marin.cr.upload.UploadProgress
import memoriahub.marin.cr.upload.UploadRunResult
import memoriahub.marin.cr.upload.UploadStopReason
import memoriahub.marin.cr.upload.UploadTarget
import java.time.Instant

/** The upload engine as the runner sees it (a seam for JVM tests). */
interface SyncUploader {
    val progress: StateFlow<UploadProgress?>

    suspend fun run(target: UploadTarget, shouldStop: () -> Boolean, expectedFiles: Int): UploadRunResult
}

/** [SyncUploader] over the #511 [UploadEngine]. */
class EngineUploader(private val engine: UploadEngine) : SyncUploader {
    override val progress: StateFlow<UploadProgress?> get() = engine.progress

    override suspend fun run(target: UploadTarget, shouldStop: () -> Boolean, expectedFiles: Int): UploadRunResult =
        engine.run(target = target, shouldStop = shouldStop, maxFiles = Int.MAX_VALUE, expectedFiles = expectedFiles)
}

/** User-visible side effects of a run (notifications), behind an interface for tests. */
interface SyncRunNotifier {
    /** Media permission denied at run start; the runner throttles calls to one per 24 h. */
    fun permissionMissing()

    /** A background run uploaded at least one file (§12.5 summary notification). */
    fun uploaded(files: Int)
}

/**
 * Why the worker was stopped by the system, as the run record states it: a stopped run is
 * `partial` (or `paused` when the user paused), with `FGS_TIMEOUT` on the Android 15 dataSync cap.
 */
data class StopInfo(val status: String, val errorCode: String?, val retry: Boolean)

/** What [SyncRunner.run] decided; the worker maps it to a WorkManager result ([toWorkResult]). */
data class SyncOutcome(val kind: Kind, val run: SyncRunRecord? = null, val message: String? = null) {
    enum class Kind {
        /** `ok`, `partial`, `paused`, `skipped` or a terminal-but-handled failure that must not retry. */
        SUCCESS,

        /** Network policy, server unreachable, 5xx, FGS timeout: WorkManager backs off and retries. */
        RETRY,

        /** A definite failure (target circle forbidden, unknown source device…). */
        FAILURE,

        /** Not paired (or pairing expired before the run): nothing ran. */
        NOT_PAIRED,

        /** 401 or `DEVICE_REVOKED` mid-run: the pairing reactions already ran. */
        UNPAIRED,
    }
}

/** WorkManager result for an [SyncOutcome] (§10.3 step 8). */
enum class WorkResult { SUCCESS, RETRY, FAILURE }

fun SyncOutcome.toWorkResult(runAttemptCount: Int, maxRetries: Int = SyncRunner.MAX_RETRIES): WorkResult = when (kind) {
    SyncOutcome.Kind.SUCCESS, SyncOutcome.Kind.NOT_PAIRED, SyncOutcome.Kind.UNPAIRED -> WorkResult.SUCCESS
    SyncOutcome.Kind.RETRY -> if (runAttemptCount < maxRetries) WorkResult.RETRY else WorkResult.FAILURE
    SyncOutcome.Kind.FAILURE -> WorkResult.FAILURE
}

/** Foreground promotion rule (§10.3 step 5): more than one file or more than 50 MB pending. */
object ForegroundPolicy {
    const val BYTES_THRESHOLD = 50L * 1024 * 1024

    fun shouldPromote(stats: SyncStats): Boolean {
        val files = stats.pending + stats.uploading + stats.failed
        return files > 1 || stats.bytesPending > BYTES_THRESHOLD
    }
}

/**
 * One background sync run (docs/specs/android-media-sync.md §10.3), independent of WorkManager so
 * the whole orchestration is JVM-tested with fakes:
 *
 * 1. Gate on pairing. Check in before (outbox first), applying the returned config.
 * 2. Paused → a `paused` run. Permission denied → `skipped` with `MEDIA_PERMISSION_MISSING` and
 *    the issue notification (at most once per 24 h).
 * 3. `recoverInterrupted` (T14), scan (full when periodic and due), then upload until the queue is
 *    empty, stopped, or the network policy blocks; promote to the foreground when there is work.
 * 4. Record the run locally (`sync_runs`) and check in after with the `run` block.
 *
 * A stop by the system (Android 15 dataSync timeout, constraints lost) cancels the coroutine; the
 * run is still recorded (`partial`, the stop's error code) under [NonCancellable] before the
 * cancellation propagates. Ledger state and parts are already persisted, so the next run resumes.
 */
class SyncRunner(
    private val isPaired: () -> Boolean,
    private val checkin: SyncCheckin,
    private val store: SyncStateStore,
    private val ledger: LedgerRepository,
    private val scanner: MediaScanner,
    private val uploaderFactory: (NetworkPreference) -> SyncUploader,
    private val permission: () -> MediaPermissionState,
    private val pairedAt: () -> Instant?,
    private val deviceId: () -> String?,
    private val deviceName: String?,
    private val notifier: SyncRunNotifier,
    private val tracker: SyncStatusTracker,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /**
     * Runs one sync. [stop] returns non-null once the system stopped the worker; [promote] moves
     * the worker to the foreground (best effort, the worker swallows a refusal, D23).
     */
    suspend fun run(
        requested: SyncTrigger,
        stop: () -> StopInfo? = { null },
        promote: suspend () -> Unit = {},
    ): SyncOutcome {
        if (!isPaired()) {
            AppLog.i(TAG, "sync.run.skipped reason=not_paired trigger=${requested.wire}")
            return SyncOutcome(SyncOutcome.Kind.NOT_PAIRED)
        }
        val startedAt = clock()
        var trigger = requested
        tracker.runStarted()
        try {
            AppLog.i(TAG, "sync.run.start trigger=${trigger.wire}")

            // 1. Check in before.
            when (val before = checkin.checkin(run = null, runNowOnResume = false)) {
                is CheckinOutcome.Applied -> if (before.apply.syncNow) trigger = SyncTrigger.MANUAL
                CheckinOutcome.NotPaired -> return SyncOutcome(SyncOutcome.Kind.NOT_PAIRED)
                is CheckinOutcome.Failed -> {
                    if (before.reaction != ApiErrorReaction.NONE) {
                        return unpaired(trigger, startedAt, before.reaction)
                    }
                    if (store.config == null) {
                        // Never received a config: nothing to sync against yet.
                        return SyncOutcome(
                            if (before.transient) SyncOutcome.Kind.RETRY else SyncOutcome.Kind.FAILURE,
                            message = "check-in failed before the first config",
                        )
                    }
                    AppLog.w(TAG, "sync.run.checkin_failed using cached config")
                }
            }
            val config = effectiveConfig(store) ?: return SyncOutcome(SyncOutcome.Kind.RETRY, message = "no config")

            // 2. Paused / permission.
            if (config.paused) {
                return finish(record(trigger, RunStatus.PAUSED, startedAt), SyncOutcome.Kind.SUCCESS)
            }
            if (permission() == MediaPermissionState.DENIED) {
                notifyPermissionMissing()
                return finish(
                    record(trigger, RunStatus.SKIPPED, startedAt, errorCode = RunErrorCodes.MEDIA_PERMISSION_MISSING),
                    SyncOutcome.Kind.SUCCESS,
                )
            }

            // 3. Scan, then upload.
            ledger.recoverInterrupted()
            val full = trigger == SyncTrigger.PERIODIC && scanner.fullScanDue()
            val scan = scanner.scan(config.scope(pairedAt()), full = full)
            if (scan.permissionLost || (scan.skipped && scan.permission == MediaPermissionState.DENIED)) {
                notifyPermissionMissing()
                return finish(
                    record(trigger, RunStatus.SKIPPED, startedAt, errorCode = RunErrorCodes.MEDIA_PERMISSION_MISSING),
                    SyncOutcome.Kind.SUCCESS,
                )
            }
            val circleId = config.targetCircleId
            val id = deviceId()
            if (circleId == null || id == null) {
                return finish(record(trigger, RunStatus.FAILED, startedAt, errorCode = RunErrorCodes.UNKNOWN), SyncOutcome.Kind.FAILURE)
            }

            val statsBefore = ledger.stats()
            val pendingFiles = statsBefore.pending + statsBefore.uploading + statsBefore.failed
            if (ForegroundPolicy.shouldPromote(statsBefore)) promote()

            val uploader = uploaderFactory(NetworkPreference.fromWire(config.network))
            val result = try {
                coroutineScope {
                    val watcher = launch { uploader.progress.collect { tracker.progress(it) } }
                    try {
                        uploader.run(
                            target = UploadTarget(circleId, id, deviceName),
                            shouldStop = { stop() != null || effectivePaused(store) },
                            expectedFiles = pendingFiles,
                        )
                    } finally {
                        watcher.cancel()
                    }
                }
            } catch (e: CancellationException) {
                withContext(NonCancellable) { recordStopped(trigger, startedAt, statsBefore, stop()) }
                throw e
            }
            if (result.vanishedIds.isNotEmpty()) ledger.vanished(result.vanishedIds)

            // 4. Classify, record, check in after.
            val (status, code, kind) = classify(result, stop())
            val record = record(
                trigger, status, startedAt, errorCode = code,
                uploaded = result.uploaded, deduplicated = result.deduplicated, failed = result.failed,
                bytes = result.bytesUploaded,
                failedSample = if (result.failed > 0) ledger.failedSample() else emptyList(),
            )
            val outcome = finish(record, kind, checkinAfter = kind != SyncOutcome.Kind.UNPAIRED)
            if (result.uploaded > 0 && trigger != SyncTrigger.MANUAL) notifier.uploaded(result.uploaded)
            return outcome
        } finally {
            tracker.runFinished(null)
        }
    }

    private fun classify(result: UploadRunResult, stop: StopInfo?): Triple<String, String?, SyncOutcome.Kind> =
        when (result.stopReason) {
            null -> Triple(if (result.failed > 0) RunStatus.PARTIAL else RunStatus.OK, null, SyncOutcome.Kind.SUCCESS)
            UploadStopReason.NETWORK_POLICY -> Triple(RunStatus.PARTIAL, RunErrorCodes.NETWORK_POLICY, SyncOutcome.Kind.RETRY)
            UploadStopReason.STOPPED -> when {
                stop != null -> Triple(stop.status, stop.errorCode, if (stop.retry) SyncOutcome.Kind.RETRY else SyncOutcome.Kind.SUCCESS)
                effectivePaused(store) -> Triple(RunStatus.PAUSED, null, SyncOutcome.Kind.SUCCESS)
                else -> Triple(RunStatus.PARTIAL, null, SyncOutcome.Kind.SUCCESS)
            }
            UploadStopReason.PAIRING_EXPIRED, UploadStopReason.DEVICE_REVOKED ->
                Triple(RunStatus.FAILED, result.errorCode, SyncOutcome.Kind.UNPAIRED)
            UploadStopReason.SERVER_UNREACHABLE -> Triple(RunStatus.FAILED, result.errorCode, SyncOutcome.Kind.RETRY)
            UploadStopReason.TARGET_CIRCLE_FORBIDDEN,
            UploadStopReason.UNKNOWN_SOURCE_DEVICE,
            UploadStopReason.MEDIA_PERMISSION_MISSING,
            -> Triple(RunStatus.FAILED, result.errorCode, SyncOutcome.Kind.FAILURE)
        }

    /** The run was cancelled by the system: record what the ledger shows was done, then let it propagate. */
    private suspend fun recordStopped(trigger: SyncTrigger, startedAt: Long, before: SyncStats, stop: StopInfo?) {
        try {
            withTimeoutOrNull(STOP_RECORD_TIMEOUT_MS) {
                val after = ledger.stats()
                val info = stop ?: if (effectivePaused(store)) StopInfo(RunStatus.PAUSED, null, false) else StopInfo(RunStatus.PARTIAL, null, true)
                val record = record(
                    trigger, info.status, startedAt, errorCode = info.errorCode,
                    uploaded = (after.uploaded - before.uploaded).coerceAtLeast(0),
                    deduplicated = (after.deduplicated - before.deduplicated).coerceAtLeast(0),
                    bytes = (after.bytesUploaded - before.bytesUploaded).coerceAtLeast(0),
                )
                AppLog.w(TAG, "sync.run.stopped status=${record.status} code=${record.errorCode ?: "none"}")
                finish(record, SyncOutcome.Kind.RETRY)
            }
        } catch (e: Exception) {
            AppLog.w(TAG, "sync.run.stop_record_failed", e)
        }
    }

    private suspend fun unpaired(trigger: SyncTrigger, startedAt: Long, reaction: ApiErrorReaction): SyncOutcome {
        val code = if (reaction == ApiErrorReaction.DEVICE_REVOKED) RunErrorCodes.DEVICE_REVOKED else RunErrorCodes.PAIRING_EXPIRED
        return finish(record(trigger, RunStatus.FAILED, startedAt, errorCode = code), SyncOutcome.Kind.UNPAIRED, checkinAfter = false)
    }

    /** Saves the run locally, then (unless unpaired) checks in after with it. */
    private suspend fun finish(record: SyncRunRecord, kind: SyncOutcome.Kind, checkinAfter: Boolean = true): SyncOutcome {
        try {
            ledger.recordRun(record.toEntity())
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            AppLog.w(TAG, "sync.run.record_failed", e)
        }
        tracker.runFinished(record)
        if (checkinAfter && isPaired()) {
            val after = checkin.checkin(run = record, runNowOnResume = false)
            if (after is CheckinOutcome.Failed && after.reaction != ApiErrorReaction.NONE) {
                AppLog.w(TAG, "sync.run.checkin_after_unpaired reaction=${after.reaction}")
            }
        }
        AppLog.i(
            TAG,
            "sync.run.end trigger=${record.trigger.wire} status=${record.status} uploaded=${record.filesUploaded} " +
                "dedup=${record.filesDeduplicated} failed=${record.filesFailed} code=${record.errorCode ?: "none"} outcome=$kind",
        )
        return SyncOutcome(kind, record)
    }

    private fun record(
        trigger: SyncTrigger,
        status: String,
        startedAt: Long,
        errorCode: String? = null,
        uploaded: Int = 0,
        deduplicated: Int = 0,
        failed: Int = 0,
        bytes: Long = 0,
        failedSample: List<memoriahub.marin.cr.ledger.FailedSampleEntry> = emptyList(),
    ) = SyncRunRecord(
        trigger = trigger,
        status = status,
        startedAtMs = startedAt,
        finishedAtMs = clock(),
        filesUploaded = uploaded,
        filesDeduplicated = deduplicated,
        filesFailed = failed,
        bytesUploaded = bytes,
        errorCode = errorCode,
        failedSample = failedSample,
    )

    private fun notifyPermissionMissing() {
        val now = clock()
        val last = store.permissionNotifiedAtMs
        if (last != null && now - last < PERMISSION_NOTIFY_INTERVAL_MS && now >= last) return
        store.permissionNotifiedAtMs = now
        notifier.permissionMissing()
    }

    companion object {
        private const val TAG = "Sync"
        const val MAX_RETRIES = 4
        const val PERMISSION_NOTIFY_INTERVAL_MS = 24L * 60 * 60 * 1000
        const val STOP_RECORD_TIMEOUT_MS = 8_000L
    }
}
