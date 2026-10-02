package memoriahub.marin.cr.diagnostics

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import memoriahub.marin.cr.contract.SyncConfigView
import memoriahub.marin.cr.contract.SyncControl
import memoriahub.marin.cr.contract.SyncStatusView
import memoriahub.marin.cr.ledger.SyncFileEntity
import memoriahub.marin.cr.ledger.SyncRunEntity
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.media.Bucket
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.pairing.PairingStatus
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.update.AppRelease
import memoriahub.marin.cr.update.ReleaseApi
import memoriahub.marin.cr.util.AppInfo
import java.time.Instant
import java.time.ZoneId
import kotlin.coroutines.cancellation.CancellationException

/** Everything one self-test saw: the checks plus the context the report and the screen show. */
data class SelfTestResult(
    val generatedAt: Instant,
    val checks: List<CheckResult>,
    val app: AppInfo,
    val device: DeviceSnapshot,
    val serverUrl: String?,
    val pairing: PairingStatus,
    val config: SyncConfigView?,
    val syncStatus: SyncStatusView?,
    val permission: MediaPermissionState?,
    val stats: SyncStats?,
    /** Selected folders with counts (empty when not configured). */
    val folders: List<FolderInventory>,
    val latestRelease: AppRelease? = null,
) {
    val failCount: Int get() = checks.count { it.verdict == CheckStatus.FAIL }
    val warnCount: Int get() = checks.count { it.verdict == CheckStatus.WARN }
    val passCount: Int get() = checks.count { it.verdict == CheckStatus.PASS }
    val skipCount: Int get() = checks.count { it.verdict == CheckStatus.SKIP }

    /** The Hub's "N problems" (warn + fail). */
    val problemCount: Int get() = failCount + warnCount
    val summary: String get() = DiagnosticSummary.of(checks)
}

object DiagnosticSummary {
    /** `"N fail, M warn: <first failing check label>"`, or "All checks pass" (≤500 chars, the upload's `summary`). */
    fun of(checks: List<CheckResult>): String {
        val fails = checks.count { it.verdict == CheckStatus.FAIL }
        val warns = checks.count { it.verdict == CheckStatus.WARN }
        if (fails == 0 && warns == 0) return "All checks pass"
        val first = checks.firstOrNull { it.verdict == CheckStatus.FAIL } ?: checks.first { it.verdict == CheckStatus.WARN }
        return "$fails fail, $warns warn: ${first.label}".take(500)
    }
}

/**
 * Runs every diagnostics check (docs/specs/android-media-sync.md §13.1). The probes (live,
 * device, assetlinks, work, release, ledger) run in parallel, each bounded by a timeout through
 * [probe]; nothing here throws, so one broken subsystem never hides the others: a probe that times
 * out or throws becomes a `fail`/`skip` with a detail.
 *
 * Sync state (config, pause, scheduled work, last check-in) is read only through [SyncControl]
 * (implemented by #512).
 */
