package memoriahub.marin.cr.mediasync

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import memoriahub.marin.cr.MobileApplication
import memoriahub.marin.cr.ledger.SyncFileEntity
import memoriahub.marin.cr.ledger.SyncFileState
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.notifications.SummaryNotificationPrefs
import memoriahub.marin.cr.permissions.MediaPermissions

/**
 * Hosts the Media Sync screens' controllers (Hub, Folders, Network & power, Files) in
 * `viewModelScope`, wired to [MobileApplication]. All logic lives in the controllers (JVM-tested);
 * this class only adapts Android sources to them. Ledger and MediaStore reads run on IO.
 */
class MediaSyncViewModel(application: Application) : AndroidViewModel(application) {
    private val app = MobileApplication.from(application)
    private val circleNames by lazy { CircleNames(app.apiClient, app.apiErrorReactions) }

    private suspend fun stats(): SyncStats = withContext(Dispatchers.IO) { app.ledger.stats() }
    private fun paired(): Boolean = app.pairingStatus().paired

    val hub = HubController(
        control = app.syncControl,
        health = app.healthSummary,
        updates = app.updateStatus,
        sources = HubSources(
            serverUrl = { app.serverConfig.serverUrl },
            pairing = { app.pairingStatus() },
            stats = ::stats,
            permission = { MediaPermissions.state(application) },
            conditions = { DeviceConditionsReader.read(application) },
            circleName = { id -> circleNames.nameOf(id) },
            publishShortcuts = { isPaired, paused -> MediaSyncShortcuts.refresh(application, isPaired, paused) },
        ),
        scope = viewModelScope,
    )

    val folders = FoldersController(
        control = app.syncControl,
        paired = ::paired,
        permission = { MediaPermissions.state(application) },
        inventory = { withContext(Dispatchers.IO) { app.mediaScanner.inventory() } },
        stats = ::stats,
        scope = viewModelScope,
    )

    val network = NetworkController(
        control = app.syncControl,
        paired = ::paired,
        summaryPref = SummaryNotificationPrefs.create(application),
        scope = viewModelScope,
    )

    val files = FilesController(
        ledger = object : FilesLedger {
            override suspend fun filesIn(states: Collection<SyncFileState>, limit: Int): List<SyncFileEntity> =
                withContext(Dispatchers.IO) { app.ledger.filesIn(states, limit) }
            override suspend fun stats(): SyncStats = this@MediaSyncViewModel.stats()
            override suspend fun retry(id: Long): Boolean = withContext(Dispatchers.IO) { app.ledger.retry(id) }
            override suspend fun retryBlocked(): Int = withContext(Dispatchers.IO) { app.ledger.retryBlocked() }
        },
        control = app.syncControl,
        paired = ::paired,
        scope = viewModelScope,
    )
}
