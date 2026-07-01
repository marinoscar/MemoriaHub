package cr.marin.memoriahub.ui.folders

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cr.marin.memoriahub.core.storage.AppConfigStore
import cr.marin.memoriahub.data.repo.SyncFolder
import cr.marin.memoriahub.data.repo.SyncRepository
import cr.marin.memoriahub.sync.SyncScheduler
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class FolderSelectionUiState(
    val folders: List<SyncFolder> = emptyList(),
    val loading: Boolean = true,
    val error: String? = null,
)

@HiltViewModel
class FolderSelectionViewModel @Inject constructor(
    private val syncRepository: SyncRepository,
    private val appConfigStore: AppConfigStore,
    private val syncScheduler: SyncScheduler,
) : ViewModel() {

    private val _state = MutableStateFlow(FolderSelectionUiState())
    val state: StateFlow<FolderSelectionUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { syncRepository.listSyncableFolders() }
                .onSuccess { folders -> _state.update { it.copy(folders = folders, loading = false) } }
                .onFailure { err ->
                    _state.update { it.copy(loading = false, error = err.message ?: "Failed to list folders") }
                }
        }
    }

    fun toggle(bucketId: String, enabled: Boolean) {
        // Optimistic UI update so the switch feels instant.
        _state.update { st ->
            st.copy(folders = st.folders.map { if (it.id == bucketId) it.copy(selected = enabled) else it })
        }
        viewModelScope.launch {
            // Materialize the current effective selection from the displayed flags — this
            // resolves the "null default = camera folders" rule into a concrete set.
            val selection = _state.value.folders.filter { it.selected }.map { it.id }.toSet()
            appConfigStore.setSelectedBucketIds(selection)

            // Deselecting: drop this folder's not-yet-uploaded items so they stop syncing.
            if (!enabled) syncRepository.dropPendingForBuckets(listOf(bucketId))

            // Force a full re-scan so newly selected folders get queued, then kick a
            // sync. Resetting the persisted marks (rather than flagging the work
            // request) survives request replacement and process death.
            appConfigStore.resetScanMarks()
            syncScheduler.syncNow()
        }
    }
}
