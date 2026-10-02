package memoriahub.marin.cr.diagnostics

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonObject
import kotlin.coroutines.cancellation.CancellationException

/** Verdict of one check (docs/specs/android-media-sync.md §13.1). Wire values are lowercase. */
enum class CheckStatus(val wire: String) {
    PASS("pass"),
    WARN("warn"),
    FAIL("fail"),
    SKIP("skip"),
    ;

    companion object {
        fun fromWire(value: String): CheckStatus = entries.firstOrNull { it.wire == value } ?: SKIP
    }
}

/**
 * The fix button next to a failing or warning check (§13.2). Phone-only: never serialized.
 * [label] is the button text.
 */
enum class CheckAction(val label: String) {
    SET_SERVER("Set server"),
    REPAIR("Re-pair"),
    GRANT_MEDIA("Grant media access"),
    CHOOSE_FOLDERS("Choose folders"),
    RESUME("Resume syncing"),
    RETRY_FAILED("Retry failed"),
    NETWORK_SETTINGS("Network & power"),
    BATTERY_SETTINGS("Battery settings"),
    NOTIFICATION_SETTINGS("Notification settings"),
    SYNC_NOW("Sync now"),
    GET_UPDATE("Get the update"),
    OPEN_WEB_SETTINGS("Open Media sync settings (web)"),
    OPEN_ANDROID_APP_ADMIN("Open Admin → Android app"),
}

/**
 * One self-test result. Serialized into the report as `{ id, label, status, detail, remedy?, data? }`;
 * [action] stays on the phone.
 */
@Serializable
data class CheckResult(
    val id: String,
    val label: String,
    val status: String,
    val detail: String,
    val remedy: String? = null,
    val data: JsonObject? = null,
    @Transient val action: CheckAction? = null,
) {
    val verdict: CheckStatus get() = CheckStatus.fromWire(status)

    companion object {
        fun of(
            id: String,
            label: String,
            status: CheckStatus,
            detail: String,
            remedy: String? = null,
            action: CheckAction? = null,
            data: JsonObject? = null,
        ) = CheckResult(id, label, status.wire, detail, remedy, data, action)
    }
}

/** Outcome of one timed probe (a call a check depends on). Never thrown. */
sealed interface Probe<out T> {
    data class Ok<T>(val value: T, val elapsedMs: Long) : Probe<T>
    data class Error(val error: Throwable, val elapsedMs: Long) : Probe<Nothing> {
        val description: String get() = "${error.javaClass.simpleName}${error.message?.let { ": $it" }.orEmpty()}"
    }
    data class TimedOut(val timeoutMs: Long) : Probe<Nothing>

    fun valueOrNull(): T? = (this as? Ok<T>)?.value
}

/**
 * Runs [block] with a hard deadline and never throws (except the caller's own cancellation).
 * The block runs in a detached scope, so a call that ignores cancellation (blocking I/O, a
 * WorkManager future) cannot hold the self-test past [timeoutMs]; a timeout becomes
 * [Probe.TimedOut], an exception [Probe.Error].
 */
suspend fun <T> probe(timeoutMs: Long, nanoTime: () -> Long = System::nanoTime, block: suspend () -> T): Probe<T> {
    val start = nanoTime()
    fun elapsed() = (nanoTime() - start) / 1_000_000
    val deferred = ProbeScope.async {
        try {
            Result.success(block())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            Result.failure<T>(e)
        }
    }
    val result = try {
        withTimeoutOrNull(timeoutMs) { deferred.await() }
    } catch (e: CancellationException) {
        deferred.cancel()
        throw e
    }
    if (result == null) {
        deferred.cancel()
        return Probe.TimedOut(timeoutMs)
    }
    return result.fold(onSuccess = { Probe.Ok(it, elapsed()) }, onFailure = { Probe.Error(it, elapsed()) })
}

private val ProbeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

/** Timeouts and thresholds of the self-test and the report. */
object DiagnosticsLimits {
    /** `server.reachable`: `/api/health/live` must answer within 5 s (§13.2). Every network probe uses it. */
    const val NETWORK_TIMEOUT_MS = 5_000L

    /** Local probes (WorkManager, settings, MediaStore inventory, the Room ledger). */
    const val LOCAL_TIMEOUT_MS = 5_000L

    const val TOKEN_WARN_DAYS = 14L
    const val CHECKIN_STALE_HOURS = 24L
    const val SYNC_STALE_HOURS = 24L
    const val FAILED_RUNS_IN_A_ROW = 3
    const val STALLED_UPLOAD_MS = 60L * 60 * 1000
    const val LOW_SPACE_BYTES = 500L * 1024 * 1024

    const val REPORT_LOG_LINES = 300
    const val REPORT_RUNS = 10
    const val SCREEN_LOG_LINES = 100
}
