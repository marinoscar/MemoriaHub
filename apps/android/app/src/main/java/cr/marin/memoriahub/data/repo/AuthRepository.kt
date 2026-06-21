package cr.marin.memoriahub.data.repo

import cr.marin.memoriahub.core.auth.TokenStore
import cr.marin.memoriahub.core.network.api.AuthApi
import cr.marin.memoriahub.core.network.dto.CurrentUser
import cr.marin.memoriahub.core.storage.AppConfigStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AuthRepository @Inject constructor(
    private val authApi: AuthApi,
    private val tokenStore: TokenStore,
    private val appConfigStore: AppConfigStore,
) {
    /**
     * Tentatively stores [url] and verifies it points at a MemoriaHub API by hitting
     * the public providers endpoint. Restores the previous URL on failure so a bad
     * entry never sticks.
     */
    suspend fun validateAndSaveServerUrl(url: String): Result<Unit> = withContext(Dispatchers.IO) {
        val previous = appConfigStore.serverUrl
        appConfigStore.setServerUrl(url)
        runCatching {
            val response = authApi.getProviders()
            if (!response.isSuccessful) error("Server returned HTTP ${response.code()}")
        }.onFailure {
            appConfigStore.setServerUrl(previous)
        }
    }

    suspend fun fetchCurrentUser(): CurrentUser = withContext(Dispatchers.IO) {
        authApi.getMe().data
    }

    /** Best-effort server-side logout, then always clears local tokens. */
    suspend fun logout() = withContext(Dispatchers.IO) {
        runCatching { authApi.logout() }
        tokenStore.clear()
    }
}
