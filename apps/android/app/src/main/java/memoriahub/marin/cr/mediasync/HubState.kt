package memoriahub.marin.cr.mediasync

import memoriahub.marin.cr.contract.HealthLine
import memoriahub.marin.cr.contract.NetworkMode
import memoriahub.marin.cr.contract.SyncConfigView
import memoriahub.marin.cr.contract.SyncStatusView
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.pairing.PairingStatus
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.util.Brand

/** The phone's current network and power, as far as the status line cares. */
data class DeviceConditions(
    val connected: Boolean = true,
    /** Wi-Fi or Ethernet (WorkManager's `UNMETERED`). */
    val unmetered: Boolean = true,
    val charging: Boolean = false,
)

/** The Hub status line (docs/specs/android-media-sync.md §12.3), in priority order. */
enum class HubStatus {
    NOT_PAIRED,
    PAIRING_EXPIRED,
    SYNCING,
    PAUSED,
    PERMISSION_NEEDED,
    NO_FOLDERS,
    WAITING_FOR_NETWORK,
    WAITING_FOR_WIFI,
    WAITING_FOR_CHARGING,
    PARTIAL_ACCESS,
    IDLE,
}

/** Which of Start / Stop the Media sync card's primary button shows (none until paired). */
enum class PrimaryAction { NONE, START, STOP }

enum class HealthSeverity { OK, WARN, FAIL }

/** "All checks pass" or "N problems — open Diagnostics" (red when any check fails). */
data class HealthLineView(val text: String, val severity: HealthSeverity) {
    val opensDiagnostics: Boolean get() = severity != HealthSeverity.OK
}

/** Everything the Hub's Media sync card renders, derived by [HubState.derive]. */
data class HubUiState(
    val loaded: Boolean = false,
    val serverUrl: String? = null,
    val pairing: PairingStatus = PairingStatus(),
    val synced: Int = 0,
    val missing: Int = 0,
    val failed: Int = 0,
    val blocked: Int = 0,
    val bytesLeft: Long = 0,
    val status: HubStatus = HubStatus.NOT_PAIRED,
    val statusText: String = "",
    /** 0f..1f while a file is uploading, else null. */
    val progress: Float? = null,
    val lastError: String? = null,
    val primaryAction: PrimaryAction = PrimaryAction.NONE,
    val canSyncNow: Boolean = false,
    val foldersSelected: Int = 0,
    val health: HealthLineView? = null,
    val targetCircle: String? = null,
) {
    val paired: Boolean get() = pairing.paired

    /** "X GB left" under the counts; null when nothing is missing. */
    val bytesLeftText: String? get() = if (missing > 0 && bytesLeft > 0) "${MediaSyncFormat.bytes(bytesLeft)} left" else null

    /** The status line is tappable to fix a permission problem on Connect. */
    val statusOpensConnect: Boolean
        get() = status == HubStatus.PERMISSION_NEEDED || status == HubStatus.PARTIAL_ACCESS ||
            status == HubStatus.NOT_PAIRED || status == HubStatus.PAIRING_EXPIRED

    /** The status line opens Folders (nothing selected yet). */
    val statusOpensFolders: Boolean get() = status == HubStatus.NO_FOLDERS
}

/** Inputs of [HubState.derive]; every one is read fresh on resume and on each status emission. */
data class HubInputs(
    val serverUrl: String?,
    val pairing: PairingStatus,
    val stats: SyncStats?,
    val status: SyncStatusView,
    val config: SyncConfigView?,
    val permission: MediaPermissionState,
    val conditions: DeviceConditions,
    val health: HealthLine?,
    val circleName: String?,
    val nowMs: Long,
)

/** Pure derivation of the Hub (JVM-tested). */
object HubState {
    fun derive(i: HubInputs): HubUiState {
        val stats = i.stats ?: SyncStats()
        val config = i.config
        val paused = config?.paused == true
        val (status, text) = statusLine(i, stats)
        val progress = if (status == HubStatus.SYNCING && i.status.bytesTotal > 0) {
            (i.status.bytesSent.toFloat() / i.status.bytesTotal).coerceIn(0f, 1f)
        } else {
            null
        }
        return HubUiState(
            loaded = true,
            serverUrl = i.serverUrl,
            pairing = i.pairing,
            synced = stats.synced,
            missing = stats.missing,
            failed = stats.failed,
            blocked = stats.blocked,
            bytesLeft = stats.bytesPending,
            status = status,
            statusText = text,
            progress = progress,
            lastError = i.status.lastError?.takeIf { status == HubStatus.IDLE && it.isNotBlank() },
            primaryAction = when {
                !i.pairing.paired -> PrimaryAction.NONE
                paused -> PrimaryAction.START
                else -> PrimaryAction.STOP
            },
            canSyncNow = i.pairing.paired && !paused && !i.status.running,
            foldersSelected = config?.folderIds?.size ?: 0,
            health = healthLine(i.health),
            targetCircle = config?.targetCircleId?.let { id -> i.circleName ?: "Circle ${id.take(8)}" },
        )
    }

