package cr.marin.memoriahub.core.network

import cr.marin.memoriahub.core.network.dto.ApiError
import kotlinx.serialization.json.Json
import retrofit2.Response

/** Parse a non-2xx Retrofit [Response] error body into an [ApiError] (best-effort). */
fun Response<*>.parseApiError(json: Json): ApiError? {
    val raw = errorBody()?.string()?.takeIf { it.isNotBlank() } ?: return null
    return runCatching { json.decodeFromString<ApiError>(raw) }.getOrNull()
}
