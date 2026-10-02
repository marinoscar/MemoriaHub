package memoriahub.marin.cr.testing

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import memoriahub.marin.cr.contract.ConfigPatch
import memoriahub.marin.cr.contract.NetworkMode
import memoriahub.marin.cr.contract.SyncConfigView
import memoriahub.marin.cr.contract.SyncControl
import memoriahub.marin.cr.contract.SyncStatusView
import memoriahub.marin.cr.diagnostics.DeviceSnapshot
import memoriahub.marin.cr.diagnostics.DiagnosticsApi
import memoriahub.marin.cr.diagnostics.DiagnosticsLedger
import memoriahub.marin.cr.diagnostics.DiagnosticsPlatform
import memoriahub.marin.cr.diagnostics.ServerProbe
import memoriahub.marin.cr.diagnostics.UploadDiagnosticsRequest
import memoriahub.marin.cr.diagnostics.UploadDiagnosticsResponse
import memoriahub.marin.cr.ledger.SyncFileEntity
import memoriahub.marin.cr.ledger.SyncRunEntity
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.media.Bucket
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.net.MediaSyncDevice
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.update.AppRelease
import memoriahub.marin.cr.update.DownloadLink
import memoriahub.marin.cr.update.ReleaseApi
import memoriahub.marin.cr.util.AppInfo

const val PACKAGE = "memoriahub.marin.cr"
const val FINGERPRINT = "AA:BB:CC:DD"

fun appInfo(versionCode: Long = 100, signing: String? = FINGERPRINT) = AppInfo(PACKAGE, "2.0.0", versionCode, signing)

fun config(
    folders: List<String> = listOf("camera"),
    paused: Boolean = false,
    network: NetworkMode = NetworkMode.WIFI,
    target: String? = "circle-1",
) = SyncConfigView(
    targetCircleId = target, folderIds = folders, includePhotos = true, includeVideos = true,
    network = network, requireCharging = false, paused = paused, uploadExisting = "all",
    configVersion = 3, appliedConfigVersion = 3,
)

fun run(status: String, atMs: Long, errorCode: String? = null, trigger: String = "periodic") =
    SyncRunEntity(trigger = trigger, status = status, startedAt = atMs - 1000, finishedAt = atMs, errorCode = errorCode)

fun bucket(id: String, name: String = id.replaceFirstChar { it.uppercase() }, photos: Int = 10, videos: Int = 2) =
    Bucket(bucketId = id, name = name, relativePath = "DCIM/$name/", photoCount = photos, videoCount = videos, bytes = 1000)

fun httpFailure(status: Int, reason: String? = null): ApiResult.Failure =
    ApiResult.Failure(ApiError(ApiError.Kind.HTTP, status, code = "E$status", message = "HTTP $status", reason = reason))

fun networkFailure(): ApiResult.Failure =
    ApiResult.Failure(ApiError(ApiError.Kind.NETWORK, message = "Could not reach the server (ConnectException)."))

class FakePlatform(
    var app: AppInfo = appInfo(),
    var sdk: Int = 34,
    var permission: MediaPermissionState = MediaPermissionState.FULL,
    var location: Boolean = true,
    var battery: Boolean? = true,
    var notificationPermission: Boolean = true,
    var notificationsOn: Boolean = true,
    var cellular: Boolean? = false,
    var free: Long? = 10L * 1024 * 1024 * 1024,
) : DiagnosticsPlatform {
    var throwEverywhere = false
    private fun <T> v(value: T): T = if (throwEverywhere) throw IllegalStateException("boom") else value
    override fun appInfo() = v(app)
    override fun device() = v(DeviceSnapshot("Google", "Pixel", "14", sdk, "UTC"))
    override fun mediaPermission() = v(permission)
    override fun mediaLocationGranted() = v(location)
    override fun isIgnoringBatteryOptimizations() = v(battery)
    override fun notificationPermissionGranted() = v(notificationPermission)
    override fun notificationsEnabled() = v(notificationsOn)
    override fun onCellularOnly() = v(cellular)
    override fun freeBytes() = v(free)
}

const val ASSET_LINKS_OK = """[{"relation":["delegate_permission/common.handle_all_urls"],
 "target":{"namespace":"android_app","package_name":"$PACKAGE","sha256_cert_fingerprints":["$FINGERPRINT"]}}]"""

