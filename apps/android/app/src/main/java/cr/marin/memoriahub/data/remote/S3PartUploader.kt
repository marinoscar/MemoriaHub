package cr.marin.memoriahub.data.remote

import android.content.Context
import android.net.Uri
import cr.marin.memoriahub.di.UploadClient
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

/**
 * PUTs a single multipart part directly to its presigned S3/R2 URL (no auth header)
 * and returns the part's ETag. Retries are handled by the [UploadClient] OkHttp
 * stack (status + throttle-body + IOException).
 */
@Singleton
class S3PartUploader @Inject constructor(
    @ApplicationContext private val context: Context,
    @UploadClient private val client: OkHttpClient,
) {
    suspend fun putPart(
        url: String,
        uri: Uri,
        offset: Long,
        length: Long,
        mimeType: String,
    ): String = withContext(Dispatchers.IO) {
        val body = ContentUriRequestBody(
            resolver = context.contentResolver,
            uri = uri,
            offset = offset,
            length = length,
            mediaType = mimeType.toMediaTypeOrNull(),
        )
        val request = Request.Builder().url(url).put(body).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("Part upload failed: HTTP ${response.code}")
            }
            response.header("ETag")
                ?: response.header("etag")
                ?: throw IOException("Part upload response missing ETag")
        }
    }
}
