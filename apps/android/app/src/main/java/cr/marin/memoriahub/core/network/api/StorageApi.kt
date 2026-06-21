package cr.marin.memoriahub.core.network.api

import cr.marin.memoriahub.core.network.dto.ApiEnvelope
import cr.marin.memoriahub.core.network.dto.CompleteUploadRequest
import cr.marin.memoriahub.core.network.dto.InitUploadRequest
import cr.marin.memoriahub.core.network.dto.InitUploadResponse
import cr.marin.memoriahub.core.network.dto.ObjectResponse
import cr.marin.memoriahub.core.network.dto.PartUrlsRequest
import cr.marin.memoriahub.core.network.dto.PartUrlsResponse
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.POST
import retrofit2.http.Path

interface StorageApi {

    @POST("api/storage/objects/upload/init")
    suspend fun initUpload(@Body body: InitUploadRequest): ApiEnvelope<InitUploadResponse>

    @POST("api/storage/objects/{id}/upload/part-urls")
    suspend fun getPartUrls(
        @Path("id") objectId: String,
        @Body body: PartUrlsRequest,
    ): ApiEnvelope<PartUrlsResponse>

    @POST("api/storage/objects/{id}/upload/complete")
    suspend fun completeUpload(
        @Path("id") objectId: String,
        @Body body: CompleteUploadRequest,
    ): ApiEnvelope<ObjectResponse>

    @DELETE("api/storage/objects/{id}/upload/abort")
    suspend fun abortUpload(@Path("id") objectId: String): Response<Unit>
}
