package memoriahub.marin.cr.pairing

import memoriahub.marin.cr.auth.TokenStore
import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.net.MediaSyncDevicesApi
import memoriahub.marin.cr.net.MediaSyncReasons
import memoriahub.marin.cr.net.RegisterDeviceRequest
import memoriahub.marin.cr.sync.SyncScheduling
import memoriahub.marin.cr.sync.SyncTrigger
import java.time.Instant

/** Events of one pairing attempt, for the Connect screen. */
sealed interface PairingEvent {
    /** The code is ready: show [userCode] and open [verificationUriComplete] in a Custom Tab. */
    data class CodeReady(
        val userCode: String,
        val verificationUriComplete: String,
        val verificationUri: String,
        val expiresInSeconds: Int,
    ) : PairingEvent

    data class Progress(val progress: PollProgress) : PairingEvent
    data object Registering : PairingEvent
}

sealed interface PairingResult {
    data class Paired(val deviceId: String, val tokenExpiresAt: Instant?) : PairingResult
    data class Failed(val message: String, val canRetryRegistration: Boolean = false) : PairingResult
}

sealed interface UnpairResult {
    data object Done : UnpairResult

    /** The server could not be reached; [message] says why. The caller may forget locally anyway. */
    data class ServerUnreachable(val message: String) : UnpairResult
}

/**
 * Pairing = RFC 8628 device flow for a `pat_` token, then `POST /api/media-sync/devices`
 * (docs/specs/android-media-sync.md §7).
 *
 * 1. [pair] requests a code and emits [PairingEvent.CodeReady]; the UI opens the activation page
 *    in a Custom Tab (Chrome's cookie jar is shared with the TWA, so the user only approves).
 * 2. The code is polled ([DeviceFlowPoller]); [pokeNow] (the `memoriahub://media-sync/paired`
 *    deep link) cuts the wait short.
 * 3. On approval the token is stored **immediately**, so a failed registration can be retried
 *    ([register]) without a second approval. Re-pairing replaces the token in place and reuses
 *    the [TokenStore.installationId], so the server updates the same device row and revokes the
 *    previous token.
 * 4. [register] stores the device id, then calls [SyncScheduling.ensurePeriodic] and
 *    [SyncScheduling.syncNow] ([SyncTrigger.INITIAL]) — the #512 seam.
 *
 * Plain Kotlin over interfaces; the view model and tests construct it with fakes.
 */
