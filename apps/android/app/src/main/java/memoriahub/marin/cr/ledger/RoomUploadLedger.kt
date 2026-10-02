package memoriahub.marin.cr.ledger

import memoriahub.marin.cr.diagnostics.AppLog

/**
 * [UploadLedger] over the Room ledger: the upload engine's (#511) per-file writes (T4–T13,
 * docs/specs/android-media-sync.md §8.2, §8.4, §9). Each call is one transaction on one row.
 *
 * Contract details the engine relies on:
 * - Every claimed `QUEUED` or `FAILED` row starts with [markHashing] (T4/T5), even when a hash is
 *   already stored. Rows [nextBatch] returns in `UPLOADING`/`REGISTERING` (resumes, D9) skip it.
 * - A row in `HASHING` that still holds an earlier multipart session (a failed attempt being
 *   resumed) moves to `UPLOADING` (T6) on the first [recordPart]/[replaceParts]/[markRegistering].
 * - A row that left the upload path meanwhile (excluded by a config change, T17, or removed as
 *   vanished, T19) ignores further writes; the engine sees it with [isActive] and stops at the
 *   next part boundary.
 * - [markFailed] counts an attempt; network-policy, pause and timeout stops must NOT call it.
 */
class RoomUploadLedger(
    private val files: SyncFileDao,
    private val tx: LedgerTransactions,
    private val clock: () -> Long = System::currentTimeMillis,
) : UploadLedger {

    override suspend fun nextBatch(limit: Int, nowMs: Long): List<LedgerFile> =
        files.nextBatchRows(limit, nowMs).map { it.toLedgerFile() }

    /** Whether [id] is still on the upload path (not excluded, not removed). */
    suspend fun isActive(id: Long): Boolean =
        files.get(id)?.state?.let { it != SyncFileState.EXCLUDED } ?: false

    suspend fun state(id: Long): SyncFileState? = files.get(id)?.state

    override suspend fun markHashing(id: Long) = write(id, "markHashing") { row ->
        if (row.state == SyncFileState.HASHING) row else move(row, SyncFileState.HASHING)
    }

    override suspend fun saveHash(id: Long, contentHash: String) = write(id, "saveHash") { row ->
        row.copy(contentHash = contentHash.lowercase())
    }

    override suspend fun startUpload(id: Long, objectId: String, uploadId: String?, partSize: Long, totalParts: Int) =
        write(id, "startUpload") { row ->
            // T6 from HASHING; T8 (session re-init) from UPLOADING.
            move(row, SyncFileState.UPLOADING).copy(
                objectId = objectId, uploadId = uploadId, partSize = partSize, totalParts = totalParts,
                completedPartsJson = null,
            )
        }

    /** Records `none`/`bearer` (#506) for the current session; informational. */
    suspend fun savePartUploadAuth(id: Long, partUploadAuth: String) = write(id, "savePartUploadAuth") { row ->
        row.copy(partUploadAuth = partUploadAuth)
    }

    override suspend fun recordPart(id: Long, part: CompletedPart) = write(id, "recordPart") { row ->
        uploading(row).copy(completedPartsJson = CompletedParts.encode(CompletedParts.plus(row.completedParts, part)))
    }

    override suspend fun replaceParts(id: Long, parts: List<CompletedPart>) = write(id, "replaceParts") { row ->
        uploading(row).copy(completedPartsJson = CompletedParts.encode(parts))
    }

    override suspend fun markRegistering(id: Long) = write(id, "markRegistering") { row ->
        if (row.state == SyncFileState.REGISTERING) row else move(uploading(row), SyncFileState.REGISTERING)
    }

    override suspend fun markUploaded(id: Long, mediaItemId: String?) = write(id, "markUploaded") { row ->
        move(row, SyncFileState.UPLOADED).withoutSession().copy(
            mediaItemId = mediaItemId, uploadedAt = clock(), nextAttemptAt = null, lastError = null, lastErrorCode = null,
        )
    }

    override suspend fun markDeduplicated(id: Long, mediaItemId: String?) = write(id, "markDeduplicated") { row ->
        move(row, SyncFileState.DEDUPLICATED).withoutSession().copy(
            mediaItemId = mediaItemId, nextAttemptAt = null, lastError = null, lastErrorCode = null,
        )
    }

    override suspend fun resetUploadSession(id: Long) = write(id, "resetUploadSession") { row ->
        // T8 self-transition when uploading; otherwise only the session fields are forgotten.
        (if (row.state == SyncFileState.UPLOADING) move(row, SyncFileState.UPLOADING) else row).withoutSession()
    }

    override suspend fun markFailed(id: Long, error: String, errorCode: String?, retryable: Boolean, nowMs: Long) =
        write(id, "markFailed") { row ->
            val attempts = row.attempts + 1
            val block = !retryable || attempts >= LedgerPolicy.MAX_ATTEMPTS
            // The multipart session is kept: the next attempt resumes it (§9.1 step 3).
            move(row, if (block) SyncFileState.BLOCKED else SyncFileState.FAILED).copy(
                attempts = attempts,
                nextAttemptAt = if (block) null else LedgerPolicy.nextAttemptAt(attempts, nowMs),
                lastError = LedgerPolicy.truncateError(error),
                lastErrorCode = errorCode?.take(64),
            )
        }

    /** T6 for a resumed `HASHING` row that already holds a session; any other state is left as is. */
    private fun uploading(row: SyncFileEntity): SyncFileEntity =
        if (row.state == SyncFileState.HASHING && row.objectId != null) move(row, SyncFileState.UPLOADING) else row

    private fun move(row: SyncFileEntity, to: SyncFileState): SyncFileEntity {
        LedgerTransitions.enforce(row.state, to)
        return row.copy(state = to)
    }

    private suspend fun write(id: Long, op: String, change: (SyncFileEntity) -> SyncFileEntity) {
        tx.run {
            val row = files.get(id)
            if (row == null || row.state == SyncFileState.EXCLUDED) {
                AppLog.i(TAG, "ledger.write.skipped op=$op id=$id state=${row?.state ?: "gone"}")
                return@run
            }
            val next = change(row)
            if (next != row) files.update(next.copy(updatedAt = clock()))
        }
    }

    private companion object {
        const val TAG = "Ledger"
    }
}
