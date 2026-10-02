package memoriahub.marin.cr.pairing

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import memoriahub.marin.cr.auth.SharedPrefsTokenStore
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.net.RegisterDeviceRequest
import memoriahub.marin.cr.testing.FakeDevicesApi
import memoriahub.marin.cr.testing.FakeNotifier
import memoriahub.marin.cr.testing.FakeScheduler
import memoriahub.marin.cr.testing.FakeSharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PairingControllerTest {
    private val grant = DeviceCodeGrant("dc", "ABCD-1234", "https://e/activate", "https://e/activate?code=ABCD-1234", 900, 5)
    private val tokens = SharedPrefsTokenStore(FakeSharedPreferences())
    private val state = SharedPrefsPairingStateStore(FakeSharedPreferences())
    private val devices = FakeDevicesApi()
    private val scheduler = FakeScheduler()
    private var serverConfigured = true
    private var changes = 0

    private fun TestScope.controller(poll: ApiResult<DeviceCredential>): PairingController {
        val transport = object : DeviceFlowTransport {
            override suspend fun requestCode(clientInfo: DeviceClientInfo) = ApiResult.Success(grant, 200)
            override suspend fun pollToken(deviceCode: String) = poll
        }
        val manager = PairingManager(
            transport, DeviceFlowPoller(transport, sleep = {}), devices, tokens, state, { scheduler }, FakeNotifier(),
            { DeviceInfo.clientInfo("Google", "Pixel 8", "2.0.0") },
            { RegisterDeviceRequest(installationId = it, name = "n") },
        )
        // Not backgroundScope: advanceUntilIdle() does not drive background tasks.
        val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        return PairingController(manager, { serverConfigured }, scope, onPairingChanged = { changes++ })
    }

    private val approved = ApiResult.Success(DeviceCredential("pat_new", credentialType = "pat"), 200)

    @Test fun `no server comes first`() = runTest {
        serverConfigured = false
        assertEquals(ConnectView.NO_SERVER, controller(approved).state.value.view)
    }

    @Test fun `pairing opens the activation page and ends paired`() = runTest {
        val c = controller(approved)
        assertEquals(ConnectView.NOT_PAIRED, c.state.value.view)
        c.startPairing()
        assertEquals(PairingPhase.REQUESTING_CODE, c.state.value.phase)
        assertEquals(ConnectView.BUSY, c.state.value.view)
        advanceUntilIdle()
        assertEquals("https://e/activate?code=ABCD-1234", c.openUrl.first())
        val s = c.state.value
        assertEquals(ConnectView.PAIRED, s.view)
        assertTrue(s.justPaired)
        assertEquals(1, changes)
        assertNull(s.error)
    }

    @Test fun `a failed registration shows the token-without-device state with retry`() = runTest {
        devices.registerResult = FakeDevicesApi.networkError()
        val c = controller(approved)
        c.startPairing()
        advanceUntilIdle()
        assertEquals(ConnectView.TOKEN_NO_DEVICE, c.state.value.view)
        assertTrue(c.state.value.canRetryRegistration)

        devices.registerResult = ApiResult.Success(memoriahub.marin.cr.net.MediaSyncDevice("dev-2"), 200)
        c.retryRegistration()
        advanceUntilIdle()
        assertEquals(ConnectView.PAIRED, c.state.value.view)
    }

    @Test fun `an expired pairing shows the expired state`() = runTest {
        tokens.setToken("pat_old", null)
        tokens.setDeviceId("dev-1")
        state.pairingExpired = true
        assertEquals(ConnectView.EXPIRED, controller(approved).state.value.view)
    }

    @Test fun `unpair failure offers removal from this phone`() = runTest {
        tokens.setToken("pat_old", null)
        tokens.setDeviceId("dev-1")
        devices.unregisterResult = FakeDevicesApi.networkError()
        val c = controller(approved)
        c.unpair()
        advanceUntilIdle()
        assertTrue(c.state.value.unpairFailure != null)
        assertEquals(ConnectView.PAIRED, c.state.value.view)
        c.unpair(forgetLocallyOnFailure = true)
        advanceUntilIdle()
        assertEquals(ConnectView.NOT_PAIRED, c.state.value.view)
        assertEquals(1, changes)
    }

    @Test fun `cancel returns to idle`() = runTest {
        val pending = ApiResult.Failure(
            memoriahub.marin.cr.net.ApiError(memoriahub.marin.cr.net.ApiError.Kind.HTTP, 400, message = "x", oauthError = "authorization_pending"),
        )
        val c = controller(pending)
        c.startPairing()
        c.cancel()
        advanceUntilIdle()
        assertEquals(ConnectView.NOT_PAIRED, c.state.value.view)
        assertEquals(PairingPhase.IDLE, c.state.value.phase)
    }
}
