package cr.marin.memoriahub.core.network

import cr.marin.memoriahub.core.network.dto.ApiError

/** Thrown by repositories when an API call fails with a parsed error envelope. */
class ApiException(
    val status: Int,
    val apiError: ApiError?,
    override val message: String = apiError?.message ?: apiError?.error ?: "HTTP $status",
) : Exception(message)
