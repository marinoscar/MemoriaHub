package memoriahub.marin.cr.diagnostics

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import memoriahub.marin.cr.BuildConfig
import memoriahub.marin.cr.ledger.SyncRunEntity
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.pairing.PairingStatus
import java.time.Duration
import java.time.Instant

/**
 * Runs the self-test, builds the report and uploads it. Shared by the Diagnostics screen and
 * [AutoDiagnostics].
 */
class DiagnosticsService(
    private val selfTest: () -> SelfTest,
    private val api: DiagnosticsApi,
    private val pairing: () -> PairingStatus,
    private val token: () -> String?,
    private val runs: suspend () -> List<SyncRunEntity>,
    private val log: (Int) -> List<String> = AppLog::tail,
    /** Global 401 / DEVICE_REVOKED reactions (`apiErrorReactions.handle`). */
    private val onApiFailure: (ApiError) -> Unit = {},
) {
    suspend fun runSelfTest(): SelfTestResult = selfTest().run()

    suspend fun buildReport(result: SelfTestResult): BuiltReport {
        val recent = runCatching { runs() }.getOrDefault(emptyList())
        return DiagnosticReportBuilder.build(
            result = result,
            runs = recent,
            log = log(DiagnosticsLimits.REPORT_LOG_LINES),
            secret = runCatching { token() }.getOrNull(),
        )
    }

    /**
     * `POST /devices/:id/diagnostics`; null when the phone has no token or no registered device
     * (reports are stored per device). An expired pairing still tries: the server answers 401.
     */
    suspend fun upload(report: BuiltReport): ApiResult<UploadDiagnosticsResponse>? {
        val status = pairing()
        val deviceId = status.deviceId?.takeIf { status.hasToken && it.isNotEmpty() } ?: return null
        val request = UploadDiagnosticsRequest(summary = report.summary.take(500), report = report.json)
        return api.uploadReport(deviceId, request).also { result ->
            when (result) {
                is ApiResult.Success -> AppLog.i(TAG, "diagnostics.upload id=${result.value.id} bytes=${report.sizeBytes}")
                is ApiResult.Failure -> {
                    AppLog.w(TAG, "diagnostics.upload.fail status=${result.error.httpStatus ?: result.error.kind}")
                    runCatching { onApiFailure(result.error) }
                }
            }
        }
    }

    private companion object {
        const val TAG = "Diagnostics"
    }
}

/** When [AutoDiagnostics] last tried an upload (the 6 h throttle). */
interface AutoDiagnosticsStore {
    var lastAttemptAt: Instant?
}

class InMemoryAutoDiagnosticsStore(override var lastAttemptAt: Instant? = null) : AutoDiagnosticsStore

class PrefsAutoDiagnosticsStore(private val prefs: SharedPreferences) : AutoDiagnosticsStore {
    override var lastAttemptAt: Instant?
        get() = prefs.getLong(KEY, 0L).takeIf { it > 0 }?.let(Instant::ofEpochMilli)
        set(value) {
            prefs.edit().apply { if (value == null) remove(KEY) else putLong(KEY, value.toEpochMilli()) }.apply()
        }

    companion object {
        const val PREFS_NAME = BuildConfig.STORAGE_PREFIX + "_diagnostics"
        private const val KEY = "auto_report_last_attempt_at"

        fun from(context: Context) =
            PrefsAutoDiagnosticsStore(context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE))
    }
}

/**
 * After a sync run that `failed` or was `partial`, uploads a diagnostics report so the web always
 * has a recent one when something breaks (docs/specs/android-media-sync.md §13.4):
 * - at most every [INTERVAL] (6 h), counted from the **attempt**, not the success, so a failing
 *   upload never runs a full self-test after every run;
 * - only while paired and when `GET /api/health/live` answers.
 *
 * **Integration (#512):** the sync worker calls [onRunFinished] with the run's check-in status
 * (`ok`, `partial`, `failed`, `skipped`, `paused`) once the run is recorded, e.g.
 * `MobileApplication.from(ctx).autoDiagnostics.onRunFinished(status)`. It returns at once; the
 * work happens on [scope] and never throws.
 */
class AutoDiagnostics(
    private val pairing: () -> PairingStatus,
    private val server: ServerProbe,
    private val service: DiagnosticsService,
    private val store: AutoDiagnosticsStore,
    private val scope: CoroutineScope,
    private val clock: () -> Instant = Instant::now,
    private val networkTimeoutMs: Long = DiagnosticsLimits.NETWORK_TIMEOUT_MS,
) {
    enum class Outcome { NOT_NEEDED, THROTTLED, NOT_PAIRED, UNREACHABLE, UPLOADED, UPLOAD_FAILED }

    private val mutex = Mutex()

    /** Fire-and-forget form of [afterRun] for the sync worker. */
    fun onRunFinished(status: String) {
        if (!needsReport(status)) return
        scope.launch {
            runCatching { afterRun(status) }.onFailure { AppLog.w(TAG, "diagnostics.auto crashed", it) }
        }
    }

    suspend fun afterRun(status: String): Outcome = mutex.withLock {
        if (!needsReport(status)) return@withLock Outcome.NOT_NEEDED
        val now = clock()
        if (!due(store.lastAttemptAt, now)) return@withLock Outcome.THROTTLED
        val pairingStatus = runCatching { pairing() }.getOrNull()
        if (pairingStatus?.paired != true) return@withLock Outcome.NOT_PAIRED
        val live = probe(networkTimeoutMs) { server.live() }
        if ((live as? Probe.Ok)?.value !is ApiResult.Success) return@withLock Outcome.UNREACHABLE
        // Counted from the attempt: a failing upload must not run a full self-test after every run.
        store.lastAttemptAt = now
        AppLog.i(TAG, "diagnostics.auto status=$status")
        val report = service.buildReport(service.runSelfTest())
        if (service.upload(report) is ApiResult.Success) Outcome.UPLOADED else Outcome.UPLOAD_FAILED
    }

    companion object {
        private const val TAG = "Diagnostics"
        val INTERVAL: Duration = Duration.ofHours(6)

        /** A failed or partial run. */
        fun needsReport(status: String): Boolean = status == "failed" || status == "partial"

        /** True when never attempted, [INTERVAL] has passed, or the clock moved backwards. */
        fun due(last: Instant?, now: Instant): Boolean =
            last == null || now.isBefore(last) || !now.isBefore(last.plus(INTERVAL))
    }
}
