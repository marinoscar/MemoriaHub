package memoriahub.marin.cr.pairing

import memoriahub.marin.cr.auth.TokenStore
import java.time.Instant

/**
 * Pairing as stored on the phone (docs/specs/android-media-sync.md §7). Derived from the
 * persisted [TokenStore] and [PairingStateStore], so it survives process death.
 *
 * - [hasToken]: a PAT is stored.
 * - [paired]: a PAT and a registered device id, and not [expired]. Sync runs only when true.
 * - [expired]: the server refused the token (401), or its expiry has passed.
 * - [registrationPending]: signed in (token stored) but the phone is not registered yet.
 */
data class PairingStatus(
    val hasToken: Boolean = false,
    val deviceId: String? = null,
    val expired: Boolean = false,
    val tokenExpiresAt: Instant? = null,
    val pairedAt: Instant? = null,
) {
    val paired: Boolean get() = hasToken && deviceId != null && !expired
    val registrationPending: Boolean get() = hasToken && deviceId == null && !expired

    companion object {
        fun read(tokens: TokenStore, state: PairingStateStore, now: Instant = Instant.now()): PairingStatus {
            val hasToken = tokens.isPaired
            val expiresAt = tokens.expiresAt
            return PairingStatus(
                hasToken = hasToken,
                deviceId = tokens.deviceId,
                expired = hasToken && (state.pairingExpired || (expiresAt != null && !expiresAt.isAfter(now))),
                tokenExpiresAt = expiresAt,
                pairedAt = state.pairedAt,
            )
        }
    }
}
