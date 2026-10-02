package memoriahub.marin.cr.sync

import memoriahub.marin.cr.ledger.CheckinStats
import memoriahub.marin.cr.ledger.FailedSampleEntry
import memoriahub.marin.cr.ledger.SyncRunEntity
import memoriahub.marin.cr.media.Bucket
import memoriahub.marin.cr.net.CheckinRequest
import memoriahub.marin.cr.net.CheckinRun
import java.security.MessageDigest
import java.time.Instant

/** Check-in `run.status` values (§6.4). */
object RunStatus {
    const val OK = "ok"
    const val PARTIAL = "partial"
    const val FAILED = "failed"
    const val SKIPPED = "skipped"
    const val PAUSED = "paused"
}

/** Phone-originated run error codes (§17.4) that the worker sets itself (the engine supplies the rest). */
object RunErrorCodes {
    const val MEDIA_PERMISSION_MISSING = "MEDIA_PERMISSION_MISSING"
    const val FGS_TIMEOUT = "FGS_TIMEOUT"
    const val NETWORK_POLICY = "NETWORK_POLICY"
    const val PAIRING_EXPIRED = "PAIRING_EXPIRED"
    const val DEVICE_REVOKED = "DEVICE_REVOKED"
    const val SERVER_UNREACHABLE = "SERVER_UNREACHABLE"
    const val UNKNOWN = "UNKNOWN"
}

/** One finished sync pass: the local `sync_runs` row and the check-in `run` block. */
data class SyncRunRecord(
    val trigger: SyncTrigger,
    val status: String,
    val startedAtMs: Long,
    val finishedAtMs: Long,
    val filesUploaded: Int = 0,
    val filesDeduplicated: Int = 0,
    val filesFailed: Int = 0,
    val bytesUploaded: Long = 0,
    val errorCode: String? = null,
    val failedSample: List<FailedSampleEntry> = emptyList(),
) {
    fun toEntity(): SyncRunEntity = SyncRunEntity(
        trigger = trigger.wire,
        status = status,
        startedAt = startedAtMs,
        finishedAt = finishedAtMs,
        filesUploaded = filesUploaded,
        filesDeduplicated = filesDeduplicated,
        filesFailed = filesFailed,
        bytesUploaded = bytesUploaded,
        errorCode = errorCode,
    )
}

/** What the phone reports about itself at every check-in. */
data class DeviceSnapshot(
    val stats: CheckinStats,
    /** `full` | `partial` | `denied`. */
    val permission: String,
    /** `wifi` | `cellular` | `none`. */
    val networkState: String,
    /** True when NOT exempt from battery optimization. */
    val batteryOptimized: Boolean,
    val inventory: List<Bucket>,
)

/**
 * Builds the strict check-in body (docs/specs/android-media-sync.md §6.4). Pure, so every field
 * limit is JVM-tested: inventory sent only when it changed or every 24 h (≤500 entries, blank
 * names replaced), run counts clamped at 0, `failedSample` ≤50 with names ≤255 and errors ≤500,
 * `errorCode` ≤64, `finishedAt` never before `startedAt`.
 */
object CheckinPayload {
    const val MAX_INVENTORY = 500
    const val MAX_FAILED_SAMPLE = 50
    const val MAX_NAME = 255
    const val MAX_ERROR = 500
    const val MAX_ERROR_CODE = 64
    const val MAX_APP_VERSION = 50
    const val INVENTORY_RESEND_MS = 24L * 60 * 60 * 1000

    fun inventoryHash(inventory: List<Bucket>): String {
        val digest = MessageDigest.getInstance("SHA-256")
        for (b in inventory.sortedBy { it.bucketId }) {
            digest.update("${b.bucketId}\u0000${b.name}\u0000${b.relativePath}\u0000${b.photoCount}\u0000${b.videoCount}\u0000${b.bytes}\n".toByteArray())
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** Send the inventory when it changed, was never sent, or the last send is ≥24 h old (or in the future). */
    fun shouldSendInventory(hash: String, storedHash: String?, sentAtMs: Long?, nowMs: Long): Boolean =
        storedHash != hash || sentAtMs == null || nowMs - sentAtMs >= INVENTORY_RESEND_MS || nowMs < sentAtMs

    fun sanitizeInventory(inventory: List<Bucket>): List<Bucket> =
        inventory.take(MAX_INVENTORY).map { b ->
            b.copy(
                name = b.name.trim().ifEmpty { b.bucketId }.take(MAX_NAME),
                photoCount = b.photoCount.coerceAtLeast(0),
                videoCount = b.videoCount.coerceAtLeast(0),
                bytes = b.bytes.coerceAtLeast(0),
            )
        }

    fun run(record: SyncRunRecord): CheckinRun = CheckinRun(
        trigger = record.trigger.wire,
        status = record.status,
        startedAt = Instant.ofEpochMilli(record.startedAtMs).toString(),
        finishedAt = Instant.ofEpochMilli(maxOf(record.finishedAtMs, record.startedAtMs)).toString(),
        filesUploaded = record.filesUploaded.coerceAtLeast(0),
        bytesUploaded = record.bytesUploaded.coerceAtLeast(0),
        filesFailed = record.filesFailed.coerceAtLeast(0),
        filesDeduplicated = record.filesDeduplicated.coerceAtLeast(0),
        errorCode = record.errorCode?.trim()?.take(MAX_ERROR_CODE)?.ifEmpty { null },
        failedSample = record.failedSample.take(MAX_FAILED_SAMPLE).map {
            it.copy(
                name = it.name.take(MAX_NAME),
                sizeBytes = it.sizeBytes.coerceAtLeast(0),
                attempts = it.attempts.coerceAtLeast(0),
                lastError = it.lastError?.take(MAX_ERROR),
            )
        }.ifEmpty { null },
    )

    fun build(
        appliedConfigVersion: Int,
        snapshot: DeviceSnapshot,
        includeInventory: Boolean,
        appVersion: String?,
        appVersionCode: Int?,
        run: SyncRunRecord?,
    ): CheckinRequest = CheckinRequest(
        appliedConfigVersion = appliedConfigVersion.coerceAtLeast(0),
        stats = snapshot.stats.let {
            it.copy(
                eligible = it.eligible.coerceAtLeast(0), uploaded = it.uploaded.coerceAtLeast(0),
                deduplicated = it.deduplicated.coerceAtLeast(0), pending = it.pending.coerceAtLeast(0),
                uploading = it.uploading.coerceAtLeast(0), failed = it.failed.coerceAtLeast(0),
                blocked = it.blocked.coerceAtLeast(0), bytesPending = it.bytesPending.coerceAtLeast(0),
                bytesUploaded = it.bytesUploaded.coerceAtLeast(0),
            )
        },
        permission = snapshot.permission,
        networkState = snapshot.networkState,
        batteryOptimized = snapshot.batteryOptimized,
        inventory = if (includeInventory) sanitizeInventory(snapshot.inventory) else null,
        appVersion = appVersion?.take(MAX_APP_VERSION)?.ifEmpty { null },
        appVersionCode = appVersionCode,
        run = run?.let(::run),
    )
}
