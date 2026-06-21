package cr.marin.memoriahub.core.network.dto

import kotlinx.serialization.Serializable

/**
 * Success responses are wrapped by the API's TransformInterceptor as `{ data, meta? }`.
 * Error responses are NOT wrapped (see [ApiError]).
 */
@Serializable
data class ApiEnvelope<T>(
    val data: T,
)
