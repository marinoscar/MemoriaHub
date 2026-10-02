package memoriahub.marin.cr.mediasync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import memoriahub.marin.cr.contract.ConfigPatch
import memoriahub.marin.cr.contract.NetworkMode
import memoriahub.marin.cr.contract.SyncControl
import memoriahub.marin.cr.notifications.SummaryNotificationSetting
import java.io.IOException

/** `uploadExisting` wire values (docs/specs/android-media-sync.md §5.1). */
object UploadExisting {
    const val ALL = "all"
    const val FROM_PAIRING = "from_pairing"
}

/** The Network & power screen state (§12.4). */
data class NetworkUiState(
    val loading: Boolean = true,
    val paired: Boolean = false,
    val network: NetworkMode = NetworkMode.WIFI,
    val requireCharging: Boolean = false,
    val uploadExisting: String = UploadExisting.ALL,
    val savedNetwork: NetworkMode = NetworkMode.WIFI,
    val savedRequireCharging: Boolean = false,
    val savedUploadExisting: String = UploadExisting.ALL,
    /** Local only: the "N photos backed up to <circle>" notification after a background run. */
    val summaryNotifications: Boolean = true,
    /** "Only new ones" chosen while "All" is saved: ask before excluding the existing files. */
    val confirmFromPairing: Boolean = false,
    val saving: Boolean = false,
    val message: String? = null,
    val error: String? = null,
) {
    val dirty: Boolean
        get() = network != savedNetwork || requireCharging != savedRequireCharging || uploadExisting != savedUploadExisting
    val canSave: Boolean get() = paired && dirty && !saving

    fun patch(): ConfigPatch? {
        if (!dirty) return null
        return ConfigPatch(
            network = network.takeIf { it != savedNetwork },
            requireCharging = requireCharging.takeIf { it != savedRequireCharging },
            uploadExisting = uploadExisting.takeIf { it != savedUploadExisting },
        )
    }
}

/**
 * Network & power logic (JVM-tested): Wi-Fi only vs Wi-Fi and mobile data, Only while charging,
 * Upload existing (a one-way confirm before "Only new ones"), plus the local summary-notification
 * toggle. Save PATCHes only the changed fields through [SyncControl.updateConfig]; the control
 * rebuilds the WorkManager constraints when it applies the returned config (#512).
 */
class NetworkController(
    private val control: SyncControl,
    private val paired: () -> Boolean,
    private val summaryPref: SummaryNotificationSetting,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(NetworkUiState())
    val state: StateFlow<NetworkUiState> = _state.asStateFlow()

    fun load() {
        val c = control.currentConfig()
        _state.update { s ->
            val edit = s.dirty && !s.loading
            s.copy(
                loading = false,
                paired = paired(),
                network = if (edit) s.network else c?.network ?: NetworkMode.WIFI,
                requireCharging = if (edit) s.requireCharging else c?.requireCharging ?: false,
                uploadExisting = if (edit) s.uploadExisting else c?.uploadExisting ?: UploadExisting.ALL,
                savedNetwork = c?.network ?: NetworkMode.WIFI,
                savedRequireCharging = c?.requireCharging ?: false,
                savedUploadExisting = c?.uploadExisting ?: UploadExisting.ALL,
                summaryNotifications = summaryPref.enabled,
            )
        }
    }

    fun setNetwork(mode: NetworkMode) = _state.update { it.copy(network = mode, message = null) }
    fun setRequireCharging(on: Boolean) = _state.update { it.copy(requireCharging = on, message = null) }

    /** Choosing "Only new ones" when "All" is saved needs a confirmation; the reverse is immediate. */
    fun chooseUploadExisting(value: String) = _state.update {
        if (value == UploadExisting.FROM_PAIRING && it.savedUploadExisting == UploadExisting.ALL && it.uploadExisting != value) {
            it.copy(confirmFromPairing = true)
        } else {
            it.copy(uploadExisting = value, message = null)
        }
    }

    fun confirmFromPairing() = _state.update { it.copy(uploadExisting = UploadExisting.FROM_PAIRING, confirmFromPairing = false) }
    fun cancelFromPairing() = _state.update { it.copy(confirmFromPairing = false) }

    fun setSummaryNotifications(on: Boolean) {
        summaryPref.enabled = on
        _state.update { it.copy(summaryNotifications = on) }
    }

    fun dismissMessage() = _state.update { it.copy(message = null, error = null) }

    fun save() {
        val current = _state.value
        if (!current.paired) {
            _state.update { it.copy(error = "Pair this phone first.") }
            return
        }
        val patch = current.patch() ?: return
        _state.update { it.copy(saving = true, message = null, error = null) }
        scope.launch {
            val failure = control.updateConfig(patch).exceptionOrNull()
            _state.update { s ->
                when {
                    failure == null || failure is IOException -> s.copy(
                        saving = false,
                        savedNetwork = s.network,
                        savedRequireCharging = s.requireCharging,
                        savedUploadExisting = s.uploadExisting,
                        message = if (failure == null) "Saved" else "Saved on this phone. It is sent to the server when the phone is back online.",
                    )
                    else -> s.copy(saving = false, error = "Could not save: ${failure.message ?: failure.javaClass.simpleName}")
                }
            }
        }
    }
}
