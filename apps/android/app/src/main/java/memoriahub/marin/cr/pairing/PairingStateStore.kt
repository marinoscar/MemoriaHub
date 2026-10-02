package memoriahub.marin.cr.pairing

import android.content.Context
import android.content.SharedPreferences
import memoriahub.marin.cr.BuildConfig
import java.time.Instant

/**
 * Non-secret pairing state, persisted beside the encrypted [memoriahub.marin.cr.auth.TokenStore]
 * (plain prefs `<prefix>_pairing`; excluded from backup like every prefs file).
 *
 * - [pairingExpired]: the server answered 401 to the paired token (expired or revoked). Set by
 *   [ApiErrorReactions], cleared when a new token is stored or the pairing is forgotten.
 * - [pairedAt]: the phone's timestamp of its first successful registration of this pairing. It is
 *   the `uploadExisting = 'from_pairing'` cut-off (§5.1, §8.3, read by the ledger in #510). Kept
 *   across re-pairing in place; cleared when the pairing is forgotten (unpair or revocation).
 */
interface PairingStateStore {
    var pairingExpired: Boolean
    var pairedAt: Instant?

    /** Forgets everything above. */
    fun reset() {
        pairingExpired = false
        pairedAt = null
    }
}

class SharedPrefsPairingStateStore(private val prefs: SharedPreferences) : PairingStateStore {
    override var pairingExpired: Boolean
        get() = prefs.getBoolean(KEY_EXPIRED, false)
        set(value) {
            prefs.edit().putBoolean(KEY_EXPIRED, value).commit()
        }

    override var pairedAt: Instant?
        get() = prefs.getString(KEY_PAIRED_AT, null)?.let { runCatching { Instant.parse(it) }.getOrNull() }
        set(value) {
            prefs.edit().apply { if (value != null) putString(KEY_PAIRED_AT, value.toString()) else remove(KEY_PAIRED_AT) }.commit()
        }

    companion object {
        const val PREFS_NAME = BuildConfig.STORAGE_PREFIX + "_pairing"
        const val KEY_EXPIRED = "pairing_expired"
        const val KEY_PAIRED_AT = "paired_at"

        fun create(context: Context): PairingStateStore =
            SharedPrefsPairingStateStore(context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE))
    }
}