class PairingManager(
    private val transport: DeviceFlowTransport,
    private val poller: DeviceFlowPoller,
    private val devices: MediaSyncDevicesApi,
    private val tokens: TokenStore,
    private val state: PairingStateStore,
    /** Read on every use: #512 swaps the WorkManager implementation in. */
    private val scheduler: () -> SyncScheduling,
    private val notifier: PairingNotifier,
    /** Client info for the device-code request. */
    private val clientInfo: () -> DeviceClientInfo,
    /** Registration body for this phone (installation id filled in here). */
    private val deviceRegistration: (installationId: String) -> RegisterDeviceRequest,
    private val clock: () -> Instant = Instant::now,
) {
    /** Pairing as stored on the phone. */
    fun status(): PairingStatus = PairingStatus.read(tokens, state, clock())

    /** Poll the pending device code now (as soon as the server allows); a no-op when none is pending. */
    fun pokeNow() = poller.pokeNow()

    suspend fun pair(onEvent: (PairingEvent) -> Unit): PairingResult {
        AppLog.i(TAG, "Pairing started")
        val grant = when (val code = transport.requestCode(clientInfo())) {
            is ApiResult.Success -> code.value
            is ApiResult.Failure -> return failed("Could not start pairing: ${code.error.message}")
        }
        onEvent(
            PairingEvent.CodeReady(
                userCode = grant.userCode,
                verificationUriComplete = grant.activationUri,
                verificationUri = grant.verificationUri,
                expiresInSeconds = grant.expiresIn,
            ),
        )

        return when (val polled = poller.poll(grant) { onEvent(PairingEvent.Progress(it)) }) {
            is PollResult.Approved -> {
                val expiresAt = polled.credential.expiryInstant(clock())
                tokens.setToken(polled.credential.accessToken, expiresAt)
                tokens.setDeviceId(null)
                state.pairingExpired = false
                AppLog.i(TAG, "Pairing approved; token stored (expires ${expiresAt ?: "unknown"})")
                onEvent(PairingEvent.Registering)
                register()
            }
            PollResult.Denied -> failed("Pairing was denied in the browser. Nothing was saved.")
            PollResult.Expired -> failed("The pairing code expired. Start again.")
            is PollResult.Failed -> failed(polled.message)
        }
    }

    /** Registers this phone with the stored token (after pairing, or to retry a failed registration). */
    suspend fun register(): PairingResult {
        if (!tokens.isPaired) return failed("Not signed in: pair again.")
        return when (val result = devices.register(deviceRegistration(tokens.installationId))) {
            is ApiResult.Success -> {
                val device = result.value
                AppLog.i(TAG, "Phone registered as device ${device.id}")
                tokens.setDeviceId(device.id)
                state.pairingExpired = false
                if (state.pairedAt == null) state.pairedAt = clock()
                notifier.cancelPairingExpired()
                val sync = scheduler()
                sync.ensurePeriodic()
                sync.syncNow(SyncTrigger.INITIAL)
                PairingResult.Paired(device.id, tokens.expiresAt)
            }
            is ApiResult.Failure -> registrationFailed(result.error)
        }
    }

    private fun registrationFailed(error: ApiError): PairingResult.Failed = when {
        // A token the server refuses right after issuing it cannot be retried: start over.
        error.isUnauthorized -> {
            tokens.clear()
            failed("The server refused the new token: pair again.")
        }
        error.reason == MediaSyncReasons.NO_TARGET_CIRCLE -> failed(
            "Your account has no circle this phone can upload to. Create a circle or ask to be added as a " +
                "collaborator, then retry.",
            canRetryRegistration = true,
        )
        error.reason == MediaSyncReasons.PAT_REQUIRED -> {
            tokens.clear()
            failed("The server did not accept this phone's credential as a device token: pair again.")
        }
        else -> failed("Could not register this phone: ${error.message}", canRetryRegistration = true)
    }

    /**
     * Unpairs on the server (`DELETE /api/media-sync/devices/:id`, which also revokes the token),
     * then forgets the pairing here. A server that already forgot the device (401/404/409) counts
     * as done. When the server cannot be reached the pairing is kept and [UnpairResult.ServerUnreachable]
     * is returned, unless [forgetLocallyOnFailure].
     */
    suspend fun unpair(forgetLocallyOnFailure: Boolean = false): UnpairResult {
        val deviceId = tokens.deviceId
        if (deviceId != null && tokens.isPaired) {
            when (val result = devices.unregister(deviceId)) {
                is ApiResult.Success -> Unit
                is ApiResult.Failure -> {
                    val status = result.error.httpStatus
                    val alreadyGone = status == 401 || status == 404 || status == 409
                    if (!alreadyGone && !forgetLocallyOnFailure) {
                        AppLog.w(TAG, "Unpair: server unreachable (${result.error.kind})")
                        return UnpairResult.ServerUnreachable(result.error.message)
                    }
                }
            }
        }
        forgetLocally()
        return UnpairResult.Done
    }

    /** Forgets the pairing on this phone only: cancels work, clears token and device id (keeps the installation id). */
    fun forgetLocally() {
        AppLog.i(TAG, "Pairing removed from this phone")
        scheduler().cancelAll()
        tokens.clear()
        state.reset()
        notifier.cancelPairingExpired()
    }

    private fun failed(message: String, canRetryRegistration: Boolean = false): PairingResult.Failed {
        AppLog.w(TAG, "Pairing failed: $message")
        return PairingResult.Failed(message, canRetryRegistration)
    }

    private companion object {
        const val TAG = "Pairing"
    }
}
