package memoriahub.marin.cr.sync

import android.content.Context
import memoriahub.marin.cr.ledger.LedgerRepository
import memoriahub.marin.cr.media.Bucket
import memoriahub.marin.cr.media.MediaGateway
import memoriahub.marin.cr.media.MediaScanner

/** [DeviceStateReader] over the ledger, MediaStore, connectivity and the power manager. */
class AndroidDeviceStateReader(
    context: Context,
    private val ledger: LedgerRepository,
    private val scanner: MediaScanner,
    private val gateway: MediaGateway,
) : DeviceStateReader {
    private val app = context.applicationContext

    override suspend fun snapshot(): DeviceSnapshot = DeviceSnapshot(
        stats = ledger.stats().toCheckin(),
        permission = gateway.permissionState().wire,
        networkState = NetworkState.current(app),
        batteryOptimized = !BatteryOptimization.isIgnoring(app),
        inventory = inventory(),
    )

    override fun inventory(): List<Bucket> = try {
        scanner.inventory()
    } catch (_: SecurityException) {
        emptyList()
    }
}
