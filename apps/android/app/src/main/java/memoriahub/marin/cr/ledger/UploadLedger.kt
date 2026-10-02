package memoriahub.marin.cr.ledger

data class LedgerFile(
    val id: Long, val uri: String, val displayName: String, val mimeType: String, val isVideo: Boolean,
    val sizeBytes: Long, val dateTakenMs: Long?, val relativePath: String?, val bucketId: String?,
    val state: SyncFileState, val contentHash: String?, val objectId: String?, val uploadId: String?,
    val partSize: Long?, val totalParts: Int?, val completedParts: List<CompletedPart>, val attempts: Int,
)
data class CompletedPart(val partNumber: Int, val eTag: String)

interface UploadLedger {
    /** Next batch of files ready to upload: resumable UPLOADING/REGISTERING first (D9), then QUEUED and FAILED whose nextAttemptAt <= nowMs, oldest first. */
    suspend fun nextBatch(limit: Int, nowMs: Long): List<LedgerFile>
    suspend fun markHashing(id: Long)
    suspend fun saveHash(id: Long, contentHash: String)
    suspend fun startUpload(id: Long, objectId: String, uploadId: String?, partSize: Long, totalParts: Int)
    suspend fun recordPart(id: Long, part: CompletedPart)            // persisted after EVERY part
    suspend fun replaceParts(id: Long, parts: List<CompletedPart>)
    suspend fun markRegistering(id: Long)
    suspend fun markUploaded(id: Long, mediaItemId: String?)
    suspend fun markDeduplicated(id: Long, mediaItemId: String?)
    /** Clears objectId/uploadId/parts so the next attempt re-inits. */
    suspend fun resetUploadSession(id: Long)
    /** retryable=false or attempts reaching 5 → BLOCKED; else FAILED with nextAttemptAt from the backoff (30s, 2m, 10m, 1h). */
    suspend fun markFailed(id: Long, error: String, errorCode: String?, retryable: Boolean, nowMs: Long)
    /** False once the row left the upload path (excluded by a config change, T17, or removed as vanished, T19): its writes are ignored, so the engine stops the file at the next part boundary. */
    suspend fun isActive(id: Long): Boolean
    /** Records `none`/`bearer` (#506) for the current multipart session; informational. */
    suspend fun savePartUploadAuth(id: Long, partUploadAuth: String)
}
