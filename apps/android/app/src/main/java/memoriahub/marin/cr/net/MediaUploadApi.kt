package memoriahub.marin.cr.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * The API routes the upload engine (#511) calls, all with the paired PAT
 * (docs/specs/android-media-sync.md §6.6). Kept behind an interface so the engine can be driven
 * by a fake; production and the MockWebServer tests use [ApiMediaUploadApi].
 *
 * Every method returns an [ApiResult]; callers route a failure through
 * `ApiErrorReactions` before deciding what to do with the file.
 */
interface MediaUploadApi {
    /** `GET /api/media?circleId&contentHash&pageSize=1` (keyset mode: `page` omitted, D15). */
    suspend fun findByContentHash(circleId: String, contentHash: String): ApiResult<MediaListPage>

    /** `POST /api/storage/objects/upload/init`. */
    suspend fun initUpload(request: InitUploadRequest): ApiResult<InitUploadResponse>

    /** `POST /api/storage/objects/:id/upload/part-urls` (1..100 part numbers). */
    suspend fun partUrls(objectId: String, partNumbers: List<Int>): ApiResult<PartUrlsResponse>

    /** `GET /api/storage/objects/:id/upload/status`. */
    suspend fun uploadStatus(objectId: String): ApiResult<UploadStatusResponse>

    /** `POST /api/storage/objects/:id/upload/complete`. */
    suspend fun completeUpload(objectId: String, parts: List<CompleteUploadPart>): ApiResult<JsonElement>

    /** `DELETE /api/storage/objects/:id/upload/abort` (204; 404 = already gone). Deletes the object row. */
    suspend fun abortUpload(objectId: String): ApiResult<JsonElement>

    /** `POST /api/media`: 201 created, or 200 with `deduplicated: true`. */
    suspend fun createMedia(request: CreateMediaRequest): ApiResult<CreateMediaResponse>
}

@Serializable
data class MediaListItem(val id: String, val contentHash: String? = null)

/** `GET /api/media` page (`{ items, meta }` once the `{ data }` envelope is unwrapped). */
@Serializable
data class MediaListPage(val items: List<MediaListItem> = emptyList())

@Serializable
data class InitUploadRequest(val name: String, val size: Long, val mimeType: String)

@Serializable
data class PartUrl(val partNumber: Int, val url: String)

@Serializable
data class InitUploadResponse(
    val objectId: String,
    val uploadId: String? = null,
    val partSize: Long,
    val totalParts: Int,
    val presignedUrls: List<PartUrl> = emptyList(),
    /** `none` (presigned storage URL, never send credentials) or `bearer` (the API's own part route, #506). Absent = `none`. */
    val partUploadAuth: String? = null,
)

@Serializable
data class PartUrlsRequest(val partNumbers: List<Int>)

@Serializable
data class PartUrlsResponse(
    val presignedUrls: List<PartUrl> = emptyList(),
    val partUploadAuth: String? = null,
)

/** `status` is the `StorageObjectStatus`: `pending`, `uploading`, `processing`, `ready` or `failed`. */
@Serializable
data class UploadStatusResponse(
    val objectId: String? = null,
    val status: String,
    val uploadedParts: List<Int> = emptyList(),
    val totalParts: Int? = null,
    val uploadedBytes: String? = null,
    val totalBytes: String? = null,
)

@Serializable
data class CompleteUploadPart(val partNumber: Int, val eTag: String)

@Serializable
data class CompleteUploadRequest(val parts: List<CompleteUploadPart>)

/**
 * `POST /api/media` body (`createMediaSchema`). `capturedAtOffset` and EXIF are left to the
 * server's metadata pipeline. Null fields are omitted on the wire.
 */
@Serializable
data class CreateMediaRequest(
    val storageObjectId: String,
    val circleId: String,
    val type: String,
    val source: String = SOURCE_ANDROID,
    val originalFilename: String,
    val contentHash: String? = null,
    val capturedAt: String? = null,
    val sourceDeviceId: String? = null,
    val sourceDeviceName: String? = null,
    val sourcePath: String? = null,
) {
    companion object {
        const val SOURCE_ANDROID = "android"
    }
}

@Serializable
data class CreateMediaResponse(
    val mediaItemId: String? = null,
    val id: String? = null,
    val deduplicated: Boolean = false,
)

/** `details.reason` values the upload path branches on (§17.1, §17.3). */
object UploadReasons {
    const val UPLOAD_PARTS_MISSING = "UPLOAD_PARTS_MISSING"
    const val UPLOAD_SESSION_INVALID = "UPLOAD_SESSION_INVALID"
    const val UPLOAD_NOT_ACTIVE = "UPLOAD_NOT_ACTIVE"
    const val UNKNOWN_SOURCE_DEVICE = "UNKNOWN_SOURCE_DEVICE"
    const val TARGET_CIRCLE_FORBIDDEN = "TARGET_CIRCLE_FORBIDDEN"
}

class ApiMediaUploadApi(private val api: ApiClient) : MediaUploadApi {
    override suspend fun findByContentHash(circleId: String, contentHash: String): ApiResult<MediaListPage> =
        api.get("/api/media?circleId=${enc(circleId)}&contentHash=${enc(contentHash)}&pageSize=1", MediaListPage.serializer())

    override suspend fun initUpload(request: InitUploadRequest): ApiResult<InitUploadResponse> =
        api.post("$OBJECTS/upload/init", request, InitUploadRequest.serializer(), InitUploadResponse.serializer())

    override suspend fun partUrls(objectId: String, partNumbers: List<Int>): ApiResult<PartUrlsResponse> =
        api.post(
            "$OBJECTS/${enc(objectId)}/upload/part-urls",
            PartUrlsRequest(partNumbers),
            PartUrlsRequest.serializer(),
            PartUrlsResponse.serializer(),
        )

    override suspend fun uploadStatus(objectId: String): ApiResult<UploadStatusResponse> =
        api.get("$OBJECTS/${enc(objectId)}/upload/status", UploadStatusResponse.serializer())

    override suspend fun completeUpload(objectId: String, parts: List<CompleteUploadPart>): ApiResult<JsonElement> =
        api.post(
            "$OBJECTS/${enc(objectId)}/upload/complete",
            CompleteUploadRequest(parts),
            CompleteUploadRequest.serializer(),
            JsonElement.serializer(),
        )

    override suspend fun abortUpload(objectId: String): ApiResult<JsonElement> =
        api.delete("$OBJECTS/${enc(objectId)}/upload/abort")

    override suspend fun createMedia(request: CreateMediaRequest): ApiResult<CreateMediaResponse> =
        api.post("/api/media", request, CreateMediaRequest.serializer(), CreateMediaResponse.serializer())

    private companion object {
        const val OBJECTS = "/api/storage/objects"

        fun enc(value: String): String = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    }
}
