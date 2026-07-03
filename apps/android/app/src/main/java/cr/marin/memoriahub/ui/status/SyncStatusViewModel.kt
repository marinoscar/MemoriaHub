package cr.marin.memoriahub.ui.status

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cr.marin.memoriahub.core.storage.AppConfigStore
import cr.marin.memoriahub.data.db.SyncFileEntity
import cr.marin.memoriahub.data.db.SyncRunEntity
import cr.marin.memoriahub.data.db.SyncStatus
import cr.marin.memoriahub.data.repo.SyncRepository
import cr.marin.memoriahub.sync.BackupController
import cr.marin.memoriahub.sync.SyncScheduler
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

data class SyncStatusUiState(
    val synced: Int = 0,
    val pending: Int = 0,
    val syncing: Int = 0,
    val failed: Int = 0,
    val backupEnabled: Boolean = true,
    val lastRun: SyncRunEntity? = null,
    val failures: List<SyncFileEntity> = emptyList(),
)

@HiltViewModel
class SyncStatusViewModel @Inject constructor(
    private val syncRepository: SyncRepository,
    private val syncScheduler: SyncScheduler,
    private val backupController: BackupController,
    appConfigStore: AppConfigStore,
) : ViewModel() {

    val state: StateFlow<SyncStatusUiState> = combine(
        syncRepository.observeStatusCounts(),
        syncRepository.observeLatestRun(),
        syncRepository.observeFailures(),
        appConfigStore.backupEnabledFlow,
    ) { counts, lastRun, failures, backupEnabled ->
        val byStatus = counts.associate { it.status to it.count }
        SyncStatusUiState(
            synced = (byStatus[SyncStatus.UPLOADED] ?: 0) + (byStatus[SyncStatus.SKIPPED] ?: 0),
            pending = byStatus[SyncStatus.QUEUED] ?: 0,
            syncing = (byStatus[SyncStatus.HASHING] ?: 0) + (byStatus[SyncStatus.UPLOADING] ?: 0),
            failed = (byStatus[SyncStatus.FAILED] ?: 0) + (byStatus[SyncStatus.BLOCKED] ?: 0),
            backupEnabled = backupEnabled,
            lastRun = lastRun,
            failures = failures,
        )
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = SyncStatusUiState(),
    )

    fun syncNow() {
        syncScheduler.syncNow()
    }

    fun turnOnBackup() {
        backupController.turnOn()
    }

    fun retryFailed() {
        viewModelScope.launch {
            syncRepository.requeueFailed(includeBlocked = true)
            syncScheduler.syncNow()
        }
    }
}
