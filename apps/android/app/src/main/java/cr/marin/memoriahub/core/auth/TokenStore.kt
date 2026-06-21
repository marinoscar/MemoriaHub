package cr.marin.memoriahub.core.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Secure storage for the device-flow JWT access token and refresh token, backed
 * by [EncryptedSharedPreferences] (AES-256 via the Android Keystore).
 *
 * Reads are synchronous so the OkHttp [cr.marin.memoriahub.core.network.AuthInterceptor]
 * and [cr.marin.memoriahub.core.network.TokenAuthenticator] can use them on network
 * threads. [authState] drives navigation between the auth and main flows.
 */
@Singleton
class TokenStore @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val prefs: SharedPreferences = run {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "secure_tokens",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private val _authState = MutableStateFlow(currentState())
    val authState: StateFlow<AuthState> = _authState.asStateFlow()

    val accessToken: String? get() = prefs.getString(KEY_ACCESS, null)

    val refreshToken: String? get() = prefs.getString(KEY_REFRESH, null)

    /** Epoch millis at which the access token expires (best-effort, from expiresIn). */
    val accessExpiresAt: Long get() = prefs.getLong(KEY_ACCESS_EXPIRES_AT, 0L)

    val isLoggedIn: Boolean get() = !accessToken.isNullOrEmpty()

    /** Persist the full token pair after a successful device-flow exchange. */
    fun saveTokens(accessToken: String, refreshToken: String?, expiresInSeconds: Long?, nowMillis: Long) {
        prefs.edit().apply {
            putString(KEY_ACCESS, accessToken)
            if (refreshToken != null) putString(KEY_REFRESH, refreshToken)
            if (expiresInSeconds != null) {
                putLong(KEY_ACCESS_EXPIRES_AT, nowMillis + expiresInSeconds * 1000L)
            }
        }.apply()
        _authState.value = AuthState.LoggedIn
    }

    /** Update just the access token (and optionally a rotated refresh token) after a refresh. */
    fun updateAfterRefresh(accessToken: String, rotatedRefreshToken: String?, expiresInSeconds: Long?, nowMillis: Long) {
        prefs.edit().apply {
            putString(KEY_ACCESS, accessToken)
            if (!rotatedRefreshToken.isNullOrEmpty()) putString(KEY_REFRESH, rotatedRefreshToken)
            if (expiresInSeconds != null) {
                putLong(KEY_ACCESS_EXPIRES_AT, nowMillis + expiresInSeconds * 1000L)
            }
        }.apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
        _authState.value = AuthState.LoggedOut
    }

    private fun currentState(): AuthState =
        if (!prefs.getString(KEY_ACCESS, null).isNullOrEmpty()) AuthState.LoggedIn else AuthState.LoggedOut

    private companion object {
        const val KEY_ACCESS = "access_token"
        const val KEY_REFRESH = "refresh_token"
        const val KEY_ACCESS_EXPIRES_AT = "access_expires_at"
    }
}
