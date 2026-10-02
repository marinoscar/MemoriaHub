package memoriahub.marin.cr.pairing

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import memoriahub.marin.cr.net.ApiClient
import memoriahub.marin.cr.net.RegisterDeviceRequest
import memoriahub.marin.cr.util.AppInfo
import memoriahub.marin.cr.util.Brand
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceInfoTest {
    private val sha = (1..32).joinToString(":") { "%02X".format(it) }
    private val app = AppInfo("memoriahub.marin.cr", "2.0.0", 100, sha)

    @Test fun `device names do not repeat the manufacturer`() {
        assertEquals("Google Pixel 8 · Media sync", DeviceInfo.deviceName("Google", "Pixel 8"))
        assertEquals("Samsung SM-S918B · Media sync", DeviceInfo.deviceName("samsung", "SM-S918B"))
        assertEquals("motorola edge · Media sync", DeviceInfo.deviceName("motorola", "motorola edge"))
        assertEquals("Android phone · Media sync", DeviceInfo.deviceName(null, null))
        assertTrue(DeviceInfo.deviceName("X".repeat(80), "Y".repeat(80)).length <= 100)
    }

    @Test fun `the token is named after the product and model`() {
        assertEquals("${Brand.name} Android · Pixel 8", DeviceInfo.tokenName("Pixel 8"))
        assertEquals("${Brand.name} Android · phone", DeviceInfo.tokenName(null))
    }

    @Test fun `clientInfo serializes the allowlisted keys the server expects`() {
        val info = DeviceInfo.clientInfo("Google", "Pixel 8", "2.0.0")
        val json = Json.parseToJsonElement(
            ApiClient.ApiJson.encodeToString(DeviceCodeRequest.serializer(), DeviceCodeRequest(info)),
        ).jsonObject.getValue("clientInfo").jsonObject
        assertEquals(setOf("deviceName", "userAgent", "tokenType", "name", "platform", "returnUri"), json.keys)
        assertEquals("pat", json.getValue("tokenType").jsonPrimitive.content)
        assertEquals("memoriahub://media-sync/paired", json.getValue("returnUri").jsonPrimitive.content)
        assertEquals("${Brand.compactName}-Android/2.0.0", json.getValue("userAgent").jsonPrimitive.content)
        assertEquals("Google Pixel 8 · Media sync", json.getValue("deviceName").jsonPrimitive.content)
    }

    @Test fun `registration carries the phone, app and zone`() {
        val body = DeviceInfo.registration("11111111-2222-3333-4444-555555555555", "Google", "Pixel 8", "15", 35, app, "America/Costa_Rica")
        assertEquals(
            RegisterDeviceRequest(
                installationId = "11111111-2222-3333-4444-555555555555",
                name = "Google Pixel 8 · Media sync",
                manufacturer = "Google",
                model = "Pixel 8",
                androidVersion = "15",
                sdkInt = 35,
                appVersion = "2.0.0",
                appVersionCode = 100,
                packageName = "memoriahub.marin.cr",
                signingSha256 = sha,
                timezone = "America/Costa_Rica",
            ),
            body,
        )
    }

    @Test fun `values the server would reject are omitted, not sent`() {
        val bad = AppInfo("not a package", "x".repeat(80), 0, "zz:11")
        val body = DeviceInfo.registration("i", "  ", null, null, -1, bad, "GMT+05:30")
        assertNull(body.manufacturer)
        assertNull(body.sdkInt)
        assertEquals(50, body.appVersion!!.length)
        assertNull(body.appVersionCode)
        assertNull(body.packageName)
        assertNull(body.signingSha256)
        assertNull(body.timezone)
        assertEquals("UTC", DeviceInfo.registration("i", null, null, null, null, app, "UTC").timezone)
        assertEquals(
            "debug package names are accepted",
            "memoriahub.marin.cr.debug",
            DeviceInfo.registration("i", null, null, null, null, app.copy(packageName = "memoriahub.marin.cr.debug"), null).packageName,
        )
    }
}
