package memoriahub.marin.cr.testing

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import memoriahub.marin.cr.ledger.CheckinStats
import memoriahub.marin.cr.ledger.ScopeChange
import memoriahub.marin.cr.ledger.SyncScope
import memoriahub.marin.cr.media.Bucket
import memoriahub.marin.cr.net.ApiClient
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.net.CheckinRequest
import memoriahub.marin.cr.net.ConfigEnvelope
import memoriahub.marin.cr.net.ConfigPatchRequest
import memoriahub.marin.cr.net.MediaSyncCheckinApi
import memoriahub.marin.cr.net.MediaSyncReasons
import memoriahub.marin.cr.net.SyncCommand
import memoriahub.marin.cr.pairing.ApiErrorReaction
import memoriahub.marin.cr.sync.ApplierLedger
import memoriahub.marin.cr.sync.ConfigWorkHooks
import memoriahub.marin.cr.sync.DeviceSnapshot
import memoriahub.marin.cr.sync.DeviceStateReader
import memoriahub.marin.cr.sync.DeviceSyncConfig
import memoriahub.marin.cr.sync.NowPolicy
import memoriahub.marin.cr.sync.SyncConstraintSpec
import memoriahub.marin.cr.sync.SyncFolder
import memoriahub.marin.cr.sync.SyncRunNotifier
import memoriahub.marin.cr.sync.SyncTrigger
import memoriahub.marin.cr.sync.SyncUploader
import memoriahub.marin.cr.sync.SyncWork
import memoriahub.marin.cr.upload.UploadProgress
import memoriahub.marin.cr.upload.UploadRunResult
import memoriahub.marin.cr.upload.UploadTarget

const val CIRCLE = "11111111-1111-4111-8111-111111111111"

fun syncConfig(
    folders: List<String> = listOf("camera"),
    network: String = "wifi",
    paused: Boolean = false,
    retryGen: Long = 0,
    syncGen: Long = 0,
    requireCharging: Boolean = false,
    includeVideos: Boolean = true,
    uploadExisting: String = "all",
) = DeviceSyncConfig(
    targetCircleId = CIRCLE,
    folders = folders.map { SyncFolder(it, it.replaceFirstChar { c -> c.uppercase() }) },
    includePhotos = true,
    includeVideos = includeVideos,
    network = network,
    requireCharging = requireCharging,
    paused = paused,
    uploadExisting = uploadExisting,
    retryFailedGeneration = retryGen,
    syncNowGeneration = syncGen,
)

fun DeviceSyncConfig.json(): JsonObject = ApiClient.ApiJson.encodeToJsonElement(DeviceSyncConfig.serializer(), this).jsonObject

fun envelope(config: DeviceSyncConfig, version: Int) = ConfigEnvelope(config.json(), version, "2026-10-02T00:00:00Z")

fun networkError() = ApiError(ApiError.Kind.NETWORK, message = "offline")
fun httpError(status: Int, reason: String? = null) = ApiError(ApiError.Kind.HTTP, httpStatus = status, message = "HTTP $status", reason = reason)

/** The global 401 / DEVICE_REVOKED reactions without side effects. */
val testReactions: (ApiError) -> ApiErrorReaction = { e ->
    when {
        e.httpStatus == 401 -> ApiErrorReaction.PAIRING_EXPIRED
        e.httpStatus == 409 && e.reason == MediaSyncReasons.DEVICE_REVOKED -> ApiErrorReaction.DEVICE_REVOKED
        else -> ApiErrorReaction.NONE
    }
}

/** Server double: holds the device config and answers check-ins, patches and commands like #505. */
class FakeCheckinApi(var config: DeviceSyncConfig = syncConfig(), var version: Int = 1) : MediaSyncCheckinApi {
    val calls = mutableListOf<String>()
    val checkins = mutableListOf<CheckinRequest>()
    val patches = mutableListOf<ConfigPatchRequest>()
    var checkinError: ApiError? = null
    /** Errors returned (once each, in order) by the next command/patch calls. */
    val editErrors = ArrayDeque<ApiError>()
    /** Hook run inside each check-in (to record ordering in a shared event log). */
    var onCheckin: (CheckinRequest) -> Unit = {}

    override suspend fun checkin(deviceId: String, request: CheckinRequest): ApiResult<ConfigEnvelope> {
        calls += "checkin"
        checkins += request
        onCheckin(request)
        checkinError?.let { return ApiResult.Failure(it) }
        return ApiResult.Success(envelope(config, version), 200)
    }

