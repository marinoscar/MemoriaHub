package memoriahub.marin.cr.ledger

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * One MediaStore file the phone knows about: the ledger row (docs/specs/android-media-sync.md §8.1).
 * `(mediaStoreId, volume)` identifies the file; every status write goes through [LedgerTransitions].
 *
 * Times: [dateModified] is MediaStore's `DATE_MODIFIED` (epoch **seconds**); [dateTaken],
 * [nextAttemptAt], [uploadedAt], [createdAt], [updatedAt] are epoch **milliseconds**.
 */
@Entity(
    tableName = "sync_files",
    indices = [
        Index(value = ["mediaStoreId", "volume"], unique = true),
        Index(value = ["state", "nextAttemptAt"]),
        Index(value = ["bucketId"]),
    ],
)
data class SyncFileEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val mediaStoreId: Long,
    val volume: String,
    /** The plain `content://media/<volume>/...` URI; [memoriahub.marin.cr.media.MediaGateway] applies `setRequireOriginal` (D24). */
    val uri: String,
    val bucketId: String?,
    val bucketName: String?,
    val relativePath: String?,
    val displayName: String,
    val mimeType: String,
    val isVideo: Boolean,
    val sizeBytes: Long,
    val dateModified: Long,
    val dateTaken: Long?,
    val generationModified: Long?,
    val state: SyncFileState,
    val contentHash: String? = null,
    val objectId: String? = null,
    val uploadId: String? = null,
    val partSize: Long? = null,
    val totalParts: Int? = null,
    /** JSON `[{partNumber, eTag}]`, rewritten after every completed part. */
    val completedPartsJson: String? = null,
    /** `none` / `bearer` (#506); informational, written by the upload engine when it knows it. */
    val partUploadAuth: String? = null,
    val mediaItemId: String? = null,
    val attempts: Int = 0,
    val nextAttemptAt: Long? = null,
    val lastError: String? = null,
    val lastErrorCode: String? = null,
    val uploadedAt: Long? = null,
    val createdAt: Long,
    val updatedAt: Long,
) {
    val completedParts: List<CompletedPart> get() = CompletedParts.decode(completedPartsJson)

    /** A copy with the multipart session (and its parts) forgotten. */
    fun withoutSession(): SyncFileEntity =
        copy(objectId = null, uploadId = null, partSize = null, totalParts = null, completedPartsJson = null, partUploadAuth = null)

    fun toLedgerFile(): LedgerFile = LedgerFile(
        id = id, uri = uri, displayName = displayName, mimeType = mimeType, isVideo = isVideo,
        sizeBytes = sizeBytes, dateTakenMs = dateTaken, relativePath = relativePath, bucketId = bucketId,
        state = state, contentHash = contentHash, objectId = objectId, uploadId = uploadId,
        partSize = partSize, totalParts = totalParts, completedParts = completedParts, attempts = attempts,
    )
}

/** JSON codec for [SyncFileEntity.completedPartsJson] (sorted by part number, one entry per part). */
object CompletedParts {
    @Serializable
    private data class PartJson(val partNumber: Int, val eTag: String)

    private val json = Json { ignoreUnknownKeys = true }
    private val serializer = ListSerializer(PartJson.serializer())

    fun decode(raw: String?): List<CompletedPart> {
        if (raw.isNullOrBlank()) return emptyList()
        return runCatching { json.decodeFromString(serializer, raw) }.getOrDefault(emptyList())
            .map { CompletedPart(it.partNumber, it.eTag) }
    }

    fun encode(parts: List<CompletedPart>): String? {
        if (parts.isEmpty()) return null
        val unique = parts.associateBy { it.partNumber }.values.sortedBy { it.partNumber }
        return json.encodeToString(serializer, unique.map { PartJson(it.partNumber, it.eTag) })
    }

    /** [existing] with [part] added (a re-sent part number replaces the old ETag). */
    fun plus(existing: List<CompletedPart>, part: CompletedPart): List<CompletedPart> =
        (existing.filter { it.partNumber != part.partNumber } + part).sortedBy { it.partNumber }
}

/** One local sync run, for the Diagnostics "recent runs" card (the last [SyncRunDao.KEEP] are kept). */
@Entity(tableName = "sync_runs", indices = [Index(value = ["startedAt"])])
data class SyncRunEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** `SyncTrigger.wire` (periodic, content_trigger, manual, app_open, initial). */
    val trigger: String,
    /** Check-in `run.status` (ok, partial, failed, skipped, paused). */
    val status: String,
    val startedAt: Long,
    val finishedAt: Long?,
    val filesUploaded: Int = 0,
    val filesDeduplicated: Int = 0,
    val filesFailed: Int = 0,
    val bytesUploaded: Long = 0,
    val errorCode: String? = null,
)
