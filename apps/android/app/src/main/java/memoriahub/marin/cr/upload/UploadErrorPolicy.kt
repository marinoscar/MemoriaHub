package memoriahub.marin.cr.upload

import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.MediaSyncReasons
import memoriahub.marin.cr.net.UploadReasons

/**
 * The backoff schedule of docs/specs/android-media-sync.md §8.4 (D10), pure so the ledger
 * (#510) and the tests share one definition: after failure 1 wait 30 s, 2 → 2 min, 3 → 10 min,
 * 4 → 1 h; the 5th failure blocks. A `Retry-After` raises the delay to at least that value,
 * capped at 1 h, and never counts as an extra attempt.
 */
object UploadBackoff {
    const val MAX_ATTEMPTS = 5
    private val DELAYS_MS = longArrayOf(30_000L, 120_000L, 600_000L, 3_600_000L)
    const val MAX_DELAY_MS = 3_600_000L

    /** True when the [failureNumber]-th failure (1-based) blocks the file. */
    fun blocks(failureNumber: Int): Boolean = failureNumber >= MAX_ATTEMPTS

    /** Delay before the next attempt after the [failureNumber]-th failure; null when it blocks. */
    fun delayMs(failureNumber: Int, retryAfterMs: Long? = null): Long? {
        if (blocks(failureNumber)) return null
        val base = DELAYS_MS[(failureNumber - 1).coerceIn(0, DELAYS_MS.size - 1)]
        val floor = retryAfterMs?.coerceIn(0, MAX_DELAY_MS) ?: 0
        return maxOf(base, floor)
    }
}

/** Which call failed: the same status means different things on different routes. */
enum class UploadStep { DEDUP_CHECK, INIT, PART_URLS, STATUS, PART_PUT, COMPLETE, REGISTER, ABORT }

/**
 * Why a run stopped early. Each maps to a run `errorCode` (§17.4) the caller (#512) records in
 * `sync_runs` and the check-in; [STOPPED] has none (pause, cancellation, or the FGS timeout —
 * the caller knows which).
 */
enum class UploadStopReason(val errorCode: String?) {
    NETWORK_POLICY("NETWORK_POLICY"),
    PAIRING_EXPIRED("PAIRING_EXPIRED"),
    DEVICE_REVOKED("DEVICE_REVOKED"),
    TARGET_CIRCLE_FORBIDDEN("TARGET_CIRCLE_FORBIDDEN"),
    UNKNOWN_SOURCE_DEVICE("UNKNOWN_SOURCE_DEVICE"),
    MEDIA_PERMISSION_MISSING("MEDIA_PERMISSION_MISSING"),
    SERVER_UNREACHABLE("SERVER_UNREACHABLE"),
    STOPPED(null),
}

/** What to do with a failed call (§9.5). */
sealed interface UploadDecision {
    /** `FAILED`, `attempts + 1`, backoff; `BLOCKED` at the 5th. [network] = no HTTP answer at all. */
    data class Retry(val code: String, val network: Boolean = false) : UploadDecision

    /** Non-retryable: `BLOCKED` immediately with `lastError`. */
    data class Block(val code: String) : UploadDecision

    /** Stop the whole run; the row is left as it is and no attempt is counted. */
    data class StopRun(val reason: UploadStopReason) : UploadDecision

    /** The multipart session is gone: abort best effort, clear the session, re-init (T8). */
    data object ResetSession : UploadDecision
}

/**
 * Failure classification of docs/specs/android-media-sync.md §9.5 — pure and unit tested.
 * Callers have ALREADY passed an authenticated failure through `ApiErrorReactions` (which
 * flags the expired pairing / forgets a revoked device); this only decides the file's fate.
 */
object UploadErrorPolicy {
    fun classify(error: ApiError, step: UploadStep): UploadDecision {
        when (error.kind) {
            ApiError.Kind.NOT_CONFIGURED -> return UploadDecision.StopRun(UploadStopReason.SERVER_UNREACHABLE)
            ApiError.Kind.NETWORK -> return UploadDecision.Retry("NETWORK_ERROR", network = true)
            ApiError.Kind.PARSE -> return UploadDecision.Retry("BAD_RESPONSE")
            ApiError.Kind.HTTP -> Unit
        }
        val status = error.httpStatus ?: 0
        val reason = error.reason
        return when {
            status == 401 -> UploadDecision.StopRun(UploadStopReason.PAIRING_EXPIRED)
            status == 409 && reason == MediaSyncReasons.DEVICE_REVOKED ->
                UploadDecision.StopRun(UploadStopReason.DEVICE_REVOKED)
            status == 403 && reason == UploadReasons.TARGET_CIRCLE_FORBIDDEN ->
                UploadDecision.StopRun(UploadStopReason.TARGET_CIRCLE_FORBIDDEN)
            status == 400 && reason == UploadReasons.UNKNOWN_SOURCE_DEVICE ->
                UploadDecision.StopRun(UploadStopReason.UNKNOWN_SOURCE_DEVICE)
            // A circle the paired user may not read or write: every file would fail the same way.
            status == 403 && (step == UploadStep.DEDUP_CHECK || step == UploadStep.REGISTER) ->
                UploadDecision.StopRun(UploadStopReason.TARGET_CIRCLE_FORBIDDEN)
            // The multipart session no longer exists (or is not ours): start it again.
            reason == UploadReasons.UPLOAD_SESSION_INVALID || reason == UploadReasons.UPLOAD_NOT_ACTIVE ->
                UploadDecision.ResetSession
            step in SESSION_STEPS && (status == 403 || status == 404) -> UploadDecision.ResetSession
            // D18: any other 409 on complete is the legacy un-reasoned stale-session conflict.
            step == UploadStep.COMPLETE && status == 409 -> UploadDecision.ResetSession
            step == UploadStep.PART_URLS && status == 400 -> UploadDecision.ResetSession
            // The storage object behind a registration vanished: upload it again.
            step == UploadStep.REGISTER && status == 404 -> UploadDecision.ResetSession
            status == 408 || status == 425 || status == 429 || status >= 500 -> UploadDecision.Retry("HTTP_$status")
            status == 409 -> UploadDecision.Retry("HTTP_409")
            status in 400..499 -> UploadDecision.Block(reason ?: "HTTP_$status")
            else -> UploadDecision.Retry("HTTP_$status")
        }
    }

    /**
     * A part PUT answered by STORAGE (`partUploadAuth = none`): S3/R2 XML, never the API's
     * envelope, so it never goes through `ApiErrorReactions`. 403 (an expired presigned URL)
     * is handled by the engine first (one URL re-fetch); what reaches here is classified so a
     * vanished multipart session restarts and everything else backs off.
     */
    fun classifyStoragePut(status: Int): UploadDecision = when {
        status == 404 -> UploadDecision.ResetSession // NoSuchUpload
        status == 403 -> UploadDecision.Retry("STORAGE_FORBIDDEN")
        status == 408 || status == 429 || status >= 500 -> UploadDecision.Retry("STORAGE_HTTP_$status")
        status == 0 -> UploadDecision.Retry("STORAGE_BAD_URL")
        else -> UploadDecision.Retry("STORAGE_HTTP_$status")
    }

    private val SESSION_STEPS = setOf(UploadStep.PART_URLS, UploadStep.PART_PUT, UploadStep.COMPLETE, UploadStep.STATUS)
}
