package memoriahub.marin.cr.pairing

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class PairingPhase { IDLE, REQUESTING_CODE, WAITING_FOR_APPROVAL, REGISTERING, UNPAIRING }

/** What the Connect screen renders (docs/specs/android-media-sync.md §7, "Connect screen states"). */
data class PairingUiState(
    val serverConfigured: Boolean = false,
    val status: PairingStatus = PairingStatus(),
    val phase: PairingPhase = PairingPhase.IDLE,
    val userCode: String? = null,
    val verificationUri: String? = null,
    val verificationUriComplete: String? = null,
    val secondsRemaining: Long? = null,
    val note: String? = null,
    val error: String? = null,
    val canRetryRegistration: Boolean = false,
    /** Set when unpairing could not reach the server; the UI offers "Remove from this phone". */
    val unpairFailure: String? = null,
    val justPaired: Boolean = false,
) {
    /** The screen's state row: which block of copy and buttons to show while [phase] is IDLE. */
    val view: ConnectView
        get() = when {
            !serverConfigured -> ConnectView.NO_SERVER
            phase != PairingPhase.IDLE -> ConnectView.BUSY
            status.expired -> ConnectView.EXPIRED
            status.paired -> ConnectView.PAIRED
            status.registrationPending -> ConnectView.TOKEN_NO_DEVICE
            else -> ConnectView.NOT_PAIRED
        }
}

/** The Connect states of the issue/spec table (plus BUSY for the code/registering/unpairing phases). */
enum class ConnectView { NO_SERVER, NOT_PAIRED, BUSY, PAIRED, TOKEN_NO_DEVICE, EXPIRED }

/**
 * The Connect screen's state machine, as plain Kotlin over [PairingManager] so it is JVM-tested;
 * `mediasync/PairingViewModel` only gives it a `viewModelScope`. Polling runs in [scope], so
 * leaving the screen for the browser (Custom Tab) and rotating do not cancel it.
 *
 * [onPairingChanged] fires after a successful pair or unpair (#512/#513 refresh the hub there).
 */
class PairingController(
    private val manager: PairingManager,
    private val serverConfigured: () -> Boolean,
    private val scope: CoroutineScope,
    private val onPairingChanged: () -> Unit = {},
) {
    private var job: Job? = null

    private val _state = MutableStateFlow(PairingUiState(serverConfigured = serverConfigured(), status = manager.status()))
    val state: StateFlow<PairingUiState> = _state.asStateFlow()

    private val openUrlChannel = Channel<String>(Channel.BUFFERED)

    /** URLs to open in a Custom Tab (the activation page). */
    val openUrl: Flow<String> = openUrlChannel.receiveAsFlow()

    val busy: Boolean get() = job?.isActive == true

    fun refreshStatus() {
        _state.update { it.copy(serverConfigured = serverConfigured(), status = manager.status()) }
    }

    fun startPairing() {
        if (busy) return
        _state.update { PairingUiState(serverConfigured = it.serverConfigured, status = it.status, phase = PairingPhase.REQUESTING_CODE) }
        job = scope.launch { finish(manager.pair(::onEvent)) }
    }

    fun retryRegistration() {
        if (busy) return
        _state.update { it.copy(phase = PairingPhase.REGISTERING, error = null, canRetryRegistration = false) }
        job = scope.launch { finish(manager.register()) }
    }

    /** The `memoriahub://media-sync/paired` return: poll the pending code now. */
    fun pokeNow() = manager.pokeNow()

    fun cancel() {
        job?.cancel()
        job = null
        _state.value = idle()
    }

    fun reopenActivationPage() {
        val s = _state.value
        (s.verificationUriComplete ?: s.verificationUri)?.let { openUrlChannel.trySend(it) }
    }

    fun unpair(forgetLocallyOnFailure: Boolean = false) {
        if (busy) return
        _state.update { it.copy(phase = PairingPhase.UNPAIRING, unpairFailure = null, error = null) }
        job = scope.launch {
            when (val result = manager.unpair(forgetLocallyOnFailure)) {
                UnpairResult.Done -> {
                    _state.value = idle(note = "This phone is no longer paired.")
                    onPairingChanged()
                }
                is UnpairResult.ServerUnreachable ->
                    _state.update { it.copy(phase = PairingPhase.IDLE, unpairFailure = result.message) }
            }
        }
    }

    fun dismissUnpairFailure() {
        _state.update { it.copy(unpairFailure = null) }
    }

    fun consumeJustPaired() {
        _state.update { it.copy(justPaired = false) }
    }

    private fun onEvent(event: PairingEvent) {
        when (event) {
            is PairingEvent.CodeReady -> {
                _state.update {
                    it.copy(
                        phase = PairingPhase.WAITING_FOR_APPROVAL,
                        userCode = event.userCode,
                        verificationUri = event.verificationUri,
                        verificationUriComplete = event.verificationUriComplete,
                        secondsRemaining = event.expiresInSeconds.toLong(),
                    )
                }
                openUrlChannel.trySend(event.verificationUriComplete)
            }
            is PairingEvent.Progress -> when (val p = event.progress) {
                is PollProgress.Waiting -> _state.update { it.copy(secondsRemaining = p.secondsRemaining, note = null) }
                is PollProgress.SlowedDown -> Unit
                is PollProgress.NetworkTrouble -> _state.update { it.copy(note = "Connection trouble, still trying… (${p.message})") }
            }
            PairingEvent.Registering -> _state.update { it.copy(phase = PairingPhase.REGISTERING, note = null) }
        }
    }

    private fun finish(result: PairingResult) {
        when (result) {
            is PairingResult.Paired -> {
                _state.value = idle(note = "Paired. The first sync will start shortly.").copy(justPaired = true)
                onPairingChanged()
            }
            is PairingResult.Failed -> _state.value = idle().copy(
                error = result.message,
                canRetryRegistration = result.canRetryRegistration,
            )
        }
    }

    private fun idle(note: String? = null) =
        PairingUiState(serverConfigured = serverConfigured(), status = manager.status(), note = note)
}
