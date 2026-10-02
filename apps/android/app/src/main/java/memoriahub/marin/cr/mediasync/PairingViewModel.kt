package memoriahub.marin.cr.mediasync

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import memoriahub.marin.cr.MobileApplication
import memoriahub.marin.cr.pairing.PairingController
import memoriahub.marin.cr.pairing.PairingUiState

/**
 * Hosts a [PairingController] in `viewModelScope`, so polling survives rotation and the trip to
 * the browser. All logic lives in the controller (JVM-tested).
 */
class PairingViewModel(application: Application) : AndroidViewModel(application) {
    private val app = MobileApplication.from(application)

    val controller = PairingController(
        manager = app.newPairingManager(),
        serverConfigured = { app.serverConfig.isConfigured },
        scope = viewModelScope,
    )

    val state: StateFlow<PairingUiState> get() = controller.state
    val openUrl: Flow<String> get() = controller.openUrl
}
