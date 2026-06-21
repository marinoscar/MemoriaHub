package cr.marin.memoriahub.core.network.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * The API's HttpExceptionFilter error envelope (top-level, NOT wrapped in `data`).
 * For RFC-8628 device polling, [error] / [errorDescription] carry the OAuth status
 * (`authorization_pending`, `slow_down`, `access_denied`, `expired_token`, …).
 */
@Serializable
data class ApiError(
    val statusCode: Int? = null,
    val code: String? = null,
    val message: String? = null,
    val error: String? = null,
    @SerialName("error_description")
    val errorDescription: String? = null,
)
