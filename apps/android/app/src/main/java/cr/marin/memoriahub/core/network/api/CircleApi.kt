package cr.marin.memoriahub.core.network.api

import cr.marin.memoriahub.core.network.dto.ApiEnvelope
import cr.marin.memoriahub.core.network.dto.CircleListResponse
import retrofit2.http.GET

interface CircleApi {

    /** Circles the caller is a member of (paginated). The personal circle has isPersonal=true. */
    @GET("api/circles")
    suspend fun getCircles(): ApiEnvelope<CircleListResponse>
}
