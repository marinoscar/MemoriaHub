package cr.marin.memoriahub.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cr.marin.memoriahub.core.network.dto.Circle
import cr.marin.memoriahub.core.storage.AppConfigStore
import cr.marin.memoriahub.data.repo.AuthRepository
import cr.marin.memoriahub.data.repo.CircleRepository
import cr.marin.memoriahub.sync.SyncScheduler
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class SettingsUiState(
    val email: String? = null,
    val displayName: String? = null,
    val serverUrl: String? = null,
    val circles: List<Circle> = emptyList(),
    val targetCircleId: String? = null,
    val loading: Boolean = true,
    val error: String? = null,
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val authRepository: AuthRepository,
    private val circleRepository: CircleRepository,
    private val appConfigStore: AppConfigStore,
    private val syncScheduler: SyncScheduler,
) : ViewModel() {

    private val _state = MutableStateFlow(
        SettingsUiState(
            serverUrl = appConfigStore.serverUrl,
            targetCircleId = appConfigStore.targetCircleId,
        ),
    )
    val state: StateFlow<SettingsUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch { appConfigStore.targetCircleIdFlow.collect { id -> _state.update { it.copy(targetCircleId = id) } } }
        load()
    }

    fun load() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching {
                val user = authRepository.fetchCurrentUser()
                val circles = circleRepository.getCircles()
                user to circles
            }.onSuccess { (user, circles) ->
                _state.update {
                    it.copy(
                        email = user.email,
                        displayName = user.displayName,
                        circles = circles,
                        loading = false,
                    )
                }
            }.onFailure { err ->
                _state.update { it.copy(loading = false, error = err.message ?: "Failed to load account") }
            }
        }
    }

    fun selectCircle(circleId: String) {
        appConfigStore.setTargetCircleId(circleId)
    }

    fun logout() {
        viewModelScope.launch {
            syncScheduler.cancelAll()
            authRepository.logout()
        }
    }
}
