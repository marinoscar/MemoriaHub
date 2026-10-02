package memoriahub.marin.cr.testing

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.security.MessageDigest

/**
 * A MockWebServer that behaves like the MemoriaHub API for the upload routes (§6.6), plus a
 * second server playing S3 for presigned part PUTs.
 *
 * - [mode] `S3`: part URLs are presigned on [storage] (`partUploadAuth: none`); `upload/status`
 *   reports no `uploadedParts` (S3 records parts only at `complete`, D16).
 * - [mode] `LOCAL`: part URLs are the API's own `PUT …/upload/parts/:n` (`bearer`), or — with
 *   [localPartsOnForeignHost] — the same route on [storage], to prove the PAT never leaves.
 *
 * Every request is appended to [events] (shared with [FakeUploadLedger]). [override] can answer
 * any request first (inject a 401, a 500…); returning null falls through to the normal behaviour.
 */
class FakeMediaServer(
    val events: MutableList<String> = java.util.Collections.synchronizedList(mutableListOf()),
) {
    enum class Mode { S3, LOCAL }

    data class StoredObject(
        val id: String,
        val size: Long,
        val partSize: Long,
        val totalParts: Int,
        val uploadId: String,
        var status: String = "pending",
        val parts: MutableMap<Int, ByteArray> = mutableMapOf(),
    )

    val api = MockWebServer()
    val storage = MockWebServer()

    var mode = Mode.S3
    var localPartsOnForeignHost = false
    var partSize = 10L
    var expectedDeviceId = "dev-1"
    var override: (RecordedRequest) -> MockResponse? = { null }

    /** Parts `complete` reports missing once (and forgets), then accepts. */
    var missingOnComplete = mutableListOf<Int>()
    /** `complete` answers 409 UPLOAD_SESSION_INVALID this many times. */
    var sessionInvalidOnComplete = 0
    /** Storage answers 403 (expired URL) this many times to a PUT of [expiredPart]. */
    var expiredPart = -1
    var expiredTimes = 0

    val objects = linkedMapOf<String, StoredObject>()
    /** contentHash → existing mediaItemId (the circle already has those bytes). */
    val existingHashes = mutableMapOf<String, String>()
    val registrations = mutableListOf<JsonObject>()
    val partAuthHeaders = mutableListOf<String?>()
    val partContentTypes = mutableListOf<String?>()
    val partPuts = mutableMapOf<Int, Int>()
    var inits = 0
    private var nextId = 1

    private val json = Json { ignoreUnknownKeys = true }

    fun start(): FakeMediaServer = apply {
        api.dispatcher = dispatcher(isStorage = false)
        storage.dispatcher = dispatcher(isStorage = true)
        api.start()
        storage.start()
    }

    fun shutdown() {
        api.shutdown()
        storage.shutdown()
    }

    val baseUrl: String get() = api.url("/").toString().trimEnd('/')

    /** Puts an object on the server as if a previous run had initialised it. */
    fun seedObject(id: String, size: Long, status: String = "uploading"): StoredObject {
        val totalParts = ((size + partSize - 1) / partSize).toInt()
        return StoredObject(id, size, partSize, totalParts, "upl-$id", status).also { objects[id] = it }
    }

    private fun dispatcher(isStorage: Boolean) = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse = synchronized(this@FakeMediaServer) {
            override(request)?.let { return@synchronized it }
            if (isStorage) storageRequest(request) else apiRequest(request)
        }
    }

    private fun ok(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setBody(body)
        .setHeader("Content-Type", "application/json")

    private fun data(body: String, code: Int = 200) = ok("""{"data":$body,"meta":{"timestamp":"x"}}""", code)

    fun error(status: Int, reason: String? = null, extra: String = ""): MockResponse {
        val details = if (reason == null && extra.isEmpty()) "" else
            ""","details":{${listOfNotNull(reason?.let { "\"reason\":\"$it\"" }, extra.takeIf { it.isNotEmpty() }).joinToString(",")}}"""
        return ok("""{"statusCode":$status,"code":"X","message":"HTTP $status"$details}""", status)
    }

    private fun apiRequest(r: RecordedRequest): MockResponse {
        val url = r.requestUrl!!
        val path = url.encodedPath
        val method = r.method!!
        val segments = url.pathSegments
        return when {
            method == "GET" && path == "/api/media" -> {
                events += "api.dedup"
                val hash = url.queryParameter("contentHash")
                val hit = existingHashes[hash]
                data("""{"items":[${hit?.let { """{"id":"$it","contentHash":"$hash"}""" } ?: ""}],"meta":{"pageSize":1,"hasMore":false}}""")
            }
            method == "POST" && path == "/api/storage/objects/upload/init" -> {
                inits++
                val body = json.parseToJsonElement(r.body.readUtf8()).jsonObject
                val size = body["size"]!!.jsonPrimitive.content.toLong()
                val id = "obj-${nextId++}"
                val obj = seedObject(id, size, status = "pending")
                events += "api.init:$id"
                val urls = (1..minOf(10, obj.totalParts)).joinToString(",") { """{"partNumber":$it,"url":"${partUrl(id, it)}"}""" }
                data(
                    """{"objectId":"$id","uploadId":"${obj.uploadId}","partSize":${obj.partSize},"totalParts":${obj.totalParts},""" +
                        """"presignedUrls":[$urls],"partUploadAuth":"${authValue()}"}""",
                    201,
                )
            }
            method == "POST" && segments.size == 6 && segments[5] == "part-urls" -> {
                val id = segments[3]
                val obj = objects[id] ?: return error(404)
                val numbers = json.parseToJsonElement(r.body.readUtf8()).jsonObject["partNumbers"]!!.jsonArray.map { it.jsonPrimitive.int }
                events += "api.partUrls:${numbers.joinToString(",")}"
                val urls = numbers.joinToString(",") { """{"partNumber":$it,"url":"${partUrl(obj.id, it)}"}""" }
                data("""{"presignedUrls":[$urls],"partUploadAuth":"${authValue()}"}""", 201)
            }
            method == "GET" && segments.size == 6 && segments[5] == "status" -> {
                val obj = objects[segments[3]] ?: return error(404).also { events += "api.status:404" }
                events += "api.status:${obj.status}"
                val reported = if (mode == Mode.LOCAL) obj.parts.keys.sorted() else emptyList()
                data(
                    """{"objectId":"${obj.id}","status":"${obj.status}","uploadedParts":$reported,"totalParts":${obj.totalParts},""" +
                        """"uploadedBytes":"0","totalBytes":"${obj.size}"}""",
                )
            }
            method == "PUT" && segments.size == 7 && segments[5] == "parts" -> partPut(r, segments[3], segments[6].toInt())
            method == "POST" && segments.size == 6 && segments[5] == "complete" -> complete(r, segments[3])
            method == "DELETE" && segments.size == 6 && segments[5] == "abort" -> {
                val removed = objects.remove(segments[3])
                events += "api.abort:${if (removed == null) 404 else 204}"
                if (removed == null) error(404) else MockResponse().setResponseCode(204)
            }
            method == "POST" && path == "/api/media" -> register(r)
            else -> error(404)
        }
    }

    private fun storageRequest(r: RecordedRequest): MockResponse {
        val segments = r.requestUrl!!.pathSegments
        // Presigned S3 shape: /bucket/<objectId>/<n>?X-Amz-Signature=…
        if (r.method == "PUT" && segments.size == 3 && segments[0] == "bucket") {
            return partPut(r, segments[1], segments[2].toInt())
        }
        // The local route served from a foreign host.
        if (r.method == "PUT" && segments.size == 7 && segments[5] == "parts") return partPut(r, segments[3], segments[6].toInt())
        return error(404)
    }

    private fun partPut(r: RecordedRequest, objectId: String, n: Int): MockResponse {
        partAuthHeaders += r.getHeader("Authorization")
        partContentTypes += r.getHeader("Content-Type")
        val obj = objects[objectId] ?: return MockResponse().setResponseCode(404).setBody("<Code>NoSuchUpload</Code>")
        if (n == expiredPart && expiredTimes > 0) {
            expiredTimes--
            events += "storage.put$n:403"
            return MockResponse().setResponseCode(403).setBody("<Code>AccessDenied</Code><Message>Request has expired</Message>")
        }
        val bytes = r.body.readByteArray()
        obj.parts[n] = bytes
        obj.status = "uploading"
        partPuts[n] = (partPuts[n] ?: 0) + 1
        events += "put$n"
        return MockResponse().setResponseCode(200).setHeader("ETag", etag(bytes))
    }

    private fun complete(r: RecordedRequest, objectId: String): MockResponse {
        val obj = objects[objectId] ?: return error(404)
        events += "api.complete"
        if (sessionInvalidOnComplete > 0) {
            sessionInvalidOnComplete--
            return error(409, "UPLOAD_SESSION_INVALID")
        }
        val listed = json.parseToJsonElement(r.body.readUtf8()).jsonObject["parts"]!!.jsonArray.associate {
            it.jsonObject["partNumber"]!!.jsonPrimitive.int to it.jsonObject["eTag"]!!.jsonPrimitive.content
        }
        if (missingOnComplete.isNotEmpty()) {
            val missing = missingOnComplete.toList()
            missingOnComplete.clear()
            missing.forEach { obj.parts.remove(it) }
            return error(409, "UPLOAD_PARTS_MISSING", "\"partNumbers\":$missing")
        }
        val bad = (1..obj.totalParts).filter { n -> obj.parts[n]?.let { etag(it) } != listed[n] }
        if (bad.isNotEmpty()) return error(409, "UPLOAD_PARTS_MISSING", "\"partNumbers\":$bad")
        obj.status = "processing"
        return data("""{"id":"${obj.id}","status":"processing"}""")
    }

    private fun register(r: RecordedRequest): MockResponse {
        val body = json.parseToJsonElement(r.body.readUtf8()).jsonObject
        registrations += body
        events += "api.register"
        if (body["sourceDeviceId"]?.jsonPrimitive?.content != expectedDeviceId) return error(400, "UNKNOWN_SOURCE_DEVICE")
        val hash = body["contentHash"]?.jsonPrimitive?.content
        existingHashes[hash]?.let { return data("""{"id":"$it","mediaItemId":"$it","deduplicated":true}""", 200) }
        val id = "media-${registrations.size}"
        hash?.let { existingHashes[it] = id }
        return data("""{"id":"$id","mediaItemId":"$id","deduplicated":false}""", 201)
    }

    /** All bytes received for [objectId], parts concatenated in order. */
    fun assembled(objectId: String): ByteArray {
        val obj = objects.getValue(objectId)
        return (1..obj.totalParts).map { obj.parts.getValue(it) }.fold(ByteArray(0)) { a, b -> a + b }
    }

    private fun authValue() = if (mode == Mode.LOCAL) "bearer" else "none"

    private fun partUrl(objectId: String, n: Int): String = when {
        mode == Mode.S3 -> storage.url("/bucket/$objectId/$n").newBuilder().addQueryParameter("X-Amz-Signature", "s3cr3t").build().toString()
        localPartsOnForeignHost -> storage.url("/api/storage/objects/$objectId/upload/parts/$n").toString()
        else -> api.url("/api/storage/objects/$objectId/upload/parts/$n").toString()
    }

    companion object {
        fun etag(bytes: ByteArray): String {
            val md5 = MessageDigest.getInstance("MD5").digest(bytes)
            return "\"" + md5.joinToString("") { "%02x".format(it) } + "\""
        }
    }
}
