package cr.marin.memoriahub.di

import cr.marin.memoriahub.BuildConfig
import cr.marin.memoriahub.core.network.AuthInterceptor
import cr.marin.memoriahub.core.network.BaseUrlInterceptor
import cr.marin.memoriahub.core.network.RetryInterceptor
import cr.marin.memoriahub.core.network.TokenAuthenticator
import cr.marin.memoriahub.core.network.api.AuthApi
import cr.marin.memoriahub.core.network.api.CircleApi
import cr.marin.memoriahub.core.network.api.MediaApi
import cr.marin.memoriahub.core.network.api.StorageApi
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.TimeUnit
import javax.inject.Qualifier
import javax.inject.Singleton

/** Bare OkHttp client (no auth/base-url rewrite) for presigned S3/R2 part uploads. */
@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class UploadClient

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides
    @Singleton
    fun provideJson(): Json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    @Provides
    @Singleton
    fun provideRetryInterceptor(): RetryInterceptor = RetryInterceptor()

    private fun loggingInterceptor(): HttpLoggingInterceptor =
        HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.BASIC
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
            // Never log auth tokens or cookies.
            redactHeader("Authorization")
            redactHeader("Cookie")
            redactHeader("Set-Cookie")
        }

    @Provides
    @Singleton
    fun provideApiOkHttpClient(
        retry: RetryInterceptor,
        baseUrl: BaseUrlInterceptor,
        auth: AuthInterceptor,
        authenticator: TokenAuthenticator,
    ): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .addInterceptor(retry)
        .addInterceptor(baseUrl)
        .addInterceptor(auth)
        .addInterceptor(loggingInterceptor())
        .authenticator(authenticator)
        .build()

    @Provides
    @Singleton
    @UploadClient
    fun provideUploadOkHttpClient(retry: RetryInterceptor): OkHttpClient =
        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(0, TimeUnit.SECONDS) // large part uploads stream without a write deadline
            .addInterceptor(retry)
            .build()

    @Provides
    @Singleton
    fun provideRetrofit(client: OkHttpClient, json: Json): Retrofit {
        val contentType = "application/json".toMediaType()
        return Retrofit.Builder()
            // Placeholder origin; BaseUrlInterceptor rewrites it to the configured server.
            .baseUrl("http://localhost/")
            .client(client)
            .addConverterFactory(json.asConverterFactory(contentType))
            .build()
    }

    @Provides
    @Singleton
    fun provideAuthApi(retrofit: Retrofit): AuthApi = retrofit.create(AuthApi::class.java)

    @Provides
    @Singleton
    fun provideCircleApi(retrofit: Retrofit): CircleApi = retrofit.create(CircleApi::class.java)

    @Provides
    @Singleton
    fun provideStorageApi(retrofit: Retrofit): StorageApi = retrofit.create(StorageApi::class.java)

    @Provides
    @Singleton
    fun provideMediaApi(retrofit: Retrofit): MediaApi = retrofit.create(MediaApi::class.java)
}
