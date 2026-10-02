package memoriahub.marin.cr.diagnostics

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.pairing.PairingStatus
import memoriahub.marin.cr.testing.appInfo
import memoriahub.marin.cr.testing.config
import memoriahub.marin.cr.testing.run
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class DiagnosticReportTest {
    private val now = Instant.parse("2026-10-01T12:00:00Z")
    private val token = "pat_SECRETsecretSECRET123"

    private fun result(checks: List<CheckResult> = listOf(Checks.appVersion(appInfo()), Checks.batteryOptimization(false))) = SelfTestResult(
        generatedAt = now,
        checks = checks,
        app = appInfo(),
        device = DeviceSnapshot("Google", "Pixel", "14", 34, "UTC"),
        serverUrl = "https://photos.example",
        pairing = PairingStatus(hasToken = true, deviceId = "dev-1"),
        config = config(),
        syncStatus = null,
        permission = null,
        stats = SyncStats(eligible = 3, uploaded = 2, pending = 1),
        folders = emptyList(),
    )

    @Test fun `report has the spec sections and no token`() {
        val log = listOf(
            "2026 I/Upload: PUT https://s3.example/bucket/key?X-Amz-Signature=abc&X-Amz-Credential=def failed",
            "2026 I/Api: Authorization: Bearer $token",
            "2026 I/Api: raw $token",
        )
        val built = DiagnosticReportBuilder.build(result(), listOf(run("failed", now.toEpochMilli(), "PAIRING_EXPIRED")), log, secret = token)
        // Still valid JSON after redaction (the URL mask must not swallow a quote).
        val parsed = Json.parseToJsonElement(built.text).jsonObject
        for (key in listOf("app", "device", "config", "stats", "checks", "inventory", "recentRuns", "log", "summary")) {
            assertTrue("missing $key", key in parsed)
        }
        assertFalse(built.text.contains("SECRETsecret"))
        assertFalse(built.text.contains("X-Amz-Signature"))
        assertFalse(built.text.contains("X-Amz-Credential"))
        assertTrue(built.text.contains("https://s3.example/bucket/key?[REDACTED]"))
        assertEquals("0 fail, 1 warn: Battery optimization", built.summary)
        assertEquals("PAIRING_EXPIRED", parsed["recentRuns"]!!.jsonArray[0].jsonObject["errorCode"]!!.jsonPrimitive.content)
        assertEquals(built.json, parsed)
        // Checks never carry the phone-only action.
        assertFalse(built.text.contains("BATTERY_SETTINGS"))
    }

    @Test fun `report stays under the size cap by shrinking the log first`() {
        val huge = List(5_000) { "2026 I/Upload: upload.part file=$it part=3 status=200 ${"x".repeat(100)}" }
        val built = DiagnosticReportBuilder.build(result(), List(10) { run("ok", now.toEpochMilli() - it) }, huge)
        assertTrue("${built.sizeBytes} bytes", built.sizeBytes <= DiagnosticReportBuilder.MAX_BYTES)
        assertTrue(built.report.log.isNotEmpty())
        assertEquals(10, built.report.recentRuns.size)
        assertTrue(built.report.log.size <= DiagnosticsLimits.REPORT_LOG_LINES)
    }

    @Test fun `tiny cap drops runs and check data too, but keeps the checks`() {
        val built = DiagnosticReportBuilder.build(result(), List(10) { run("ok", it.toLong()) }, List(50) { "line $it" }, maxBytes = 2_000)
        assertTrue(built.report.log.isEmpty())
        assertTrue(built.report.recentRuns.isEmpty())
        assertEquals(2, built.report.checks.size)
    }
}
