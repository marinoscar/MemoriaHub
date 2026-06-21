package cr.marin.memoriahub.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cr.marin.memoriahub.core.auth.AuthState
import cr.marin.memoriahub.core.auth.TokenStore
import cr.marin.memoriahub.core.storage.AppConfigStore
import cr.marin.memoriahub.sync.SyncScheduler
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

enum class RootDestination { Loading, ServerUrl, Auth, Main }

@HiltViewModel
class RootViewModel @Inject constructor(
    appConfigStore: AppConfigStore,
    tokenStore: TokenStore,
    private val syncScheduler: SyncScheduler,
) : ViewModel() {

    private var scheduledThisProcess = false

    /** Ensures background sync is scheduled once the user is in the main app. */
    fun onMainVisible() {
        if (scheduledThisProcess) return
        scheduledThisProcess = true
        syncScheduler.ensureScheduled()
        syncScheduler.syncNow()
    }

    val destination: StateFlow<RootDestination> =
        combine(appConfigStore.serverUrlFlow, tokenStore.authState) { url, auth ->
            when {
                url.isNullOrEmpty() -> RootDestination.ServerUrl
                auth == AuthState.LoggedOut -> RootDestination.Auth
                else -> RootDestination.Main
            }
        }.stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5_000),
            initialValue = RootDestination.Loading,
        )
}
