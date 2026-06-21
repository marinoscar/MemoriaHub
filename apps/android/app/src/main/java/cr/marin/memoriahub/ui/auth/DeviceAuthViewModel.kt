package cr.marin.memoriahub.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cr.marin.memoriahub.data.repo.DeviceAuthEvent
import cr.marin.memoriahub.data.repo.DeviceAuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

enum class DeviceAuthStatus { Requesting, AwaitingApproval, Authorizing, Failed }

data class DeviceAuthUiState(
    val status: DeviceAuthStatus = DeviceAuthStatus.Requesting,
    val userCode: String? = null,
    val verificationUri: String? = null,
    val verificationUriComplete: String? = null,
    val error: String? = null,
)

@HiltViewModel
class DeviceAuthViewModel @Inject constructor(
    private val repository: DeviceAuthRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(DeviceAuthUiState())
    val state: StateFlow<DeviceAuthUiState> = _state.asStateFlow()

    private var job: Job? = null

    init {
        start()
    }

    fun start() {
        job?.cancel()
        _state.value = DeviceAuthUiState(status = DeviceAuthStatus.Requesting)
        job = viewModelScope.launch {
            repository.authorize()
                .catch { e ->
                    _state.update {
                        it.copy(status = DeviceAuthStatus.Failed, error = e.message ?: "Network error")
                    }
                }
                .collect { event ->
                    when (event) {
                        is DeviceAuthEvent.CodeReady -> _state.update {
                            it.copy(
                                status = DeviceAuthStatus.AwaitingApproval,
                                userCode = event.code.userCode,
                                verificationUri = event.code.verificationUri,
                                verificationUriComplete = event.code.verificationUriComplete,
                                error = null,
                            )
                        }
                        is DeviceAuthEvent.Authorized -> _state.update {
                            // RootViewModel observes the new logged-in state and navigates away.
                            it.copy(status = DeviceAuthStatus.Authorizing)
                        }
                        is DeviceAuthEvent.Failed -> _state.update {
                            it.copy(status = DeviceAuthStatus.Failed, error = event.message)
                        }
                    }
                }
        }
    }

    fun retry() = start()
}
