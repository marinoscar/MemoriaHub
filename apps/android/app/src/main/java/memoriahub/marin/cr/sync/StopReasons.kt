package memoriahub.marin.cr.sync

import androidx.work.WorkInfo

/**
 * Maps a WorkManager stop reason (`ListenableWorker.getStopReason()`) to how the interrupted run
 * is recorded (docs/specs/android-media-sync.md §10.3 step 6, §10.5):
 *
 * - paused by the user (the pause cancels the unique work) → `paused`, no retry;
 * - Android 15 `dataSync` foreground-service timeout → `partial` + `FGS_TIMEOUT`, retry;
 * - the network constraint went away (e.g. Wi-Fi lost under "Wi-Fi only") → `partial` +
 *   `NETWORK_POLICY`, retry (WorkManager waits for the constraint);
 * - anything else (quota, preemption, device state…) → `partial`, retry.
 *
 * The ledger already holds every completed part, so nothing is lost either way.
 */
object StopReasons {
    fun classify(stopReason: Int, paused: Boolean): StopInfo = when {
        paused -> StopInfo(RunStatus.PAUSED, null, retry = false)
        stopReason == WorkInfo.STOP_REASON_FOREGROUND_SERVICE_TIMEOUT ->
            StopInfo(RunStatus.PARTIAL, RunErrorCodes.FGS_TIMEOUT, retry = true)
        stopReason == WorkInfo.STOP_REASON_CONSTRAINT_CONNECTIVITY ->
            StopInfo(RunStatus.PARTIAL, RunErrorCodes.NETWORK_POLICY, retry = true)
        else -> StopInfo(RunStatus.PARTIAL, null, retry = true)
    }

    fun describe(stopReason: Int): String = when (stopReason) {
        WorkInfo.STOP_REASON_FOREGROUND_SERVICE_TIMEOUT -> "fgs_timeout"
        WorkInfo.STOP_REASON_CANCELLED_BY_APP -> "cancelled_by_app"
        WorkInfo.STOP_REASON_CONSTRAINT_CONNECTIVITY -> "constraint_connectivity"
        WorkInfo.STOP_REASON_CONSTRAINT_CHARGING -> "constraint_charging"
        WorkInfo.STOP_REASON_CONSTRAINT_STORAGE_NOT_LOW -> "constraint_storage"
        WorkInfo.STOP_REASON_TIMEOUT -> "timeout"
        WorkInfo.STOP_REASON_QUOTA -> "quota"
        WorkInfo.STOP_REASON_PREEMPT -> "preempt"
        WorkInfo.STOP_REASON_USER -> "user"
        else -> "reason_$stopReason"
    }
}
