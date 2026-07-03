package cr.marin.memoriahub.sync

import android.content.Context
import android.net.Uri
import cr.marin.memoriahub.core.network.ApiException
import cr.marin.memoriahub.core.network.api.MediaApi
import cr.marin.memoriahub.core.network.api.StorageApi
import cr.marin.memoriahub.core.network.dto.CompleteUploadRequest
import cr.marin.memoriahub.core.network.dto.CompletedPart
import cr.marin.memoriahub.core.network.dto.CreateMediaRequest
import cr.marin.memoriahub.core.network.dto.InitUploadRequest
import cr.marin.memoriahub.core.network.dto.PartUrlsRequest
import cr.marin.memoriahub.core.network.dto.UploadProgress
import cr.marin.memoriahub.core.network.parseApiError
import cr.marin.memoriahub.core.storage.AppConfigStore
import cr.marin.memoriahub.core.util.TimeProvider
import cr.marin.memoriahub.core.util.sha256Hex
import cr.marin.memoriahub.data.db.MediaType
import cr.marin.memoriahub.data.db.SyncFileDao
import cr.marin.memoriahub.data.db.SyncFileEntity
import cr.marin.memoriahub.data.db.SyncRunDao
import cr.marin.memoriahub.data.db.SyncRunEntity
import cr.marin.memoriahub.data.db.SyncStatus
import cr.marin.memoriahub.data.remote.S3PartUploader
import cr.marin.memoriahub.data.repo.CircleRepository
import cr.marin.memoriahub.data.repo.SyncRepository
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.IOException
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.min

data class SyncSummary(
    val total: Int = 0,
    val uploaded: Int = 0,
    val skipped: Int = 0,
    val failed: Int = 0,
    /** Files that vanished from the device mid-queue — a non-event, never counted as failed. */
    val gone: Int = 0,
)

private enum class Outcome { UPLOADED, SKIPPED, FAILED, GONE }

/**
 * The robust per-file upload pipeline and run orchestrator, mirroring the CLI sync
 * engine: hash (with cache) -> dedup pre-check -> multipart init -> presigned part
 * PUTs (resumable) -> complete -> register MediaItem. State transitions are persisted
 * at every step so a killed process resumes cleanly.
 */
