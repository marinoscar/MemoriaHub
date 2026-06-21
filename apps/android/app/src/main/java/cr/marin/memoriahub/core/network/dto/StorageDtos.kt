package cr.marin.memoriahub.core.network.dto

import kotlinx.serialization.Serializable

@Serializable
data class InitUploadRequest(
    val name: String,
    val size: Long,
    val mimeType: String,
)

@Serializable
data class PresignedPart(
    val partNumber: Int,
    val url: String,
)

@Serializable
data class InitUploadResponse(
    val objectId: String,
    val uploadId: String,
    val partSize: Long,
    val totalParts: Int,
    val presignedUrls: List<PresignedPart> = emptyList(),
)

@Serializable
data class PartUrlsRequest(
    val partNumbers: List<Int>,
)

@Serializable
data class PartUrlsResponse(
    val presignedUrls: List<PresignedPart> = emptyList(),
)

@Serializable
data class CompletedPart(
    val partNumber: Int,
    val eTag: String,
)

@Serializable
data class CompleteUploadRequest(
    val parts: List<CompletedPart>,
)

@Serializable
data class ObjectResponse(
    val id: String,
    val name: String? = null,
    val status: String? = null,
)

/** Persisted in sync_files.partProgressJson so an interrupted multipart upload resumes. */
@Serializable
data class UploadProgress(
    val objectId: String,
    val uploadId: String,
    val partSize: Long,
    val totalParts: Int,
    val parts: List<CompletedPart> = emptyList(),
)
