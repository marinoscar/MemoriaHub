package memoriahub.marin.cr.pairing

import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.selects.select
import kotlinx.serialization.Serializable
import memoriahub.marin.cr.net.ApiClient
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import java.time.Instant

// Wire format: RFC 8628 as implemented by apps/api/src/device-auth (docs/DEVICE-AUTH.md) and
// docs/specs/android-media-sync.md §6.7. Reference client: apps/cli/src/device-auth.ts.

/**
 * `clientInfo` of `POST /api/auth/device/code`. The server allowlists exactly these keys (#499);
 * [tokenType] `pat` makes approval mint a revocable personal access token instead of a session.
 */
@Serializable
data class DeviceClientInfo(
    /** Shown on the activation page: `"<Maker Model> · Media sync"`. */
    val deviceName: String,
    val userAgent: String,
    val tokenType: String = TOKEN_TYPE_PAT,
    /** Name of the minted PAT in the user's Access Tokens list: `"MemoriaHub Android · <Model>"`. */
    val name: String? = null,
    val platform: String? = "android",
    /** Where the activation page sends the browser after approval (back into this app). */
    val returnUri: String? = null,
) {
    companion object {
        const val TOKEN_TYPE_PAT = "pat"
    }
}

@Serializable
data class DeviceCodeRequest(val clientInfo: DeviceClientInfo)

@Serializable
data class DeviceCodeGrant(
    val deviceCode: String,
    val userCode: String,
    val verificationUri: String,
    val verificationUriComplete: String? = null,
    val expiresIn: Int,
    val interval: Int = 5,
) {
    /** The page to open: with the code pre-filled when the server offers it. */
    val activationUri: String get() = verificationUriComplete ?: verificationUri
}

@Serializable
data class DeviceTokenRequest(val deviceCode: String)

/** `POST /api/auth/device/token` success. With `tokenType: "pat"` the server answers [credentialType] `"pat"`. */
@Serializable
data class DeviceCredential(
    val accessToken: String,
    val tokenType: String = "Bearer",
    val expiresIn: Long? = null,
    val credentialType: String? = null,
    val expiresAt: String? = null,
    val tokenId: String? = null,
    val tokenName: String? = null,
) {
    /** Server expiry, or now + [expiresIn] when only that is present. */
    fun expiryInstant(now: Instant): Instant? =
        expiresAt?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: expiresIn?.let { now.plusSeconds(it) }
}

/** The two device-flow calls, behind an interface so the poller and pairing are JVM-testable. */
interface DeviceFlowTransport {
    suspend fun requestCode(clientInfo: DeviceClientInfo): ApiResult<DeviceCodeGrant>
    suspend fun pollToken(deviceCode: String): ApiResult<DeviceCredential>
}

/** Both routes are public: never send a (possibly stale or revoked) bearer token. */
class ApiDeviceFlowTransport(private val api: ApiClient) : DeviceFlowTransport {
    override suspend fun requestCode(clientInfo: DeviceClientInfo): ApiResult<DeviceCodeGrant> =
        api.post(
            "/api/auth/device/code",
            DeviceCodeRequest(clientInfo),
            DeviceCodeRequest.serializer(),
            DeviceCodeGrant.serializer(),
            authenticated = false,
        )

    override suspend fun pollToken(deviceCode: String): ApiResult<DeviceCredential> =
        api.post(
            "/api/auth/device/token",
            DeviceTokenRequest(deviceCode),
            DeviceTokenRequest.serializer(),
            DeviceCredential.serializer(),
            authenticated = false,
        )
}

/** Progress reported while polling. */
sealed interface PollProgress {
    data class Waiting(val attempt: Int, val intervalSeconds: Int, val secondsRemaining: Long) : PollProgress
    data class SlowedDown(val intervalSeconds: Int) : PollProgress
    data class NetworkTrouble(val message: String) : PollProgress
}

sealed interface PollResult {
    data class Approved(val credential: DeviceCredential) : PollResult
    data object Denied : PollResult
    data object Expired : PollResult
    data class Failed(val message: String) : PollResult
}

/**
 * RFC 8628 polling state machine (mirrors `pollForDeviceToken` in the CLI):
 * - `authorization_pending` → keep polling at the interval;
 * - `slow_down` → interval + 5 s, capped at 60 s;
 * - `expired_token` → [PollResult.Expired]; `access_denied` → [PollResult.Denied];
 * - `invalid_grant` / `invalid_request` → [PollResult.Failed];
 * - network errors, 5xx/429 and an unclassifiable 4xx keep polling until the code's own deadline.
 *
 * A credential whose `credentialType` is not `pat` is **refused** ([PollResult.Failed]), so a
 * server without #499 (which would mint a 7-day session) fails loudly instead of half-working.
 *
 * Every sleep is padded by [POLL_MARGIN_MS] (the server compares with a strict `<`) and never
 * runs past the deadline.
 *
 * [pokeNow] (the activation page's redirect back to `memoriahub://media-sync/paired`) cuts the
 * current wait short. It never polls sooner than the server accepts — the grant's interval after
 * the last response — because the server answers an early poll with `slow_down`, which would
 * *lengthen* every later wait. The wait is therefore shortened only when it is longer than that
 * (after a `slow_down`, or late in a long wait).
 *
 * [sleep] and [nowMillis] are injected so tests run on a fake clock. Cancellation propagates.
 */
