package memoriahub.marin.cr.upload

/**
 * Where a run uploads to. [circleId] is the device config's `targetCircleId` (§5.1);
 * [sourceDeviceId] is `TokenStore.deviceId` (the server rejects `source: 'android'` with an
 * unknown or revoked device: 400 `UNKNOWN_SOURCE_DEVICE`); [sourceDeviceName] is the paired
 * device's display name, stored as `MediaItem.sourceDeviceName`.
 */
data class UploadTarget(
    val circleId: String,
    val sourceDeviceId: String,
    val sourceDeviceName: String? = null,
)

/**
 * Live progress for the foreground notification and the Hub (§9.4), emitted at most every
 * 500 ms (plus once per finished file). Byte counts are for [fileName], the file most recently
 * sending bytes; [filesDone] counts files that reached a terminal outcome in this run.
 */
data class UploadProgress(
    val fileName: String,
    val bytesSent: Long,
    val bytesTotal: Long,
    val filesDone: Int,
    val filesTotal: Int,
)

/** One `run.failedSample[]` entry of the check-in (§6.4); [lastError] ≤ 500 chars. */
data class FailedFileSample(
    val name: String,
    val relativePath: String?,
    val sizeBytes: Long,
    val attempts: Int,
    val lastError: String?,
)

/**
 * What one [UploadEngine.run] did, for #512's run record (`sync_runs`) and check-in `run`.
 *
 * - [uploaded] / [deduplicated]: files that reached `UPLOADED` / `DEDUPLICATED` (a dedup
 *   pre-check hit and a `200 deduplicated` registration both count as deduplicated).
 * - [failed]: files marked `FAILED` or `BLOCKED` in this run; [blocked] is the subset that went
 *   to `BLOCKED` (non-retryable, or the 5th failure).
 * - [bytesUploaded]: `sizeBytes` of the files that became `UPLOADED` (the check-in's
 *   `bytesUploaded`); [bytesSent] is every part byte actually written to the wire.
 * - [vanished]: files that disappeared from the phone mid-run ([vanishedIds]); the engine marks
 *   them non-retryable (`FILE_NOT_FOUND`) and the next full scan removes them (T19).
 * - [stopReason]: why the run ended early, or null when the queue simply ran dry;
 *   [errorCode] is its §17.4 run error code.
 */
data class UploadRunResult(
    val uploaded: Int = 0,
    val deduplicated: Int = 0,
    val failed: Int = 0,
    val blocked: Int = 0,
    val vanished: Int = 0,
    val bytesUploaded: Long = 0,
    val bytesSent: Long = 0,
    val filesProcessed: Int = 0,
    val failedSample: List<FailedFileSample> = emptyList(),
    val vanishedIds: List<Long> = emptyList(),
    val stopReason: UploadStopReason? = null,
) {
    val errorCode: String? get() = stopReason?.errorCode

    /** Paused by the network policy (metered network under "Wi-Fi only"): retry later, nothing lost. */
    val pausedByNetwork: Boolean get() = stopReason == UploadStopReason.NETWORK_POLICY

    companion object {
        const val MAX_FAILED_SAMPLE = 50
        const val MAX_LAST_ERROR = 500
    }
}