@Singleton
class SyncEngine @Inject constructor(
    @param:ApplicationContext private val context: Context,
    private val storageApi: StorageApi,
    private val mediaApi: MediaApi,
    private val uploader: S3PartUploader,
    private val syncFileDao: SyncFileDao,
    private val syncRunDao: SyncRunDao,
    private val syncRepository: SyncRepository,
    private val circleRepository: CircleRepository,
    private val appConfigStore: AppConfigStore,
    private val time: TimeProvider,
    private val json: Json,
) {
    /**
     * Phase 1 — discovery. Crash recovery, reconcile (the scan planner decides full vs
     * incremental; [requestedFull] forces full), and re-queue of retryable failures.
     * DB + MediaStore only, no network — safe to run as plain background work; callers
     * check [SyncRepository.pendingWorkCount] afterwards to decide whether the upload
     * phase warrants a foreground promotion.
     */
    suspend fun prepare(requestedFull: Boolean = false) {
        syncRepository.resetStaleActive()
        syncRepository.reconcile(requestedFull = requestedFull)
        // Auto-retry transient failures each run; exhausted (BLOCKED) rows stay parked.
        syncFileDao.requeueFailed(includeBlocked = false, resetAttempts = false, now = time.nowMillis())
    }

    /** Phase 2 — upload. Drains the queue and records the run. Call [prepare] first. */
    suspend fun processQueue(trigger: String): SyncSummary {
        val circleId = circleRepository.resolveTargetCircleId()
        val startedAt = time.nowMillis()
        val runId = syncRunDao.insert(
            SyncRunEntity(trigger = trigger, startedAt = startedAt),
        )

        var uploaded = 0
        var skipped = 0
        var failed = 0
        var gone = 0

        if (circleId != null) {
            val semaphore = Semaphore(CONCURRENCY)
            coroutineScope {
                while (isActive) {
                    val batch = syncFileDao.nextWorkBatch(CONCURRENCY * 4)
                    if (batch.isEmpty()) break
                    val outcomes = batch.map { entity ->
                        async {
                            semaphore.withPermit { processOne(entity, circleId) }
                        }
                    }.awaitAll()
                    outcomes.forEach {
                        when (it) {
                            Outcome.UPLOADED -> uploaded++
                            Outcome.SKIPPED -> skipped++
                            Outcome.FAILED -> failed++
                            Outcome.GONE -> gone++
                        }
                    }
                }
            }
        }

        // Gone files are excluded from the persisted run counts (schema unchanged):
        // a file deleted from the device before upload is a non-event, not a failure.
        val total = uploaded + skipped + failed
        syncRunDao.update(
            SyncRunEntity(
                id = runId,
                trigger = trigger,
                startedAt = startedAt,
                finishedAt = time.nowMillis(),
                total = total,
                uploaded = uploaded,
                skipped = skipped,
                failed = failed,
            ),
        )
        return SyncSummary(total, uploaded, skipped, failed, gone)
    }

    private suspend fun processOne(entity: SyncFileEntity, circleId: String): Outcome {
        var current = entity.copy(
            status = SyncStatus.HASHING,
            circleId = circleId,
            attemptCount = entity.attemptCount + 1,
            lastError = null,
            updatedAt = time.nowMillis(),
        )
        syncFileDao.upsert(current)

        return try {
            val uri = Uri.parse(current.contentUri)
            val size = if (current.sizeBytes > 0) current.sizeBytes else fileSize(uri)
            if (size <= 0) {
                if (isGoneFromMediaStore(uri)) return dropGone(current)
                throw IOException("File is empty or unreadable")
            }

            // 1. Hash (reuse cached when available).
            val sha = current.sha256 ?: hashFile(uri)
            current = current.copy(sha256 = sha, sizeBytes = size, status = SyncStatus.UPLOADING)
            syncFileDao.upsert(current)

            // 2. Dedup pre-check (best-effort optimization; server is authoritative).
            val alreadyPresent = runCatching {
                mediaApi.listByContentHash(circleId, sha).data.items.isNotEmpty()
            }.getOrDefault(false)
            if (alreadyPresent) {
                return finishSkipped(current)
            }

            // 3. Multipart upload (resumable).
            val progress = current.partProgressJson
                ?.let { runCatching { json.decodeFromString<UploadProgress>(it) }.getOrNull() }
            val completed = uploadParts(uri, size, current, progress).also { final ->
                current = current.copy(
                    storageObjectId = final.objectId,
                    uploadId = final.uploadId,
                    partProgressJson = json.encodeToString(final),
                )
                syncFileDao.upsert(current)
            }

            // 4. Complete multipart.
            storageApi.completeUpload(
                completed.objectId,
                CompleteUploadRequest(completed.parts.sortedBy { it.partNumber }),
            )

            // 5. Register as a circle MediaItem.
            val outcome = registerMedia(current, circleId, completed.objectId, sha, size)
            outcome
        } catch (e: java.io.FileNotFoundException) {
            // Deleted on-device mid-queue. Confirm before dropping — a transient
            // permission problem must not silently erase queue rows.
            if (isGoneFromMediaStore(Uri.parse(current.contentUri))) dropGone(current) else failOne(current, e)
        } catch (e: Exception) {
            failOne(current, e)
        }
    }

    /**
     * True only when MediaStore positively confirms the item no longer exists.
     * Any query error (SecurityException, provider hiccup) → NOT confirmed →
     * the caller takes the normal failure path instead of deleting state.
     */
    private fun isGoneFromMediaStore(uri: Uri): Boolean = runCatching {
        context.contentResolver.query(
            uri,
            arrayOf(android.provider.MediaStore.MediaColumns._ID),
            null,
            null,
            null,
        )?.use { it.count == 0 } ?: true
    }.getOrDefault(false)

    private suspend fun dropGone(entity: SyncFileEntity): Outcome {
        syncFileDao.deleteById(entity.mediaStoreId)
        return Outcome.GONE
    }

    private suspend fun uploadParts(
        uri: Uri,
        size: Long,
        entity: SyncFileEntity,
        existing: UploadProgress?,
    ): UploadProgress {
        val objectId: String
        val uploadId: String
        val partSize: Long
        val totalParts: Int
        val urlCache = HashMap<Int, String>()
        val done = LinkedHashMap<Int, String>()

        if (existing != null) {
            objectId = existing.objectId
            uploadId = existing.uploadId
            partSize = existing.partSize
            totalParts = existing.totalParts
            existing.parts.forEach { done[it.partNumber] = it.eTag }
        } else {
            val init = storageApi.initUpload(
                InitUploadRequest(name = entity.displayName, size = size, mimeType = entity.mimeType),
            ).data
            objectId = init.objectId
            uploadId = init.uploadId
            partSize = init.partSize
            totalParts = init.totalParts
            init.presignedUrls.forEach { urlCache[it.partNumber] = it.url }
        }

        for (part in 1..totalParts) {
            if (done.containsKey(part)) continue
            val url = urlCache[part] ?: fetchPartUrls(objectId, part, totalParts, urlCache)
            val offset = (part - 1).toLong() * partSize
            val length = min(partSize, size - offset)
            val eTag = uploader.putPart(url, uri, offset, length, entity.mimeType)
            done[part] = eTag

            // Persist progress after each part so an interruption resumes here.
            val snapshot = UploadProgress(
                objectId = objectId,
                uploadId = uploadId,
                partSize = partSize,
                totalParts = totalParts,
                parts = done.map { CompletedPart(it.key, it.value) },
            )
            syncFileDao.upsert(
                entity.copy(
                    status = SyncStatus.UPLOADING,
                    storageObjectId = objectId,
                    uploadId = uploadId,
                    partProgressJson = json.encodeToString(snapshot),
                    updatedAt = time.nowMillis(),
                ),
            )
        }

        return UploadProgress(
            objectId = objectId,
            uploadId = uploadId,
            partSize = partSize,
            totalParts = totalParts,
            parts = done.map { CompletedPart(it.key, it.value) },
        )
    }

    private suspend fun fetchPartUrls(
        objectId: String,
        fromPart: Int,
        totalParts: Int,
        cache: HashMap<Int, String>,
    ): String {
        val end = min(fromPart + PART_URL_BATCH - 1, totalParts)
        val numbers = (fromPart..end).toList()
        val response = storageApi.getPartUrls(objectId, PartUrlsRequest(numbers)).data
        response.presignedUrls.forEach { cache[it.partNumber] = it.url }
        return cache[fromPart] ?: throw IOException("No presigned URL for part $fromPart")
    }

    private suspend fun registerMedia(
        entity: SyncFileEntity,
        circleId: String,
        objectId: String,
        sha: String,
        size: Long,
    ): Outcome {
        val request = CreateMediaRequest(
            storageObjectId = objectId,
            circleId = circleId,
            type = if (entity.type == MediaType.VIDEO) "video" else "photo",
            source = "android",
            originalFilename = entity.displayName,
            contentHash = sha,
            capturedAt = entity.dateTakenMs?.let { Instant.ofEpochMilli(it).toString() },
            sourceDeviceId = appConfigStore.deviceId,
            sourceDeviceName = android.os.Build.MODEL,
            sourcePath = entity.relativePath ?: entity.displayName,
        )
        val response = mediaApi.createMedia(request)
        if (!response.isSuccessful) {
            val apiError = response.parseApiError(json)
            throw ApiException(response.code(), apiError)
        }
        val body = response.body()?.data
        val mediaItemId = body?.id
        return if (body?.deduplicated == true) {
            syncFileDao.upsert(
                entity.copy(
                    status = SyncStatus.SKIPPED,
                    mediaItemId = mediaItemId,
                    storageObjectId = objectId,
                    partProgressJson = null,
                    uploadedAt = time.nowMillis(),
                    updatedAt = time.nowMillis(),
                ),
            )
            Outcome.SKIPPED
        } else {
            syncFileDao.upsert(
                entity.copy(
                    status = SyncStatus.UPLOADED,
                    mediaItemId = mediaItemId,
                    storageObjectId = objectId,
                    partProgressJson = null,
                    uploadedAt = time.nowMillis(),
                    updatedAt = time.nowMillis(),
                ),
            )
            Outcome.UPLOADED
        }
    }

    private suspend fun finishSkipped(entity: SyncFileEntity): Outcome {
        syncFileDao.upsert(
            entity.copy(
                status = SyncStatus.SKIPPED,
                partProgressJson = null,
                uploadedAt = time.nowMillis(),
                updatedAt = time.nowMillis(),
            ),
        )
        return Outcome.SKIPPED
    }

    private suspend fun failOne(entity: SyncFileEntity, error: Throwable): Outcome {
        val blocked = entity.attemptCount >= ATTEMPTS_CAP
        syncFileDao.upsert(
            entity.copy(
                status = if (blocked) SyncStatus.BLOCKED else SyncStatus.FAILED,
                lastError = error.message ?: error.javaClass.simpleName,
                updatedAt = time.nowMillis(),
            ),
        )
        return Outcome.FAILED
    }

    private fun hashFile(uri: Uri): String {
        val stream = context.contentResolver.openInputStream(uri)
            ?: throw IOException("Cannot open $uri for hashing")
        return sha256Hex(stream)
    }

    private fun fileSize(uri: Uri): Long =
        context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: -1L

    private companion object {
        const val CONCURRENCY = 3
        const val ATTEMPTS_CAP = 5
        const val PART_URL_BATCH = 50
    }
}
