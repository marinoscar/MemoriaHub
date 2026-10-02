package memoriahub.marin.cr.pairing

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import memoriahub.marin.cr.auth.SharedPrefsTokenStore
import memoriahub.marin.cr.net.ApiClient
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiMediaSyncDevicesApi
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.net.MediaSyncDevice
import memoriahub.marin.cr.net.RegisterDeviceRequest
import memoriahub.marin.cr.sync.SyncTrigger
import memoriahub.marin.cr.testing.FakeDevicesApi
import memoriahub.marin.cr.testing.FakeNotifier
import memoriahub.marin.cr.testing.FakeScheduler
import memoriahub.marin.cr.testing.FakeSharedPreferences
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class PairingManagerTest {
    private val grant = DeviceCodeGrant("dc", "ABCD-1234", "https://e/activate", "https://e/activate?code=ABCD-1234", 900, 5)
    private val tokens = SharedPrefsTokenStore(FakeSharedPreferences())
    private val state = SharedPrefsPairingStateStore(FakeSharedPreferences())
    private val devices = FakeDevicesApi()
    private val scheduler = FakeScheduler()
    private val notifier = FakeNotifier()
    private val clock = Instant.parse("2026-10-01T00:00:00Z")

    private val approved = ApiResult.Success(
        DeviceCredential("pat_new", credentialType = "pat", expiresAt = "2026-12-30T00:00:00Z"),
        200,
    )

    private val clientInfos = mutableListOf<DeviceClientInfo>()

    private fun manager(vararg polls: ApiResult<DeviceCredential>, api: memoriahub.marin.cr.net.MediaSyncDevicesApi = devices): PairingManager {
        val queue = ArrayDeque(polls.toList())
        val transport = object : DeviceFlowTransport {
            override suspend fun requestCode(clientInfo: DeviceClientInfo): ApiResult<DeviceCodeGrant> {
                clientInfos += clientInfo
                return ApiResult.Success(grant, 200)
            }

            override suspend fun pollToken(deviceCode: String) = queue.removeFirstOrNull() ?: approved
        }
        return PairingManager(
            transport = transport,
            poller = DeviceFlowPoller(transport, sleep = {}),
            devices = api,
            tokens = tokens,
            state = state,
            scheduler = { scheduler },
            notifier = notifier,
            clientInfo = { DeviceInfo.clientInfo("Google", "Pixel 8", "2.0.0") },
            deviceRegistration = { RegisterDeviceRequest(installationId = it, name = "Google Pixel 8 · Media sync") },
            clock = { clock },
        )
    }

    @Test fun `approval stores the PAT, registers this installation and starts sync`() = runBlocking {
        state.pairingExpired = true
        val events = mutableListOf<PairingEvent>()
        val result = manager(approved).pair { events += it }

        assertEquals(PairingResult.Paired("dev-1", Instant.parse("2026-12-30T00:00:00Z")), result)
        assertEquals(
            PairingEvent.CodeReady("ABCD-1234", "https://e/activate?code=ABCD-1234", "https://e/activate", 900),
            events.first(),
        )
        assertTrue(PairingEvent.Registering in events)
        assertEquals("pat_new", tokens.token)
        assertEquals("dev-1", tokens.deviceId)
        assertEquals(tokens.installationId, devices.registrations.single().installationId)
        assertFalse(state.pairingExpired)
        assertEquals(clock, state.pairedAt)
        assertEquals(1, scheduler.periodic)
        assertEquals(listOf(SyncTrigger.INITIAL), scheduler.now)
        assertEquals(1, notifier.cancelled)
        assertTrue(manager().status().paired)
    }

    @Test fun `the code request asks for a PAT and returns to the app`() = runBlocking {
        manager(approved).pair {}
        val info = clientInfos.single()
        assertEquals("pat", info.tokenType)
        assertEquals("memoriahub://media-sync/paired", info.returnUri)
        assertEquals("Google Pixel 8 · Media sync", info.deviceName)
    }

    @Test fun `the token is saved before registration is attempted`() = runBlocking {
        var tokenAtRegister: String? = null
        var deviceAtRegister: String? = "unset"
        devices.onRegister = {
            tokenAtRegister = tokens.token
            deviceAtRegister = tokens.deviceId
        }
        manager(approved).pair {}
        assertEquals("pat_new", tokenAtRegister)
        assertNull(deviceAtRegister)
    }

    @Test fun `a failed registration keeps the token and a retry needs no new approval`() = runBlocking {
        devices.registerResult = FakeDevicesApi.networkError()
        val first = manager(approved).pair {}
        assertEquals(true, (first as PairingResult.Failed).canRetryRegistration)
        assertEquals("pat_new", tokens.token)
        assertNull(tokens.deviceId)
        assertTrue(manager().status().registrationPending)
        assertTrue(scheduler.now.isEmpty())

        devices.registerResult = ApiResult.Success(MediaSyncDevice("dev-9"), 200)
        // A manager whose transport would fail if asked: retrying registration must not poll again.
        val strict = object : DeviceFlowTransport {
            override suspend fun requestCode(clientInfo: DeviceClientInfo): ApiResult<DeviceCodeGrant> = error("no new approval")
            override suspend fun pollToken(deviceCode: String): ApiResult<DeviceCredential> = error("no new approval")
        }
        val retry = PairingManager(
            strict, DeviceFlowPoller(strict, sleep = {}), devices, tokens, state, { scheduler }, notifier,
            { error("unused") }, { RegisterDeviceRequest(installationId = it, name = "n") }, { clock },
        ).register()
        assertTrue(retry is PairingResult.Paired)
        assertEquals("dev-9", tokens.deviceId)
        assertEquals(listOf(SyncTrigger.INITIAL), scheduler.now)
    }

    @Test fun `re-pair reuses the installation id and replaces the token in place`() = runBlocking {
        val installation = tokens.installationId
        manager(approved).pair {}
        val pairedAt = state.pairedAt

        val second = ApiResult.Success(DeviceCredential("pat_second", credentialType = "pat"), 200)
        devices.registerResult = ApiResult.Success(MediaSyncDevice("dev-1"), 200)
        manager(second).pair {}

        assertEquals(listOf(installation, installation), devices.registrations.map { it.installationId })
        assertEquals("pat_second", tokens.token)
        assertEquals("dev-1", tokens.deviceId)
        assertEquals("pairedAt survives re-pairing in place", pairedAt, state.pairedAt)
    }

    @Test fun `re-pair after expiry clears the expired flag`() = runBlocking {
        tokens.setToken("pat_old", null)
        tokens.setDeviceId("dev-1")
        state.pairingExpired = true
        assertTrue(manager().status().expired)
        manager(approved).pair {}
        assertFalse(manager().status().expired)
        assertTrue(manager().status().paired)
    }

    @Test fun `denial and expiry save nothing`() = runBlocking {
        val denied = ApiResult.Failure(ApiError(ApiError.Kind.HTTP, 400, message = "x", oauthError = "access_denied"))
        assertTrue(manager(denied).pair {} is PairingResult.Failed)
        val expired = ApiResult.Failure(ApiError(ApiError.Kind.HTTP, 400, message = "x", oauthError = "expired_token"))
        assertTrue(manager(expired).pair {} is PairingResult.Failed)
        assertFalse(tokens.isPaired)
        assertTrue(devices.registrations.isEmpty())
    }

    @Test fun `a session credential is never stored`() = runBlocking {
        val session = ApiResult.Success(DeviceCredential("eyJ", credentialType = "session"), 200)
        assertTrue(manager(session).pair {} is PairingResult.Failed)
        assertFalse(tokens.isPaired)
    }

    @Test fun `a 401 on registration drops the refused token`() = runBlocking {
        devices.registerResult = FakeDevicesApi.httpError(401)
        val result = manager(approved).pair {}
        assertFalse((result as PairingResult.Failed).canRetryRegistration)
        assertFalse(tokens.isPaired)
    }

    @Test fun `NO_TARGET_CIRCLE explains the fix and can be retried`() = runBlocking {
        devices.registerResult = FakeDevicesApi.httpError(409, "NO_TARGET_CIRCLE")
        val result = manager(approved).pair {} as PairingResult.Failed
        assertTrue(result.canRetryRegistration)
        assertTrue(result.message.contains("circle"))
        assertEquals("pat_new", tokens.token)
    }

    // --- Unpair ---------------------------------------------------------------------------------

    private fun paired() {
        tokens.setToken("pat_x", null)
        tokens.setDeviceId("dev-1")
        state.pairedAt = clock
    }

    @Test fun `unpair deletes the device on the server and forgets it locally, keeping the installation id`() = runBlocking {
        paired()
        val installation = tokens.installationId
        assertEquals(UnpairResult.Done, manager().unpair())
        assertEquals(listOf("dev-1"), devices.unregistered)
        assertFalse(tokens.isPaired)
        assertNull(tokens.deviceId)
        assertNull(state.pairedAt)
        assertEquals(installation, tokens.installationId)
        assertEquals(1, scheduler.cancelled)
    }

    @Test fun `unpair treats 401, 404 and 409 as already done`() = runBlocking {
        for (status in listOf(401, 404, 409)) {
            paired()
            devices.unregisterResult = FakeDevicesApi.httpError(status, if (status == 409) "DEVICE_REVOKED" else null)
            assertEquals("HTTP $status", UnpairResult.Done, manager().unpair())
            assertFalse("HTTP $status", tokens.isPaired)
        }
        assertEquals(3, scheduler.cancelled)
    }

    @Test fun `unpair offers a local-only removal when the server is unreachable`() = runBlocking {
        paired()
        devices.unregisterResult = FakeDevicesApi.networkError()
        val m = manager()
        assertTrue(m.unpair() is UnpairResult.ServerUnreachable)
        assertTrue(tokens.isPaired)
        assertEquals(0, scheduler.cancelled)
        assertEquals(UnpairResult.Done, m.unpair(forgetLocallyOnFailure = true))
        assertFalse(tokens.isPaired)
    }

    @Test fun `a 5xx on unpair is not treated as done`() = runBlocking {
        paired()
        devices.unregisterResult = FakeDevicesApi.httpError(503)
        assertTrue(manager().unpair() is UnpairResult.ServerUnreachable)
        assertTrue(tokens.isPaired)
    }

    @Test fun `unpair with only a token (never registered) just forgets locally`() = runBlocking {
        tokens.setToken("pat_x", null)
        assertEquals(UnpairResult.Done, manager().unpair())
        assertTrue(devices.unregistered.isEmpty())
        assertFalse(tokens.isPaired)
    }

    // --- Against the real HTTP client -----------------------------------------------------------

    @Test fun `register and unpair over HTTP with the stored PAT`() = runBlocking {
        val server = MockWebServer().apply { start() }
        try {
            server.enqueue(
                MockResponse().setResponseCode(201).setBody(
                    """{"data":{"id":"6f1c","installationId":"x","name":"Google Pixel 8 · Media sync","status":"active",""" +
                        """"config":{"paused":false},"configVersion":1,"appliedConfigVersion":0,"tokenExpiresAt":null,""" +
                        """"updateAvailable":false,"unknownField":42},"meta":{"timestamp":"t"}}""",
                ),
            )
            server.enqueue(MockResponse().setResponseCode(204))
            val api = ApiMediaSyncDevicesApi(ApiClient(baseUrlProvider = { server.url("/").toString() }, tokenProvider = { tokens.token }))
            val m = manager(approved, api = api)

            val result = m.pair {}
            assertEquals(PairingResult.Paired("6f1c", Instant.parse("2026-12-30T00:00:00Z")), result)
            val register = server.takeRequest()
            assertEquals("POST", register.method)
            assertEquals("/api/media-sync/devices", register.path)
            assertEquals("Bearer pat_new", register.getHeader("Authorization"))
            val body = Json.parseToJsonElement(register.body.readUtf8()).jsonObject
            assertEquals(setOf("installationId", "name"), body.keys)
            assertEquals(tokens.installationId, body.getValue("installationId").jsonPrimitive.content)

            assertEquals(UnpairResult.Done, m.unpair())
            val delete = server.takeRequest()
            assertEquals("DELETE", delete.method)
            assertEquals("/api/media-sync/devices/6f1c", delete.path)
            assertEquals("Bearer pat_new", delete.getHeader("Authorization"))
            assertFalse(tokens.isPaired)
        } finally {
            server.shutdown()
        }
    }

    @Test fun `the register response keeps the desired config for the config applier`() {
        val device = ApiClient.ApiJson.decodeFromString(
            MediaSyncDevice.serializer(),
            """{"id":"d","config":{"paused":true,"folders":[]},"configVersion":3}""",
        )
        assertEquals(3, device.configVersion)
        assertTrue(device.config is JsonObject)
    }
}
