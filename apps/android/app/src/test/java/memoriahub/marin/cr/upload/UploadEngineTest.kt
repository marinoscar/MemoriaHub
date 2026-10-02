package memoriahub.marin.cr.upload

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive
import memoriahub.marin.cr.auth.SharedPrefsTokenStore
import memoriahub.marin.cr.ledger.CompletedPart
import memoriahub.marin.cr.ledger.SyncFileState
import memoriahub.marin.cr.net.ApiClient
import memoriahub.marin.cr.net.ApiMediaUploadApi
import memoriahub.marin.cr.pairing.ApiErrorReactions
import memoriahub.marin.cr.pairing.SharedPrefsPairingStateStore
import memoriahub.marin.cr.testing.FakeContentSource
import memoriahub.marin.cr.testing.FakeMediaServer
import memoriahub.marin.cr.testing.FakeNotifier
import memoriahub.marin.cr.testing.FakeScheduler
import memoriahub.marin.cr.testing.FakeSharedPreferences
import memoriahub.marin.cr.testing.FakeUploadLedger
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.util.Collections
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class UploadEngineTest {
    private val events: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private val server = FakeMediaServer(events)
    private val ledger = FakeUploadLedger(events)
    private val source = FakeContentSource()
    private val tokens = SharedPrefsTokenStore(FakeSharedPreferences())
    private val pairing = SharedPrefsPairingStateStore(FakeSharedPreferences())
    private val scheduler = FakeScheduler()
    private val notifier = FakeNotifier()
    private val reactions = ApiErrorReactions(tokens, pairing, { scheduler }, notifier)
    private val logs: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private val now = 1_800_000_000_000L
    private val target = UploadTarget(circleId = "11111111-1111-1111-1111-111111111111", sourceDeviceId = "dev-1", sourceDeviceName = "Pixel 9")
    private val http = OkHttpClient.Builder().readTimeout(5, TimeUnit.SECONDS).build()
    private var baseUrl: String? = null

    @Before fun setUp() {
        server.start()
        baseUrl = server.baseUrl
        tokens.setToken("pat_secret", Instant.parse("2027-01-01T00:00:00Z"))
        tokens.setDeviceId("dev-1")
        pairing.pairedAt = Instant.parse("2026-10-01T00:00:00Z")
    }

    @After fun tearDown() {
        server.shutdown()
    }

    private fun engine(
        network: NetworkPolicy = NetworkPolicy.ALWAYS,
        parallelism: Int = 1,
    ): UploadEngine {
        val api = ApiClient(baseUrlProvider = { baseUrl }, tokenProvider = { tokens.token }, http = http, logger = { logs += it })
        return UploadEngine(
            ledger = ledger,
            api = ApiMediaUploadApi(api),
            partUploader = PartUploader(serverBaseUrl = { baseUrl }, tokenProvider = { tokens.token }, http = http),
            source = source,
            networkPolicy = network,
            errorReactions = reactions,
            clock = { now },
            retryDelay = {},
            parallelism = parallelism,
            logger = { logs += it },
        )
    }

    private fun queue(id: Long, size: Int = 25, seed: Int = id.toInt()): ByteArray {
        val bytes = FakeContentSource.bytes(size, seed)
        val file = FakeUploadLedger.file(id, size)
        ledger.add(file)
        source.put(file.uri, bytes)
        return bytes
    }

    private fun sha(bytes: ByteArray) = ContentHasher.sha256(bytes.inputStream())

    // ---------------------------------------------------------------------------------------

    @Test fun `S3 happy path uploads three parts with the right ranges and persists every ETag at once`() = runBlocking {
        val bytes = queue(1)
        val result = engine().run(target)

        assertEquals(1, result.uploaded)
        assertEquals(25L, result.bytesUploaded)
        assertNull(result.stopReason)
        assertEquals(SyncFileState.UPLOADED, ledger.state(1))
        val objectId = server.objects.keys.single()
        assertArrayEquals("the parts reassemble the exact file", bytes, server.assembled(objectId))
        assertEquals(listOf(10, 10, 5), (1..3).map { server.objects.getValue(objectId).parts.getValue(it).size })
        // Each part is persisted before the next one is sent, and before complete.
        val order = events.filter { it.startsWith("put") || it.startsWith("ledger.part") || it == "api.complete" }
        assertEquals(listOf("put1", "ledger.part1:1", "put2", "ledger.part2:1", "put3", "ledger.part3:1", "api.complete"), order)
        // The session was persisted before any byte was sent (T6).
        assertTrue(events.indexOf("ledger.start:1") < events.indexOf("put1"))
        // Presigned storage URLs never carry the PAT.
        assertEquals(listOf<String?>(null, null, null), server.partAuthHeaders)
        val reg = server.registrations.single()
        assertEquals("android", reg["source"]!!.jsonPrimitive.content)
        assertEquals("dev-1", reg["sourceDeviceId"]!!.jsonPrimitive.content)
        assertEquals("Pixel 9", reg["sourceDeviceName"]!!.jsonPrimitive.content)
        assertEquals("DCIM/Camera/IMG_1.jpg", reg["sourcePath"]!!.jsonPrimitive.content)
        assertEquals(sha(bytes), reg["contentHash"]!!.jsonPrimitive.content)
        assertEquals("photo", reg["type"]!!.jsonPrimitive.content)
        assertEquals(target.circleId, reg["circleId"]!!.jsonPrimitive.content)
        assertEquals(Instant.ofEpochMilli(1_780_000_000_000L).toString(), reg["capturedAt"]!!.jsonPrimitive.content)
        assertEquals("media-1", ledger.row(1).mediaItemId)
        assertEquals(sha(bytes), ledger.row(1).file.contentHash)
        // Logs never carry URLs, query strings or tokens.
        assertFalse(logs.any { "s3cr3t" in it || "pat_secret" in it || "http" in it })
    }

    @Test fun `local provider parts carry the bearer token to the own server as octet-stream`() = runBlocking {
        server.mode = FakeMediaServer.Mode.LOCAL
        queue(1)
        val result = engine().run(target)
        assertEquals(1, result.uploaded)
        assertEquals(listOf("Bearer pat_secret", "Bearer pat_secret", "Bearer pat_secret"), server.partAuthHeaders)
        assertTrue(server.partContentTypes.all { it == "application/octet-stream" })
    }

    @Test fun `a bearer part URL on a foreign host never receives the token`() = runBlocking {
        server.mode = FakeMediaServer.Mode.LOCAL
        server.localPartsOnForeignHost = true
        queue(1)
        engine().run(target)
        assertEquals(3, server.partAuthHeaders.size)
        assertTrue("no Authorization on a foreign origin", server.partAuthHeaders.all { it == null })
    }

    @Test fun `a dedup pre-check hit skips the upload entirely`() = runBlocking {
        val bytes = queue(1)
        server.existingHashes[sha(bytes)] = "existing-9"
        val result = engine().run(target)
        assertEquals(1, result.deduplicated)
        assertEquals(0, result.uploaded)
        assertEquals(SyncFileState.DEDUPLICATED, ledger.state(1))
        assertEquals("existing-9", ledger.row(1).mediaItemId)
        assertEquals(0, server.inits)
        assertTrue(server.partPuts.isEmpty())
    }

    @Test fun `201 marks uploaded and 200 deduplicated marks deduplicated`() = runBlocking {
        queue(1)
        val bytes2 = queue(2)
        // Another device registers the same bytes between pre-check and registration.
        server.override = { r ->
            if (r.method == "POST" && r.path == "/api/media" && "\"storageObjectId\":\"obj-2\"" in r.body.peek().readUtf8()) {
                server.existingHashes[sha(bytes2)] = "raced-1"
            }
            null
        }
        val result = engine().run(target)
        assertEquals(1, result.uploaded)
        assertEquals(1, result.deduplicated)
        assertEquals(SyncFileState.UPLOADED, ledger.state(1))
        assertEquals(SyncFileState.DEDUPLICATED, ledger.state(2))
        assertEquals("raced-1", ledger.row(2).mediaItemId)
        assertEquals(25L, result.bytesUploaded)
    }

    @Test fun `resume after process death continues from part 2 with the local part list`() = runBlocking {
        val bytes = queue(1)
        val killed = CompletableDeferred<Unit>()
        val first = async {
            ledger.onRecordPart = { _, part ->
                if (part.partNumber == 1) {
                    // The process dies right after part 1 is persisted: nothing else runs.
                    killed.complete(Unit)
                    awaitCancellation()
                }
            }
            engine().run(target)
        }
        killed.await()
        first.cancel()
        runCatching { first.await() }
        // The "dead" run left the row UPLOADING with part 1 persisted.
        ledger.onRecordPart = { _, _ -> }
        assertEquals(SyncFileState.UPLOADING, ledger.state(1))
        assertEquals(listOf(1), ledger.row(1).file.completedParts.map { it.partNumber })

        val result = engine().run(target) // a brand-new engine, as after a restart
        assertEquals(1, result.uploaded)
        assertEquals("part 1 is never re-sent", 1, server.partPuts[1])
        assertEquals(1, server.partPuts[2])
        assertEquals(1, server.partPuts[3])
        assertEquals(1, server.inits)
        assertTrue("resume confirms the session first", "api.status:uploading" in events)
        assertArrayEquals(bytes, server.assembled(server.objects.keys.single()))
    }

    @Test fun `a stale session (status 404) is aborted and re-initialised`() = runBlocking {
        val bytes = FakeContentSource.bytes(25)
        val file = FakeUploadLedger.file(
            1, 25, state = SyncFileState.UPLOADING, contentHash = sha(bytes), objectId = "gone", uploadId = "u",
            partSize = 10, totalParts = 3, parts = listOf(CompletedPart(1, "\"old\"")),
        )
        ledger.add(file)
        source.put(file.uri, bytes)
        val result = engine().run(target)
        assertEquals(1, result.uploaded)
        assertTrue("api.status:404" in events)
        assertTrue("ledger.reset:1" in events)
        assertEquals(1, server.inits)
        assertEquals("all three parts re-sent into the new session", 3, server.partPuts.values.sum())
    }

    @Test fun `a completed upload that died before registering goes straight to registration`() = runBlocking {
        val bytes = FakeContentSource.bytes(25)
        val obj = server.seedObject("done-1", 25, status = "processing")
        val file = FakeUploadLedger.file(
            1, 25, state = SyncFileState.UPLOADING, contentHash = sha(bytes), objectId = obj.id, uploadId = obj.uploadId,
            partSize = 10, totalParts = 3, parts = (1..3).map { CompletedPart(it, "\"e$it\"") },
        )
        ledger.add(file)
        source.put(file.uri, bytes)
        val result = engine().run(target)
        assertEquals(1, result.uploaded)
        assertTrue(server.partPuts.isEmpty())
        assertFalse("api.abort:204" in events)
        assertEquals("done-1", server.registrations.single()["storageObjectId"]!!.jsonPrimitive.content)
    }

    @Test fun `UPLOAD_PARTS_MISSING re-sends only the listed parts`() = runBlocking {
        server.mode = FakeMediaServer.Mode.LOCAL
        server.missingOnComplete = mutableListOf(2)
        queue(1)
        val result = engine().run(target)
        assertEquals(1, result.uploaded)
        assertEquals(mapOf(1 to 1, 2 to 2, 3 to 1), server.partPuts.toMap())
        assertEquals(2, events.count { it == "api.complete" })
        assertTrue("ledger.replaceParts:1" in events)
    }

    @Test fun `UPLOAD_SESSION_INVALID on complete aborts and re-initialises`() = runBlocking {
        server.sessionInvalidOnComplete = 1
        queue(1)
        val result = engine().run(target)
        assertEquals(1, result.uploaded)
        assertEquals(2, server.inits)
        assertTrue("api.abort:204" in events)
        assertEquals(SyncFileState.UPLOADED, ledger.state(1))
    }

    @Test fun `an expired presigned URL is re-fetched once`() = runBlocking {
        server.expiredPart = 2
        server.expiredTimes = 1
        queue(1)
        val result = engine().run(target)
        assertEquals(1, result.uploaded)
        assertTrue("api.partUrls:2" in events)
        assertEquals(0, ledger.row(1).file.attempts)
    }

    @Test fun `going metered under Wi-Fi only stops between parts, keeps state and counts no attempt`() = runBlocking {
        queue(1)
        queue(2)
        val metered = AtomicBoolean(false)
        ledger.onRecordPart = { _, part -> if (part.partNumber == 1) metered.set(true) }
        val result = engine(network = { !metered.get() }).run(target)

        assertEquals(UploadStopReason.NETWORK_POLICY, result.stopReason)
        assertTrue(result.pausedByNetwork)
        assertEquals("NETWORK_POLICY", result.errorCode)
        assertEquals(0, result.failed)
        assertEquals(SyncFileState.UPLOADING, ledger.state(1))
        assertEquals(listOf(1), ledger.row(1).file.completedParts.map { it.partNumber })
        assertEquals(0, ledger.row(1).file.attempts)
        assertEquals("the second file is never touched", SyncFileState.QUEUED, ledger.state(2))
        assertFalse(events.any { it.startsWith("ledger.failed") })
        assertEquals(1, server.partPuts.values.sum())
    }

    @Test fun `the stop signal ends the run cleanly`() = runBlocking {
        queue(1)
        val stop = AtomicBoolean(false)
        ledger.onRecordPart = { _, _ -> stop.set(true) }
        val result = engine().run(target, shouldStop = { stop.get() })
        assertEquals(UploadStopReason.STOPPED, result.stopReason)
        assertNull(result.errorCode)
        assertEquals(SyncFileState.UPLOADING, ledger.state(1))
        assertEquals(0, ledger.row(1).file.attempts)
    }

    @Test fun `a 5xx fails the file with backoff and a 400 blocks it`() = runBlocking {
        queue(1)
        queue(2)
        server.override = { r ->
            if (r.path == "/api/storage/objects/upload/init") {
                val size = r.body.peek().readUtf8()
                if ("\"name\":\"IMG_1.jpg\"" in size) server.error(503) else server.error(400)
            } else {
                null
            }
        }
        val result = engine().run(target)
        assertEquals(2, result.failed)
        assertEquals(1, result.blocked)
        assertEquals(SyncFileState.FAILED, ledger.state(1))
        assertEquals(now + 30_000, ledger.row(1).nextAttemptAt)
        assertEquals("HTTP_503", ledger.row(1).lastErrorCode)
        assertEquals(SyncFileState.BLOCKED, ledger.state(2))
        assertEquals(2, result.failedSample.size)
        assertEquals("IMG_1.jpg", result.failedSample[0].name)
        assertEquals("DCIM/Camera/", result.failedSample[0].relativePath)
        assertEquals(25L, result.failedSample[0].sizeBytes)
        assertEquals(1, result.failedSample[0].attempts)
    }

    @Test fun `the fifth failure blocks the file`() = runBlocking {
        val bytes = FakeContentSource.bytes(25)
        val file = FakeUploadLedger.file(1, 25, state = SyncFileState.FAILED, attempts = 4)
        ledger.add(file)
        source.put(file.uri, bytes)
        server.override = { r -> if (r.path == "/api/storage/objects/upload/init") server.error(500) else null }
        val result = engine().run(target)
        assertEquals(1, result.blocked)
        assertEquals(SyncFileState.BLOCKED, ledger.state(1))
        assertEquals(5, ledger.row(1).file.attempts)
    }

    @Test fun `401 stops the run, flags the pairing expired and counts no attempt`() = runBlocking {
        queue(1)
        queue(2)
        server.override = { r -> if (r.path!!.startsWith("/api/media?")) server.error(401) else null }
        val result = engine().run(target)
        assertEquals(UploadStopReason.PAIRING_EXPIRED, result.stopReason)
        assertEquals("PAIRING_EXPIRED", result.errorCode)
        assertTrue(pairing.pairingExpired)
        assertEquals(1, notifier.expiredPosted)
        assertEquals(0, ledger.row(1).file.attempts)
        assertFalse(events.any { it.startsWith("ledger.failed") })
        assertEquals(SyncFileState.QUEUED, ledger.state(2))
    }

    @Test fun `409 DEVICE_REVOKED stops the run and forgets the pairing`() = runBlocking {
        queue(1)
        server.override = { r -> if (r.path == "/api/media" && r.method == "POST") server.error(409, "DEVICE_REVOKED") else null }
        val result = engine().run(target)
        assertEquals(UploadStopReason.DEVICE_REVOKED, result.stopReason)
        assertNull(tokens.token)
        assertEquals(1, scheduler.cancelled)
        assertEquals(SyncFileState.REGISTERING, ledger.state(1))
        assertEquals(0, ledger.row(1).file.attempts)
    }

    @Test fun `403 on the target circle stops the run with TARGET_CIRCLE_FORBIDDEN`() = runBlocking {
        queue(1)
        server.override = { r -> if (r.path == "/api/media" && r.method == "POST") server.error(403, "TARGET_CIRCLE_FORBIDDEN") else null }
        val result = engine().run(target)
        assertEquals("TARGET_CIRCLE_FORBIDDEN", result.errorCode)
        assertEquals(0, ledger.row(1).file.attempts)
    }

    @Test fun `400 UNKNOWN_SOURCE_DEVICE stops the run`() = runBlocking {
        queue(1)
        server.expectedDeviceId = "someone-else"
        val result = engine().run(target)
        assertEquals(UploadStopReason.UNKNOWN_SOURCE_DEVICE, result.stopReason)
        assertEquals(0, ledger.row(1).file.attempts)
    }

    @Test fun `a vanished file is reported and marked non-retryable`() = runBlocking {
        queue(1)
        source.missing += FakeUploadLedger.file(1, 25).uri
        val result = engine().run(target)
        assertEquals(listOf(1L), result.vanishedIds)
        assertEquals(0, result.failed)
        assertEquals(SyncFileState.BLOCKED, ledger.state(1))
        assertEquals(UploadEngine.CODE_FILE_NOT_FOUND, ledger.row(1).lastErrorCode)
    }

    @Test fun `a revoked media permission stops the run without touching attempts`() = runBlocking {
        queue(1)
        source.denied += FakeUploadLedger.file(1, 25).uri
        val result = engine().run(target)
        assertEquals("MEDIA_PERMISSION_MISSING", result.errorCode)
        assertEquals(0, ledger.row(1).file.attempts)
    }

    @Test fun `an unreachable server stops after two network failures instead of burning every file`() = runBlocking {
        queue(1)
        queue(2)
        queue(3)
        baseUrl = "http://127.0.0.1:1"
        val result = engine().run(target)
        assertEquals(UploadStopReason.SERVER_UNREACHABLE, result.stopReason)
        assertEquals(2, result.failed)
        assertEquals(SyncFileState.FAILED, ledger.state(1))
        assertEquals(SyncFileState.FAILED, ledger.state(2))
        assertEquals(SyncFileState.QUEUED, ledger.state(3))
    }

    @Test fun `two files upload in parallel`() = runBlocking {
        val a = queue(1, size = 45)
        val b = queue(2, size = 33)
        val result = engine(parallelism = 2).run(target)
        assertEquals(2, result.uploaded)
        assertEquals(78L, result.bytesUploaded)
        val byHash = server.objects.values.associate { sha(server.assembled(it.id)) to it.id }
        assertTrue(sha(a) in byHash)
        assertTrue(sha(b) in byHash)
        assertEquals(2, result.filesProcessed)
    }

    @Test fun `more than ten parts fetch further URLs in batches`() = runBlocking {
        val bytes = queue(1, size = 235) // 24 parts of 10 bytes
        val result = engine().run(target)
        assertEquals(1, result.uploaded)
        assertTrue("api.partUrls:11,12,13,14,15,16,17,18,19,20" in events)
        assertTrue("api.partUrls:21,22,23,24" in events)
        assertArrayEquals(bytes, server.assembled(server.objects.keys.single()))
    }

    @Test fun `a transient storage error is retried in place`() = runBlocking {
        queue(1)
        var failed = false
        server.override = { r ->
            if (!failed && r.method == "PUT" && r.path!!.startsWith("/bucket/") && r.path!!.contains("/2?")) {
                failed = true
                MockResponse().setResponseCode(503).setHeader("Retry-After", "1")
            } else {
                null
            }
        }
        val result = engine().run(target)
        assertEquals(1, result.uploaded)
        assertEquals(0, ledger.row(1).file.attempts)
    }

    @Test fun `progress reports the file being sent`() = runBlocking {
        queue(1)
        val engine = engine()
        engine.run(target)
        val p = engine.progress.value!!
        assertEquals("IMG_1.jpg", p.fileName)
        assertEquals(25L, p.bytesTotal)
        assertEquals(1, p.filesDone)
        assertEquals(1, p.filesTotal)
    }
}
