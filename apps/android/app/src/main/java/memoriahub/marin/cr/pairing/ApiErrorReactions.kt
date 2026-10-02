package memoriahub.marin.cr.pairing

import memoriahub.marin.cr.auth.TokenStore
import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.net.MediaSyncReasons
import memoriahub.marin.cr.sync.SyncScheduling

/** What [ApiErrorReactions.handle] did with a failed authenticated call. */
enum class ApiErrorReaction {
    /** Nothing pairing-related: the caller handles the error itself. */
    NONE,

    /** 401: the server no longer accepts the paired token; `pairingExpired` set, re-pair notification posted. */
    PAIRING_EXPIRED,

    /** 409 `DEVICE_REVOKED`: the device was unpaired elsewhere; token and device id forgotten, work cancelled. */
    DEVICE_REVOKED,
}

/**
 * The global reactions every caller of an authenticated Media Sync route applies to a failure
 * (docs/specs/android-media-sync.md §7, "Global error reactions"). Upload (#511), check-in and
 * the workers (#512) and diagnostics (#514) route every [ApiResult.Failure] through [handle]
 * (or wrap a call in [check]) and then stop their run when the result is not [ApiErrorReaction.NONE].
 *
 * - **401** → `pairingExpired = true`; the "Pairing expired — re-pair" notification is posted once
 *   per expiry (only on the transition), with content intent `EXTRA_OPEN=connect`. The token is
 *   KEPT so diagnostics can still describe it; the Connect screen offers Re-pair.
 * - **409 `details.reason: DEVICE_REVOKED`** → token, expiry and device id cleared (the
 *   [TokenStore.installationId] survives), pairing state reset and all sync work cancelled.
 *
 * Only for authenticated calls: the device-flow routes are public and never pass through here.
 */
class ApiErrorReactions(
    private val tokens: TokenStore,
    private val state: PairingStateStore,
    private val scheduler: () -> SyncScheduling,
    private val notifier: PairingNotifier,
) {
    fun handle(error: ApiError): ApiErrorReaction = when {
        error.httpStatus == 401 -> {
            if (tokens.isPaired) {
                val newlyExpired = !state.pairingExpired
                state.pairingExpired = true
                if (newlyExpired) {
                    AppLog.w(TAG, "The server refused the paired token (401); pairing marked expired")
                    notifier.notifyPairingExpired()
                }
            }
            ApiErrorReaction.PAIRING_EXPIRED
        }
        error.httpStatus == 409 && error.reason == MediaSyncReasons.DEVICE_REVOKED -> {
            AppLog.w(TAG, "The server says this device was unpaired (409 DEVICE_REVOKED); forgetting the pairing")
            scheduler().cancelAll()
            tokens.clear()
            state.reset()
            notifier.cancelPairingExpired()
            ApiErrorReaction.DEVICE_REVOKED
        }
        else -> ApiErrorReaction.NONE
    }

    /** Applies [handle] to a failed [result] and returns it unchanged. */
    fun <T> check(result: ApiResult<T>): ApiResult<T> {
        if (result is ApiResult.Failure) handle(result.error)
        return result
    }

    private companion object {
        const val TAG = "Pairing"
    }
}
