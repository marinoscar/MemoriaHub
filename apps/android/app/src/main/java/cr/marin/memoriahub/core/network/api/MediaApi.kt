package cr.marin.memoriahub.core.network.api

import cr.marin.memoriahub.core.network.dto.ApiEnvelope
import cr.marin.memoriahub.core.network.dto.CreateMediaRequest
import cr.marin.memoriahub.core.network.dto.CreatedMedia
import cr.marin.memoriahub.core.network.dto.MediaListResponse
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query

interface MediaApi {

    /**
     * Registers an uploaded StorageObject as a circle MediaItem. Returns a raw
     * [Response] so the caller can distinguish 201 (new) from 200 (dedup hit) and
     * read the `deduplicated` flag.
     */
    @POST("api/media")
    suspend fun createMedia(@Body body: CreateMediaRequest): Response<ApiEnvelope<CreatedMedia>>

    /** Dedup pre-check. circleId is required by the API (the CLI omits it — we don't). */
    @GET("api/media")
    suspend fun listByContentHash(
        @Query("circleId") circleId: String,
        @Query("contentHash") contentHash: String,
        @Query("pageSize") pageSize: Int = 1,
    ): ApiEnvelope<MediaListResponse>
}