class FakeServerProbe : ServerProbe {
    var liveResult: suspend () -> ApiResult<JsonElement> = { ApiResult.Success(JsonObject(emptyMap()), 200) }
    var textResult: suspend (String) -> ApiResult<String> = { ApiResult.Success(ASSET_LINKS_OK, 200) }
    var liveCalls = 0
    override suspend fun live(): ApiResult<JsonElement> {
        liveCalls++
        return liveResult()
    }
    override suspend fun text(path: String): ApiResult<String> = textResult(path)
}

class FakeDiagnosticsApi : DiagnosticsApi {
    var deviceResult: suspend () -> ApiResult<MediaSyncDevice> = { ApiResult.Success(MediaSyncDevice(id = "dev-1", name = "Pixel", status = "active"), 200) }
    var uploadResult: ApiResult<UploadDiagnosticsResponse> = ApiResult.Success(UploadDiagnosticsResponse("rep-12345678-abcd"), 201)
    val uploads = mutableListOf<Pair<String, UploadDiagnosticsRequest>>()
    override suspend fun device(deviceId: String) = deviceResult()
    override suspend fun uploadReport(deviceId: String, request: UploadDiagnosticsRequest): ApiResult<UploadDiagnosticsResponse> {
        uploads += deviceId to request
        return uploadResult
    }
}

class FakeReleaseApi : ReleaseApi {
    var latestResult: ApiResult<AppRelease> = ApiResult.Success(release(100), 200)
    var linkResult: ApiResult<DownloadLink> = ApiResult.Success(DownloadLink("/api/android-app/download/tok"), 200)
    var latestCalls = 0
    val linkRequests = mutableListOf<String>()
    override suspend fun latest(): ApiResult<AppRelease> {
        latestCalls++
        return latestResult
    }
    override suspend fun downloadLink(releaseId: String): ApiResult<DownloadLink> {
        linkRequests += releaseId
        return linkResult
    }

    companion object {
        fun release(code: Long, pkg: String = PACKAGE, name: String = "2.${code - 100}.0") =
            AppRelease(id = "rel-$code", packageName = pkg, versionName = name, versionCode = code, sizeBytes = "12345678", notes = "Fixes")
    }
}

class FakeSyncControl(
    var config: SyncConfigView? = config(),
    var periodic: Boolean = true,
    var trigger: Boolean = true,
    lastCheckinAtMs: Long? = null,
) : SyncControl {
    override val status: MutableStateFlow<SyncStatusView> = MutableStateFlow(
        SyncStatusView(false, null, 0, 0, 0, 0, null, null, null, lastCheckinAtMs),
    )
    var periodicBlock: () -> Boolean = { periodic }
    var syncNowCalls = 0
    var retryCalls = 0
    val pausedCalls = mutableListOf<Boolean>()
    override fun currentConfig() = config
    override fun syncNow() {
        syncNowCalls++
    }
    override suspend fun setPaused(paused: Boolean): Result<Unit> {
        pausedCalls += paused
        return Result.success(Unit)
    }
    override suspend fun retryFailed(): Result<Unit> {
        retryCalls++
        return Result.success(Unit)
    }
    override suspend fun updateConfig(patch: ConfigPatch) = Result.success(Unit)
    override suspend fun checkinNow() = Result.success(Unit)
    override fun isPeriodicScheduled() = periodicBlock()
    override fun isContentTriggerArmed() = trigger
    override fun lastContentTriggerAtMs(): Long? = null
}

class FakeDiagnosticsLedger(
    var stats: SyncStats = SyncStats(),
    var runs: List<SyncRunEntity> = emptyList(),
    var uploadingRows: List<SyncFileEntity> = emptyList(),
    var buckets: List<Bucket> = listOf(bucket("camera")),
) : DiagnosticsLedger {
    var statsBlock: suspend () -> SyncStats = { stats }
    override suspend fun stats() = statsBlock()
    override suspend fun recentRuns(limit: Int) = runs.take(limit)
    override suspend fun uploading() = uploadingRows
    override fun inventory() = buckets
    override suspend fun lastUploadedNames(): Map<String?, String> = mapOf("camera" to "IMG_9.jpg")
}
