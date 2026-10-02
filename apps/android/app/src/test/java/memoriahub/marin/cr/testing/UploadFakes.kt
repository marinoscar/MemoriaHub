package memoriahub.marin.cr.testing

import memoriahub.marin.cr.ledger.CompletedPart
import memoriahub.marin.cr.ledger.LedgerFile
import memoriahub.marin.cr.ledger.SyncFileState
import memoriahub.marin.cr.ledger.UploadLedger
import memoriahub.marin.cr.upload.ContentSource
import memoriahub.marin.cr.upload.UploadBackoff
import java.io.ByteArrayInputStream
import java.io.FileNotFoundException
import java.io.InputStream

/**
 * In-memory [UploadLedger] honouring the #510/#511 contract: `nextBatch` returns orphaned
 * `UPLOADING`/`REGISTERING` rows first, then `QUEUED` and due `FAILED` rows (by id); `markFailed`
 * applies [UploadBackoff]. Every call is appended to [events] (shared with the fake server so
 * tests can assert ordering), and [onRecordPart] lets a test act after a part is persisted
 * (e.g. "kill" the process by cancelling the run).
 */
class FakeUploadLedger(private val events: MutableList<String> = java.util.Collections.synchronizedList(mutableListOf())) : UploadLedger {
    data class Row(
        var file: LedgerFile,
        var nextAttemptAt: Long? = null,
        var lastError: String? = null,
        var lastErrorCode: String? = null,
        var mediaItemId: String? = null,
    )

    val rows = linkedMapOf<Long, Row>()
    /** Ids a config change excluded (T17) or a scan removed (T19) meanwhile: [isActive] is false. */
    val inactive = java.util.Collections.synchronizedSet(mutableSetOf<Long>())
    val partUploadAuth = mutableMapOf<Long, String>()
    val log: List<String> get() = events
    var onRecordPart: suspend (Long, CompletedPart) -> Unit = { _, _ -> }

    fun add(file: LedgerFile): FakeUploadLedger = apply { rows[file.id] = Row(file) }

    fun row(id: Long): Row = rows.getValue(id)
    fun state(id: Long): SyncFileState = row(id).file.state

    private fun update(id: Long, event: String, change: (LedgerFile) -> LedgerFile) = synchronized(this) {
        val row = rows.getValue(id)
        row.file = change(row.file)
        events += "ledger.$event:$id"
    }

    override suspend fun nextBatch(limit: Int, nowMs: Long): List<LedgerFile> = synchronized(this) {
        val all = rows.values.map { it }
        val resumable = all.filter { it.file.state == SyncFileState.UPLOADING || it.file.state == SyncFileState.REGISTERING }
        val queued = all.filter {
            it.file.state == SyncFileState.QUEUED ||
                (it.file.state == SyncFileState.FAILED && (it.nextAttemptAt ?: 0) <= nowMs)
        }
        (resumable + queued).take(limit).map { it.file }
    }

    override suspend fun markHashing(id: Long) = update(id, "hashing") { it.copy(state = SyncFileState.HASHING) }

    override suspend fun saveHash(id: Long, contentHash: String) = update(id, "hash") { it.copy(contentHash = contentHash) }

    override suspend fun startUpload(id: Long, objectId: String, uploadId: String?, partSize: Long, totalParts: Int) =
        update(id, "start") {
            it.copy(state = SyncFileState.UPLOADING, objectId = objectId, uploadId = uploadId, partSize = partSize, totalParts = totalParts)
        }

    override suspend fun recordPart(id: Long, part: CompletedPart) {
        update(id, "part${part.partNumber}") { f ->
            f.copy(completedParts = (f.completedParts.filter { it.partNumber != part.partNumber } + part).sortedBy { it.partNumber })
        }
        onRecordPart(id, part)
    }

    override suspend fun replaceParts(id: Long, parts: List<CompletedPart>) =
        update(id, "replaceParts") { it.copy(completedParts = parts.sortedBy { p -> p.partNumber }) }

    override suspend fun markRegistering(id: Long) = update(id, "registering") { it.copy(state = SyncFileState.REGISTERING) }