class SelfTest(
    private val platform: DiagnosticsPlatform,
    private val serverUrl: () -> String?,
    private val server: ServerProbe,
    private val api: DiagnosticsApi,
    private val releases: ReleaseApi?,
    private val pairing: () -> PairingStatus,
    private val sync: () -> SyncControl,
    private val ledger: DiagnosticsLedger,
    private val clock: () -> Instant = Instant::now,
    private val zone: () -> ZoneId = ZoneId::systemDefault,
    private val networkTimeoutMs: Long = DiagnosticsLimits.NETWORK_TIMEOUT_MS,
    private val localTimeoutMs: Long = DiagnosticsLimits.LOCAL_TIMEOUT_MS,
    /** Global 401 / DEVICE_REVOKED reactions for the authenticated probes (`apiErrorReactions.handle`). */
    private val onApiFailure: (ApiError) -> Unit = {},
) {
    suspend fun run(): SelfTestResult = coroutineScope {
        val now = clock()
        val zoneId = safe { zone() } ?: ZoneId.of("UTC")
        val url = safe { serverUrl() }?.takeIf { it.isNotBlank() }
        val app = safe { platform.appInfo() } ?: AppInfo("unknown", "unknown", 0, null)
        val device = safe { platform.device() } ?: DeviceSnapshot()
        val pairingStatus = safe { pairing() } ?: PairingStatus()
        val paired = pairingStatus.paired
        val deviceId = pairingStatus.deviceId

        val liveJob = async { url?.let { probe(networkTimeoutMs) { server.live() } } }
        val deviceJob = async { if (url != null && paired && deviceId != null) probe(networkTimeoutMs) { api.device(deviceId) } else null }
        val linksJob = async { url?.let { probe(networkTimeoutMs) { server.text(ASSET_LINKS_PATH) } } }
        val releaseJob = async { if (url != null && paired && releases != null) probe(networkTimeoutMs) { releases.latest() } else null }
        val periodicJob = async { probe(localTimeoutMs) { sync().isPeriodicScheduled() } }
        val triggerJob = async { probe(localTimeoutMs) { sync().isContentTriggerArmed() } }
        val statsJob = async { probe(localTimeoutMs) { ledger.stats() } }
        val runsJob = async { probe(localTimeoutMs) { ledger.recentRuns(DiagnosticsLimits.REPORT_RUNS) } }
        val uploadingJob = async { probe(localTimeoutMs) { ledger.uploading() } }
        val inventoryJob = async { probe(localTimeoutMs) { ledger.inventory() } }
        val lastFilesJob = async { probe(localTimeoutMs) { ledger.lastUploadedNames() } }

        val control = safe { sync() }
        val config = control?.let { s -> safe { s.currentConfig() } }
        val status = control?.let { s -> safe { s.status.value } }
        val lastTriggerAt = control?.let { s -> safe { s.lastContentTriggerAtMs() } }?.let(Instant::ofEpochMilli)
        val permission = safe { platform.mediaPermission() }
        val paused = config?.paused == true

        val live = liveJob.await()
        val deviceProbe = deviceJob.await()
        val links = linksJob.await()
        val releaseProbe = releaseJob.await()
        val stats = statsJob.await().valueOrNull()
        val runs = runsJob.await().valueOrNull()
        val uploading: List<SyncFileEntity>? = uploadingJob.await().valueOrNull()
        val inventoryProbe = inventoryJob.await()
        // An empty inventory without permission says nothing about the folders.
        val inventory: List<Bucket>? = inventoryProbe.valueOrNull()?.takeIf { permission != MediaPermissionState.DENIED }
        val lastFiles = lastFilesJob.await().valueOrNull().orEmpty()
        val latestRelease = ((releaseProbe as? Probe.Ok)?.value as? ApiResult.Success)?.value
        listOf(deviceProbe, releaseProbe).forEach { p ->
            ((p as? Probe.Ok)?.value as? ApiResult.Failure)?.let { failure -> safe { onApiFailure(failure.error) } }
        }

        val checks = listOf(
            Checks.appVersion(app),
            Checks.appUpdate(url != null && paired, app, releaseProbe),
            Checks.serverConfigured(url),
            Checks.serverReachable(url, live),
            Checks.pairingToken(pairingStatus, now, zoneId),
            Checks.authValid(url, paired, deviceProbe),
            Checks.apiConnection(paired, status?.lastCheckinAtMs?.let(Instant::ofEpochMilli), now),
            Checks.mediaPermission(permission),
            Checks.mediaLocation(device.sdkInt, safe { platform.mediaLocationGranted() }),
            Checks.mediaFolders(paired, config, inventory),
            Checks.mediaTrigger(paired, paused, triggerJob.await(), lastTriggerAt, now),
            Checks.workPeriodic(paired, paused, periodicJob.await()),
            Checks.syncPaused(paired, config),
            Checks.networkPolicy(config, safe { platform.onCellularOnly() }, stats?.pending ?: 0),
            Checks.batteryOptimization(safe { platform.isIgnoringBatteryOptimizations() }),
            Checks.notifications(device.sdkInt, safe { platform.notificationPermissionGranted() }, safe { platform.notificationsEnabled() }),
            Checks.syncLast(paired, runs, stats?.missing ?: 0, now),
            Checks.uploadBacklog(stats),
            Checks.uploadStalled(uploading, now),
            Checks.uploadTarget(paired, config, runs),
            Checks.storageSpace(safe { platform.freeBytes() }),
            Checks.twaVerification(url, app, links),
        )

        SelfTestResult(
            generatedAt = now,
            checks = checks,
            app = app,
            device = device.copy(timezone = zoneId.id),
            serverUrl = url,
            pairing = pairingStatus,
            config = config,
            syncStatus = status,
            permission = permission,
            stats = stats,
            folders = config?.let { FolderInventory.of(it.folderIds, inventory, stats, lastFiles) }.orEmpty(),
            latestRelease = latestRelease,
        ).also { AppLog.i(TAG, "diagnostics.selftest pass=${it.passCount} warn=${it.warnCount} fail=${it.failCount}") }
    }

    private inline fun <T> safe(block: () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Throwable) {
        null
    }

    companion object {
        const val ASSET_LINKS_PATH = "/.well-known/assetlinks.json"
        private const val TAG = "Diagnostics"
    }
}
