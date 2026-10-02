package memoriahub.marin.cr.sync

import androidx.work.Constraints
import androidx.work.NetworkType
import memoriahub.marin.cr.contract.NetworkMode

/**
 * WorkManager constraints of every sync work item, rebuilt from the current config each time work
 * is enqueued (docs/specs/android-media-sync.md §10.1):
 *
 * | Config | Constraint |
 * |---|---|
 * | `network = 'wifi'` | [NetworkType.UNMETERED] |
 * | `network = 'any'` | [NetworkType.CONNECTED] |
 * | `requireCharging` | `setRequiresCharging(true)` |
 * | always | `setRequiresStorageNotLow(true)` |
 *
 * The data class is the pure mapping (JVM-tested); [toConstraints] builds the WorkManager object.
 */
data class SyncConstraintSpec(
    val networkType: NetworkType,
    val requiresCharging: Boolean,
    val requiresStorageNotLow: Boolean = true,
) {
    /**
     * Stable fingerprint stored after the periodic work is enqueued: the periodic policy is
     * `UPDATE` when it changed, else `KEEP` (§10.2), so a config change reaches queued work.
     */
    val hash: String get() = "v1:${networkType.name}:charging=$requiresCharging:storage=$requiresStorageNotLow"

    /**
     * Expedited work supports only network and storage constraints: a "now" run that must wait
     * for the charger is enqueued as ordinary work (WorkManager would otherwise throw).
     */
    val expeditable: Boolean get() = !requiresCharging

    fun toConstraints(): Constraints = Constraints.Builder()
        .setRequiredNetworkType(networkType)
        .setRequiresCharging(requiresCharging)
        .setRequiresStorageNotLow(requiresStorageNotLow)
        .build()

    companion object {
        /** Before the first check-in (no config yet) the server defaults apply: Wi-Fi only, no charger. */
        val DEFAULT = of(NetworkMode.WIFI, requireCharging = false)

        fun of(network: NetworkMode, requireCharging: Boolean): SyncConstraintSpec = SyncConstraintSpec(
            networkType = when (network) {
                NetworkMode.WIFI -> NetworkType.UNMETERED
                NetworkMode.ANY -> NetworkType.CONNECTED
            },
            requiresCharging = requireCharging,
        )

        fun of(config: DeviceSyncConfig?): SyncConstraintSpec =
            config?.let { of(it.networkMode, it.requireCharging) } ?: DEFAULT
    }
}