class DeviceFlowPoller(
    private val transport: DeviceFlowTransport,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    private val nowMillis: () -> Long = System::currentTimeMillis,
) {
    private val pokes = Channel<Unit>(Channel.CONFLATED)

    /** Polls as soon as the server allows (see the class comment). Safe from any thread. */
    fun pokeNow() {
        pokes.trySend(Unit)
    }

    suspend fun poll(grant: DeviceCodeGrant, onProgress: (PollProgress) -> Unit = {}): PollResult {
        pokes.tryReceive() // A poke from an earlier attempt means nothing for this code.
        val baseInterval = clampInterval(grant.interval)
        var interval = baseInterval
        val deadline = nowMillis() + grant.expiresIn * 1000L
        var attempt = 0
        while (true) {
            if (nowMillis() >= deadline) return PollResult.Expired
            attempt += 1
            onProgress(PollProgress.Waiting(attempt, interval, ((deadline - nowMillis()) / 1000).coerceAtLeast(0)))

            when (val result = transport.pollToken(grant.deviceCode)) {
                is ApiResult.Success -> return accept(result.value)
                is ApiResult.Failure -> when (val signal = classify(result.error)) {
                    Signal.Pending -> Unit
                    Signal.SlowDown -> {
                        interval = clampInterval(interval + SLOW_DOWN_INCREMENT_SECONDS)
                        onProgress(PollProgress.SlowedDown(interval))
                    }
                    Signal.Denied -> return PollResult.Denied
                    Signal.Expired -> return PollResult.Expired
                    is Signal.Fatal -> return PollResult.Failed(signal.message)
                    is Signal.Transient -> onProgress(PollProgress.NetworkTrouble(signal.message))
                }
            }

            val respondedAt = nowMillis()
            val earliest = respondedAt + baseInterval * 1000L + POLL_MARGIN_MS
            var wakeAt = minOf(respondedAt + interval * 1000L + POLL_MARGIN_MS, deadline)
            while (true) {
                val remaining = wakeAt - nowMillis()
                if (remaining <= 0) break
                if (sleepOrPoke(remaining)) wakeAt = minOf(wakeAt, earliest)
            }
        }
    }

    private fun accept(credential: DeviceCredential): PollResult = when {
        credential.accessToken.isBlank() -> PollResult.Failed("The server returned an empty token.")
        credential.credentialType != DeviceClientInfo.TOKEN_TYPE_PAT -> PollResult.Failed(
            "The server issued a ${credential.credentialType ?: "session"} credential instead of a personal access token. " +
                "Update the server, then pair again.",
        )
        else -> PollResult.Approved(credential)
    }

    /** Sleeps [ms], or less when [pokeNow] is called meanwhile. Returns true when poked. */
    private suspend fun sleepOrPoke(ms: Long): Boolean = coroutineScope {
        val sleeper = async { sleep(ms) }
        select {
            sleeper.onAwait { false }
            pokes.onReceive {
                sleeper.cancel()
                true
            }
        }
    }

    private sealed interface Signal {
        data object Pending : Signal
        data object SlowDown : Signal
        data object Denied : Signal
        data object Expired : Signal
        data class Fatal(val message: String) : Signal
        data class Transient(val message: String) : Signal
    }

    private fun classify(error: ApiError): Signal = when (error.oauthError) {
        "authorization_pending" -> Signal.Pending
        "slow_down" -> Signal.SlowDown
        "access_denied" -> Signal.Denied
        "expired_token" -> Signal.Expired
        "invalid_grant" -> Signal.Fatal("The server rejected this code (${error.message}). Start pairing again.")
        "invalid_request" -> Signal.Fatal("The server rejected the request (${error.message}). Start pairing again.")
        null -> when {
            error.kind == ApiError.Kind.NOT_CONFIGURED -> Signal.Fatal(error.message)
            error.kind == ApiError.Kind.NETWORK -> Signal.Transient(error.message)
            error.kind == ApiError.Kind.PARSE -> Signal.Transient(error.message)
            (error.httpStatus ?: 0) >= 500 || error.httpStatus == 429 -> Signal.Transient(error.message)
            // An unclassifiable 4xx: keep waiting (bounded by the deadline), like the CLI.
            else -> Signal.Pending
        }
        else -> Signal.Fatal("Unexpected answer from the server: ${error.oauthError}.")
    }

    companion object {
        const val SLOW_DOWN_INCREMENT_SECONDS = 5
        const val MAX_POLL_INTERVAL_SECONDS = 60
        const val POLL_MARGIN_MS = 250L

        fun clampInterval(seconds: Int): Int = seconds.coerceIn(1, MAX_POLL_INTERVAL_SECONDS)
    }
}
