package memoriahub.marin.cr.testing

import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.net.MediaSyncDevice
import memoriahub.marin.cr.net.MediaSyncDevicesApi
import memoriahub.marin.cr.net.RegisterDeviceRequest
import memoriahub.marin.cr.pairing.PairingNotifier
import memoriahub.marin.cr.sync.SyncScheduling
import memoriahub.marin.cr.sync.SyncTrigger

class FakeScheduler : SyncScheduling {
    var periodic = 0
    val now = mutableListOf<SyncTrigger>()
    var cancelled = 0

    override fun ensurePeriodic() {
        periodic++
    }

    override fun syncNow(trigger: SyncTrigger) {
        now += trigger
    }

    override fun cancelAll() {
        cancelled++
    }
}

class FakeNotifier : PairingNotifier {
    var expiredPosted = 0
    var cancelled = 0

    override fun notifyPairingExpired() {
        expiredPosted++
    }

    override fun cancelPairingExpired() {
        cancelled++
    }
}

/** Scripted [MediaSyncDevicesApi]; [onRegister] observes the world at call time (e.g. the stored token). */
class FakeDevicesApi : MediaSyncDevicesApi {
    var registerResult: ApiResult<MediaSyncDevice> = ApiResult.Success(MediaSyncDevice(id = "dev-1"), 201)
    var unregisterResult: ApiResult<Unit> = ApiResult.Success(Unit, 204)
    val registrations = mutableListOf<RegisterDeviceRequest>()
    val unregistered = mutableListOf<String>()
    var onRegister: () -> Unit = {}

    override suspend fun register(request: RegisterDeviceRequest): ApiResult<MediaSyncDevice> {
        onRegister()
        registrations += request
        return registerResult
    }

    override suspend fun unregister(deviceId: String): ApiResult<Unit> {
        unregistered += deviceId
        return unregisterResult
    }

    companion object {
        fun networkError(): ApiResult.Failure =
            ApiResult.Failure(ApiError(ApiError.Kind.NETWORK, message = "Could not reach the server (ConnectException)."))

        fun httpError(status: Int, reason: String? = null): ApiResult.Failure =
            ApiResult.Failure(ApiError(ApiError.Kind.HTTP, status, message = "HTTP $status", reason = reason))
    }
}