    fun statusLine(i: HubInputs, stats: SyncStats): Pair<HubStatus, String> {
        val config = i.config
        val run = i.status
        // Work the next run would actually upload (blocked rows wait for a manual retry).
        val uploadable = stats.pending + stats.uploading + stats.failed
        return when {
            i.pairing.expired -> HubStatus.PAIRING_EXPIRED to "Pairing expired: re-pair to resume syncing"
            !i.pairing.paired -> HubStatus.NOT_PAIRED to "Not paired: pair this phone to start syncing"
            run.running -> HubStatus.SYNCING to syncingText(run)
            config?.paused == true -> HubStatus.PAUSED to "Paused"
            i.permission == MediaPermissionState.DENIED ->
                HubStatus.PERMISSION_NEEDED to "Permission needed: allow access to photos and videos"
            config != null && config.folderIds.isEmpty() ->
                HubStatus.NO_FOLDERS to "No folders selected: choose the folders to back up"
            config != null && uploadable > 0 && !i.conditions.connected ->
                HubStatus.WAITING_FOR_NETWORK to "Waiting for a network connection"
            config != null && uploadable > 0 && config.network == NetworkMode.WIFI && !i.conditions.unmetered ->
                HubStatus.WAITING_FOR_WIFI to "Waiting for Wi-Fi"
            config != null && uploadable > 0 && config.requireCharging && !i.conditions.charging ->
                HubStatus.WAITING_FOR_CHARGING to "Waiting for charging"
            i.permission == MediaPermissionState.PARTIAL ->
                HubStatus.PARTIAL_ACCESS to "Partial access: only the photos and videos you selected sync"
            else -> HubStatus.IDLE to idleText(i, stats)
        }
    }

    private fun syncingText(run: SyncStatusView): String {
        val parts = mutableListOf("Syncing")
        if (run.filesTotal > 0) parts += "${(run.filesDone + 1).coerceAtMost(run.filesTotal)} of ${run.filesTotal}"
        run.currentFile?.takeIf { it.isNotBlank() }?.let { parts += it }
        MediaSyncFormat.percent(run.bytesSent, run.bytesTotal)?.let { parts += "$it%" }
        return if (parts.size == 1) "Syncing…" else parts.joinToString(" · ")
    }

    private fun idleText(i: HubInputs, stats: SyncStats): String {
        val last = i.status.lastRunAtMs?.let { " · last sync ${MediaSyncFormat.ago((i.nowMs - it).coerceAtLeast(0))}" }.orEmpty()
        return when {
            stats.eligible > 0 && stats.missing == 0 -> "Idle · everything is synced$last"
            else -> "Idle$last"
        }
    }

    fun healthLine(line: HealthLine?): HealthLineView? {
        line ?: return null
        val n = line.problems
        return when {
            n == 0 -> HealthLineView("All checks pass", HealthSeverity.OK)
            else -> HealthLineView(
                "$n problem${if (n == 1) "" else "s"} — open Diagnostics",
                if (line.failCount > 0) HealthSeverity.FAIL else HealthSeverity.WARN,
            )
        }
    }

    /** The Pairing card sentence (the date is formatted by the caller). */
    fun pairingText(pairing: PairingStatus, expiresOn: String): String = when {
        pairing.expired -> "Pairing expired: re-pair to resume syncing."
        pairing.paired -> "Paired. Token expires $expiresOn."
        pairing.registrationPending -> "Signed in, but this phone is not registered yet."
        else -> "Not paired with your ${Brand.name} account yet."
    }

    /** Connect when not paired, else the screen that also holds the permissions. */
    fun connectLabel(pairing: PairingStatus): String = if (pairing.paired) "Pairing and permissions" else "Connect"
}
