package cr.marin.memoriahub.ui.serverurl

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cr.marin.memoriahub.data.repo.AuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ServerUrlUiState(
    val url: String = "",
    val isValidating: Boolean = false,
    val error: String? = null,
)

@HiltViewModel
class ServerUrlViewModel @Inject constructor(
    private val authRepository: AuthRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ServerUrlUiState())
    val state: StateFlow<ServerUrlUiState> = _state.asStateFlow()

    fun onUrlChange(value: String) {
        _state.update { it.copy(url = value, error = null) }
    }

    fun submit() {
        val raw = _state.value.url.trim()
        if (raw.isEmpty()) {
            _state.update { it.copy(error = "Enter your MemoriaHub server URL") }
            return
        }
        val normalized = normalizeUrl(raw)
        _state.update { it.copy(isValidating = true, error = null) }
        viewModelScope.launch {
            val result = authRepository.validateAndSaveServerUrl(normalized)
            // On success, RootViewModel reacts to the saved URL and navigates away.
            result.onFailure { err ->
                _state.update {
                    it.copy(
                        isValidating = false,
                        error = "Couldn't reach a MemoriaHub server at this address. " +
                            (err.message ?: ""),
                    )
                }
            }
        }
    }

    private fun normalizeUrl(input: String): String {
        val withScheme = if (input.startsWith("http://") || input.startsWith("https://")) {
            input
        } else {
            "http://$input"
        }
        return withScheme.trimEnd('/')
    }
}