    override suspend fun markUploaded(id: Long, mediaItemId: String?) {
        update(id, "uploaded") { it.copy(state = SyncFileState.UPLOADED, objectId = null, uploadId = null, partSize = null, totalParts = null, completedParts = emptyList()) }
        row(id).mediaItemId = mediaItemId
    }

    override suspend fun markDeduplicated(id: Long, mediaItemId: String?) {
        update(id, "deduplicated") { it.copy(state = SyncFileState.DEDUPLICATED, objectId = null, uploadId = null, partSize = null, totalParts = null, completedParts = emptyList()) }
        row(id).mediaItemId = mediaItemId
    }

    override suspend fun resetUploadSession(id: Long) =
        update(id, "reset") { it.copy(objectId = null, uploadId = null, partSize = null, totalParts = null, completedParts = emptyList()) }

    override suspend fun markFailed(id: Long, error: String, errorCode: String?, retryable: Boolean, nowMs: Long) {
        synchronized(this) {
            val row = rows.getValue(id)
            val attempts = row.file.attempts + 1
            val blocked = !retryable || UploadBackoff.blocks(attempts)
            row.file = row.file.copy(state = if (blocked) SyncFileState.BLOCKED else SyncFileState.FAILED, attempts = attempts)
            row.nextAttemptAt = if (blocked) null else nowMs + UploadBackoff.delayMs(attempts)!!
            row.lastError = error
            row.lastErrorCode = errorCode
            events += "ledger.failed:$id:$errorCode"
        }
    }

    override suspend fun isActive(id: Long): Boolean = id !in inactive && rows.containsKey(id)

    override suspend fun savePartUploadAuth(id: Long, partUploadAuth: String) {
        synchronized(this) {
            this.partUploadAuth[id] = partUploadAuth
            events += "ledger.auth:$id:$partUploadAuth"
        }
    }

    companion object {
        fun file(
            id: Long,
            size: Int,
            state: SyncFileState = SyncFileState.QUEUED,
            name: String = "IMG_$id.jpg",
            isVideo: Boolean = false,
            contentHash: String? = null,
            objectId: String? = null,
            uploadId: String? = null,
            partSize: Long? = null,
            totalParts: Int? = null,
            parts: List<CompletedPart> = emptyList(),
            attempts: Int = 0,
        ) = LedgerFile(
            id = id,
            uri = "content://media/external/images/media/$id",
            displayName = name,
            mimeType = if (isVideo) "video/mp4" else "image/jpeg",
            isVideo = isVideo,
            sizeBytes = size.toLong(),
            dateTakenMs = 1_780_000_000_000L,
            relativePath = "DCIM/Camera/",
            bucketId = "b1",
            state = state,
            contentHash = contentHash,
            objectId = objectId,
            uploadId = uploadId,
            partSize = partSize,
            totalParts = totalParts,
            completedParts = parts,
            attempts = attempts,
        )
    }
}

/** [ContentSource] over in-memory byte arrays; counts opens and can simulate a vanished file or revoked permission. */
class FakeContentSource : ContentSource {
    val files = mutableMapOf<String, ByteArray>()
    val missing = mutableSetOf<String>()
    val denied = mutableSetOf<String>()
    var opens = 0

    fun put(uri: String, bytes: ByteArray) = apply { files[uri] = bytes }

    override fun openStream(uri: String): InputStream = open(uri, 0, Long.MAX_VALUE)

    override fun openRange(uri: String, offset: Long, length: Long): InputStream = open(uri, offset, length)

    private fun open(uri: String, offset: Long, length: Long): InputStream {
        synchronized(this) { opens++ }
        if (uri in missing) throw FileNotFoundException(uri)
        if (uri in denied) throw SecurityException("revoked")
        val bytes = files[uri] ?: throw FileNotFoundException(uri)
        val start = offset.coerceAtMost(bytes.size.toLong()).toInt()
        val end = minOf(bytes.size.toLong(), offset + minOf(length, Long.MAX_VALUE - offset)).toInt()
        return ByteArrayInputStream(bytes, start, end - start)
    }

    companion object {
        fun bytes(size: Int, seed: Int = 7): ByteArray = ByteArray(size) { ((it * 31 + seed) % 251).toByte() }
    }
}
