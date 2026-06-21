package cr.marin.memoriahub.core.network.dto

import kotlinx.serialization.Serializable

@Serializable
data class CreateMediaRequest(
    val storageObjectId: String,
    val circleId: String,
    val type: String,
    val source: String,
    val originalFilename: String,
    val contentHash: String? = null,
    val capturedAt: String? = null,
    val capturedAtOffset: Int? = null,
    val sourceDeviceId: String? = null,
    val sourceDeviceName: String? = null,
    val sourcePath: String? = null,
)

@Serializable
data class CreatedMedia(
    val id: String,
    val deduplicated: Boolean = false,
)

@Serializable
data class MediaItemBrief(
    val id: String,
)

@Serializable
data class MediaListResponse(
    val items: List<MediaItemBrief> = emptyList(),
)
