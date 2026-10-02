package memoriahub.marin.cr.diagnostics

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import memoriahub.marin.cr.contract.HealthLine
import memoriahub.marin.cr.contract.HealthSummary
import memoriahub.marin.cr.contract.SyncControl
import memoriahub.marin.cr.ledger.SyncRunEntity
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import java.time.Duration
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException

/** What the Diagnostics screen shows. */
data class DiagnosticsUiState(
    val running: Boolean = false,
    val result: SelfTestResult? = null,
    val report: BuiltReport? = null,
    val runs: List<SyncRunEntity> = emptyList(),
    val log: List<String> = emptyList(),
    val uploading: Boolean = false,
    /** Server id of the last uploaded report. */
    val uploadedId: String? = null,
    val uploadError: String? = null,
    /** One-line feedback for the last action (copied, reset, sync started…). */
    val message: String? = null,
)

/**
 * Process-wide self-test state: the Diagnostics screen's state holder and the Hub's
 * [HealthSummary] (`MobileApplication.healthSummary`, docs/specs/android-media-sync.md §12.3).
 * Lives in the Application (no ViewModel), so a result survives rotation and is shared by the Hub
 * and Diagnostics. Work runs on [scope]; nothing here throws.
 */
class DiagnosticsHealth(
    private val service: DiagnosticsService,
    private val sync: () -> SyncControl,
    private val recentRuns: suspend (Int) -> List<SyncRunEntity>,
    private val resetLedger: suspend () -> Unit,
    private val scope: CoroutineScope,
    private val log: (Int) -> List<String> = AppLog::tail,
    private val clock: () -> Instant = Instant::now,
) : HealthSummary {
    private val _state = MutableStateFlow(DiagnosticsUiState())
    val state: StateFlow<DiagnosticsUiState> = _state.asStateFlow()
    private var job: Job? = null

    override val line: StateFlow<HealthLine?> = _state
        .map { s -> s.result?.let(::lineOf) }
        .stateIn(scope, SharingStarted.Eagerly, null)

    /** Runs the self-test quietly and waits for it (the Hub's resume). */
    override suspend fun refresh() {
        runSelfTest()?.join()
    }

    /**
     * Starts a self-test unless one is running (returns that job) or, with [ifOlderThan], a
     * recent enough result exists (returns null).
     */
    fun runSelfTest(ifOlderThan: Duration? = null): Job? {
        job?.takeIf { it.isActive }?.let { return it }
        val last = _state.value.result?.generatedAt
        if (ifOlderThan != null && last != null && Duration.between(last, clock()) < ifOlderThan) return null
        _state.update { it.copy(running = true, message = null) }
        return scope.launch {
            val result = try {
                service.runSelfTest()
            } catch (e: CancellationException) {
                _state.update { it.copy(running = false) }
                throw e
            } catch (e: Throwable) {
                AppLog.e(TAG, "diagnostics.selftest crashed", e)
                null
            }
            val report = result?.let { r -> runCatching { service.buildReport(r) }.getOrNull() }
            _state.update {
                it.copy(
                    running = false,
                    result = result ?: it.result,
                    report = report ?: it.report,
                    message = if (result == null) "The self-test could not run." else null,
                )
            }
            refreshLocal()
        }.also { job = it }
    }

    /** Reloads the recent runs and the log (Refresh log). */
    fun refreshLocal() {
        scope.launch {
            val runs = runCatching { recentRuns(RECENT_RUNS) }.getOrDefault(_state.value.runs)
            _state.update { it.copy(runs = runs, log = runCatching { log(DiagnosticsLimits.SCREEN_LOG_LINES) }.getOrDefault(emptyList())) }
        }
    }

    fun upload() {
        val report = _state.value.report ?: return
        if (_state.value.uploading) return
        _state.update { it.copy(uploading = true, uploadError = null, uploadedId = null) }
        scope.launch {
            val result = runCatching { service.upload(report) }.getOrElse { e ->
                ApiResult.Failure(ApiError(ApiError.Kind.NETWORK, message = e.javaClass.simpleName))
            }
            _state.update {
                when (result) {
                    null -> it.copy(uploading = false, uploadError = "Pair this phone first: reports are stored per device.")
                    is ApiResult.Success -> it.copy(uploading = false, uploadedId = result.value.id)
                    is ApiResult.Failure -> it.copy(uploading = false, uploadError = "Upload failed: ${result.error.message}")
                }
            }
            refreshLocal()
        }
    }

    fun syncNow() {
        runAction("Sync started. Run the self-test again when it finishes.") { sync().syncNow() }
    }

    fun retryFailed() {
        scope.launch {
            val ok = runCatching { sync().retryFailed() }.getOrElse { Result.failure(it) }
            message(if (ok.isSuccess) "Failed files queued again." else "Could not retry: ${ok.exceptionOrNull()?.message ?: "unknown error"}.")
        }
    }

    fun resume() {
        scope.launch {
            val ok = runCatching { sync().setPaused(false) }.getOrElse { Result.failure(it) }
            message(if (ok.isSuccess) "Syncing resumed." else "Could not resume: ${ok.exceptionOrNull()?.message ?: "unknown error"}.")
            if (ok.isSuccess) runSelfTest()
        }
    }

    /** Diagnostics "Reset local sync state": clears the ledger and scan cursors (pairing and runs kept). */
    fun resetLocalSyncState() {
        scope.launch {
            val ok = runCatching { resetLedger() }
            message(
                if (ok.isSuccess) "Reset. The next sync rescans the selected folders; files already on the server are not uploaded twice."
                else "Reset failed: ${ok.exceptionOrNull()?.javaClass?.simpleName}.",
            )
            refreshLocal()
        }
    }

    fun message(text: String?) {
        _state.update { it.copy(message = text) }
    }

    private fun runAction(done: String, block: () -> Unit) {
        val ok = runCatching(block)
        message(if (ok.isSuccess) done else "Could not start: ${ok.exceptionOrNull()?.javaClass?.simpleName}.")
    }

    companion object {
        private const val TAG = "Diagnostics"
        const val RECENT_RUNS = 10

        /** The screen re-runs the self-test on open when the last result is older than this. */
        val AUTO_RERUN: Duration = Duration.ofMinutes(1)

        fun lineOf(result: SelfTestResult) = HealthLine(
            passCount = result.passCount,
            warnCount = result.warnCount,
            failCount = result.failCount,
            ranAtMs = result.generatedAt.toEpochMilli(),
        )
    }
}
