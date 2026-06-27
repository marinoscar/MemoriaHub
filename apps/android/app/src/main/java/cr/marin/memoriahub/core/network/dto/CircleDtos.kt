package cr.marin.memoriahub.core.network.dto

import kotlinx.serialization.Serializable

@Serializable
data class Circle(
    val id: String,
    val name: String,
    val isPersonal: Boolean = false,
    val description: String? = null,
    val role: String? = null,
)

/**
 * GET /api/circles returns a paginated envelope ({ items, total, page, pageSize,
 * totalPages }), not a bare array. Only `items` is needed here; the rest are
 * ignored via the Json `ignoreUnknownKeys` config.
 */
@Serializable
data class CircleListResponse(
    val items: List<Circle> = emptyList(),
)
