package cr.marin.memoriahub.core.network.api

import cr.marin.memoriahub.core.network.dto.ApiEnvelope
import cr.marin.memoriahub.core.network.dto.Circle
import retrofit2.http.GET

interface CircleApi {

    /** Circles the caller is a member of. The personal circle has isPersonal=true. */
    @GET("api/circles")
    suspend fun getCircles(): ApiEnvelope<List<Circle>>
}