    override suspend fun patchConfig(deviceId: String, request: ConfigPatchRequest): ApiResult<ConfigEnvelope> {
        calls += "patch"
        patches += request
        editErrors.removeFirstOrNull()?.let { return ApiResult.Failure(it) }
        config = config.copy(
            folders = request.folders?.map { SyncFolder(it.bucketId, it.name) } ?: config.folders,
            network = request.network ?: config.network,
            requireCharging = request.requireCharging ?: config.requireCharging,
            includePhotos = request.includePhotos ?: config.includePhotos,
            includeVideos = request.includeVideos ?: config.includeVideos,
            uploadExisting = request.uploadExisting ?: config.uploadExisting,
        )
        version++
        return ApiResult.Success(envelope(config, version), 200)
    }

    override suspend fun command(deviceId: String, command: SyncCommand): ApiResult<ConfigEnvelope> {
        calls += "command:${command.wire}"
        editErrors.removeFirstOrNull()?.let { return ApiResult.Failure(it) }
        config = when (command) {
            SyncCommand.PAUSE -> config.copy(paused = true)
            SyncCommand.RESUME -> config.copy(paused = false)
            SyncCommand.RETRY_FAILED -> config.copy(retryFailedGeneration = config.retryFailedGeneration + 1)
            SyncCommand.SYNC_NOW -> config.copy(syncNowGeneration = config.syncNowGeneration + 1)
        }
        version++
        return ApiResult.Success(envelope(config, version), 200)
    }
}

class FakeApplierLedger : ApplierLedger {
    val scopes = mutableListOf<SyncScope>()
    var retryFailedCalls = 0
    var retryBlockedCalls = 0
    var abortIds: List<String> = emptyList()

    override suspend fun applyScope(scope: SyncScope): ScopeChange {
        scopes += scope
        return ScopeChange(abortedObjectIds = abortIds)
    }

    override suspend fun retryFailed(): Int = 1.also { retryFailedCalls++ }
    override suspend fun retryBlocked(): Int = 1.also { retryBlockedCalls++ }
}

class FakeHooks : ConfigWorkHooks {
    val events = mutableListOf<String>()
    override fun cancelSyncWork() {
        events += "cancel"
    }
    override fun resumeWork(runNow: Boolean) {
        events += "resume(runNow=$runNow)"
    }
    override fun constraintsMaybeChanged() {
        events += "constraints"
    }
}

class FakeSyncWork : SyncWork {
    val events = mutableListOf<String>()
    val periodicSpecs = mutableListOf<SyncConstraintSpec>()
    var periodicScheduled = false
    var triggerArmed = false

    override fun enqueueNow(trigger: SyncTrigger, policy: NowPolicy, constraints: SyncConstraintSpec) {
        events += "now:${trigger.wire}:$policy"
    }

    override fun enqueuePeriodic(constraints: SyncConstraintSpec, update: Boolean) {
        events += "periodic:${if (update) "UPDATE" else "KEEP"}"
        periodicSpecs += constraints
        periodicScheduled = true
    }

    override fun armContentTrigger(replace: Boolean) {
        events += "trigger:${if (replace) "REPLACE" else "KEEP"}"
        triggerArmed = true
    }

    override fun cancelAll() {
        events += "cancelAll"
        periodicScheduled = false
        triggerArmed = false
    }

    override fun isPeriodicScheduled() = periodicScheduled
    override fun isContentTriggerArmed() = triggerArmed
}

class FakeDeviceStateReader(
    var stats: CheckinStats = CheckinStats(0, 0, 0, 0, 0, 0, 0, 0, 0),
    var inventory: List<Bucket> = listOf(Bucket("camera", "Camera", "DCIM/Camera/", 3, 1, 4000)),
    var permission: String = "full",
) : DeviceStateReader {
    override suspend fun snapshot() = DeviceSnapshot(stats, permission, "wifi", batteryOptimized = true, inventory = inventory)
    override fun inventory(): List<Bucket> = inventory
}

/** Scripted upload engine; [onRun] can mutate the ledger or throw. */
class FakeUploader(
    private val events: MutableList<String> = mutableListOf(),
    var result: UploadRunResult = UploadRunResult(),
    var onRun: suspend (shouldStop: () -> Boolean) -> Unit = {},
) : SyncUploader {
    val targets = mutableListOf<UploadTarget>()
    override val progress: StateFlow<UploadProgress?> = MutableStateFlow(null)

    override suspend fun run(target: UploadTarget, shouldStop: () -> Boolean, expectedFiles: Int): UploadRunResult {
        events += "upload"
        targets += target
        onRun(shouldStop)
        return result
    }
}

class FakeRunNotifier : SyncRunNotifier {
    var permissionNotices = 0
    val uploads = mutableListOf<Int>()
    override fun permissionMissing() {
        permissionNotices++
    }
    override fun uploaded(files: Int) {
        uploads += files
    }
}
