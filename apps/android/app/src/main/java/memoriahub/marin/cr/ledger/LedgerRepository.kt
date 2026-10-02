package memoriahub.marin.cr.ledger

import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.media.MediaRow
import memoriahub.marin.cr.media.ScanCursorStore

/** Counts of one [LedgerRepository.ingest] call. */
data class IngestResult(
    val queued: Int = 0,
    val excluded: Int = 0,
    val requeued: Int = 0,
    val refreshed: Int = 0,
    val unchanged: Int = 0,
    /** In-flight rows whose file changed under them (T12/T13 with `SOURCE_CHANGED`). */
    val sourceChanged: Int = 0,
) {
    operator fun plus(o: IngestResult) = IngestResult(
        queued + o.queued, excluded + o.excluded, requeued + o.requeued, refreshed + o.refreshed,
        unchanged + o.unchanged, sourceChanged + o.sourceChanged,
    )
}

/** Result of re-evaluating every row against a config (T2/T3/T17/T18). */
data class ScopeChange(
    val excluded: Int = 0,
    val requeued: Int = 0,
    /**
     * Server upload sessions dropped by T17 (`objectId`s): abort them best effort with
     * `DELETE /api/storage/objects/:id/upload/abort`. The upload engine stops at its next part
     * boundary because the row is no longer `UPLOADING`.
     */
    val abortedObjectIds: List<String> = emptyList(),
)

/** Shared by [LedgerRepository.nextBatch] and [RoomUploadLedger.nextBatch] (§8.3, D9). */
internal suspend fun SyncFileDao.nextBatchRows(limit: Int, nowMs: Long): List<SyncFileEntity> {
    if (limit <= 0) return emptyList()
    val out = ArrayList<SyncFileEntity>(limit)
    out += inStates(listOf(SyncFileState.UPLOADING.name, SyncFileState.REGISTERING.name), limit)
    if (out.size < limit) out += inStates(listOf(SyncFileState.QUEUED.name), limit - out.size)
    if (out.size < limit) out += dueInState(SyncFileState.FAILED.name, nowMs, limit - out.size)
    return out
}

/**
 * The ledger's policy surface (docs/specs/android-media-sync.md §8): ingest of scan rows, config
 * re-evaluation, vanished files, statistics, retries, local runs and the local reset. The upload
 * engine's per-file writes are [RoomUploadLedger]. Status writes go through [LedgerTransitions].
 */
class LedgerRepository(
    private val files: SyncFileDao,
    private val runs: SyncRunDao,
    private val tx: LedgerTransactions,
    private val cursors: ScanCursorStore? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /**
     * Upserts scan rows (§8.3). New rows: T1 then T2 (eligible) or T3. A changed size or
     * `dateModified` after `UPLOADED`/`DEDUPLICATED` re-queues a new version (T16). A file that
     * changed while hashing or uploading fails that attempt (`SOURCE_CHANGED`, retried at once).
     * Other rows get their metadata refreshed and their eligibility re-evaluated.
     */
    suspend fun ingest(rows: List<MediaRow>, scope: SyncScope): IngestResult {
        if (rows.isEmpty()) return IngestResult()
        var result = IngestResult()
        for ((volume, volumeRows) in rows.groupBy { it.volume }) {
            for (chunk in volumeRows.chunked(INGEST_CHUNK)) {
                result += tx.run { ingestChunk(volume, chunk, scope) }
            }
        }
        return result
    }

    private suspend fun ingestChunk(volume: String, rows: List<MediaRow>, scope: SyncScope): IngestResult {
        val now = clock()
        val existing = files.findByMediaStoreIds(volume, rows.map { it.mediaStoreId }).associateBy { it.mediaStoreId }
        val inserts = ArrayList<SyncFileEntity>()
        val updates = ArrayList<SyncFileEntity>()
        var queued = 0
        var excluded = 0
        var requeued = 0
        var refreshed = 0
        var unchanged = 0
        var sourceChanged = 0
        for (row in rows.distinctBy { it.mediaStoreId }) {
            val current = existing[row.mediaStoreId]
            when (ReconcilePolicy.decide(current, row)) {
                ReconcileDecision.QUEUE -> {
                    val eligible = LedgerPolicy.isEligible(row.bucketId, row.isVideo, row.dateTakenMs, row.dateModifiedSec, scope)
                    val state = if (eligible) SyncFileState.QUEUED else SyncFileState.EXCLUDED
                    LedgerTransitions.enforce(SyncFileState.DISCOVERED, state)
                    inserts += newEntity(row, state, now)
                    if (eligible) queued++ else excluded++
                }
                ReconcileDecision.REQUEUE -> {
                    val cur = current!!
                    when (cur.state) {
                        SyncFileState.UPLOADED, SyncFileState.DEDUPLICATED -> {
                            var next = transition(cur.withMeta(row), SyncFileState.QUEUED, now).withoutSession()
                                .copy(contentHash = null, mediaItemId = null, attempts = 0, nextAttemptAt = null, uploadedAt = null)
                            if (!LedgerPolicy.isEligible(next, scope)) next = transition(next, SyncFileState.EXCLUDED, now)
                            updates += next
                            requeued++
                        }
                        SyncFileState.HASHING, SyncFileState.UPLOADING -> {
                            updates += sourceChangedFailure(cur.withMeta(row), now)
                            sourceChanged++
                        }
                        // The bytes are complete: registration finishes with them. The old size and
                        // date are kept so the next scan sees the change again and re-queues (T16).
                        SyncFileState.REGISTERING -> unchanged++
                        else -> {
                            // Not uploaded yet: the new content simply replaces the old one.
                            updates += reevaluated(cur.withMeta(row).withoutSession().copy(contentHash = null, updatedAt = now), scope, now)
                            refreshed++
                        }
                    }
                }
                ReconcileDecision.REFRESH_META -> {
                    val cur = current!!
                    updates += if (cur.state == SyncFileState.REGISTERING) {
                        cur.withMeta(row, keepContentFields = true).copy(updatedAt = now)
                    } else {
                        reevaluated(cur.withMeta(row).copy(updatedAt = now), scope, now)
                    }
                    refreshed++
                }
                ReconcileDecision.UNCHANGED -> {
                    val cur = current!!
                    val next = reevaluated(cur, scope, now)
                    if (next !== cur) updates += next
                    unchanged++
                }
            }
        }
        if (inserts.isNotEmpty()) files.insertAll(inserts)
        if (updates.isNotEmpty()) files.updateAll(updates)
        return IngestResult(queued, excluded, requeued, refreshed, unchanged, sourceChanged)
    }

    /** Re-evaluates eligibility of one row (returns the same instance when nothing changes). */
    private fun reevaluated(row: SyncFileEntity, scope: SyncScope, now: Long): SyncFileEntity {
        val target = LedgerPolicy.reevaluate(row.state, LedgerPolicy.isEligible(row, scope)) ?: return row
        val moved = transition(row, target, now)
        return if (target == SyncFileState.EXCLUDED) moved.withoutSession() else moved
    }

    private fun sourceChangedFailure(row: SyncFileEntity, now: Long): SyncFileEntity {
        val attempts = row.attempts + 1
        val blocked = attempts >= LedgerPolicy.MAX_ATTEMPTS
        val target = if (blocked) SyncFileState.BLOCKED else SyncFileState.FAILED
        return transition(row, target, now).withoutSession().copy(
            contentHash = null,
            attempts = attempts,
            nextAttemptAt = if (blocked) null else now,
            lastError = "The file changed on the phone while it was being uploaded",
            lastErrorCode = SOURCE_CHANGED,
        )
    }

    /**
     * Config application (§5.3 step 2, §8.3, D25): re-evaluates every row not `UPLOADED`,
     * `DEDUPLICATED` or `REGISTERING` with [LedgerPolicy.isEligible], so folder, type and
     * `uploadExisting` changes in either direction exclude (T17) or restore (T18) rows.
     */
    suspend fun applyScope(scope: SyncScope): ScopeChange {
        var excluded = 0
        var requeued = 0
        val aborted = ArrayList<String>()
        var afterId = 0L
        while (true) {
            val page = files.scopePage(afterId, SCOPE_PAGE)
            if (page.isEmpty()) break
            afterId = page.last().id
            val moves = page.mapNotNull { row ->
                LedgerPolicy.reevaluate(row.state, LedgerPolicy.isEligible(row, scope))?.let { row.id to it }
            }
            if (moves.isEmpty()) continue
            tx.run {
                val now = clock()
                val targets = moves.toMap()
                val rows = files.getAll(moves.map { it.first })
                val updated = rows.mapNotNull { row ->
                    // Re-check against the fresh row: the engine may have moved it since the page was read.
                    val target = LedgerPolicy.reevaluate(row.state, LedgerPolicy.isEligible(row, scope)) ?: return@mapNotNull null
                    if (target != targets[row.id]) return@mapNotNull null
                    if (target == SyncFileState.EXCLUDED) {
                        row.objectId?.let { aborted += it }
                        excluded++
                        transition(row, target, now).withoutSession()
                    } else {
                        requeued++
                        transition(row, target, now)
                    }
                }
                if (updated.isNotEmpty()) files.updateAll(updated)
            }
        }
        if (excluded > 0 || requeued > 0) AppLog.i(TAG, "ledger.scope excluded=$excluded requeued=$requeued aborted=${aborted.size}")
        return ScopeChange(excluded, requeued, aborted)
    }

    /** Folder selection changed: same as [applyScope] (a re-evaluation, not a reason column). */
    suspend fun applyFolderSelection(scope: SyncScope): ScopeChange = applyScope(scope)

    /** Rows of [volume] a full scan may declare vanished (T19 states only). */
    suspend fun vanishedCandidates(volume: String): List<SyncFileScopeRow> =
        files.inVolumeAndStates(volume, LedgerTransitions.deletable.map { it.name })

    /**
     * Removes rows whose file was deleted on the phone before upload (T19). Rows in other states
     * are kept. Never deletes anything on the server. Returns how many rows were removed.
     */
    suspend fun vanished(ids: Collection<Long>): Int {
        if (ids.isEmpty()) return 0
        var removed = 0
        for (chunk in ids.distinct().chunked(INGEST_CHUNK)) {
            removed += tx.run {
                val deletable = files.getAll(chunk).filter { LedgerTransitions.isLegalDelete(it.state) }.map { it.id }
                if (deletable.isNotEmpty()) files.deleteByIds(deletable)
                deletable.size
            }
        }
        if (removed > 0) AppLog.i(TAG, "ledger.vanished removed=$removed")
        return removed
    }

    suspend fun stats(): SyncStats = SyncStats.from(files.stateBucketCounts())

    /** Orphaned `UPLOADING`/`REGISTERING` first, then `QUEUED`, then due `FAILED`; newest `dateTaken` first. */
    suspend fun nextBatch(limit: Int, nowMs: Long = clock()): List<LedgerFile> =
        files.nextBatchRows(limit, nowMs).map { it.toLedgerFile() }

    /** T14 at run start: `HASHING` rows left by a killed process go back to `QUEUED`. */
    suspend fun recoverInterrupted(): Int = files.requeueHashing(clock())

    /** T15 for one row (`FAILED` or `BLOCKED`); false when the row is in another state or gone. */
    suspend fun retry(id: Long): Boolean = tx.run {
        val row = files.get(id) ?: return@run false
        if (row.state != SyncFileState.FAILED && row.state != SyncFileState.BLOCKED) return@run false
        files.update(transition(row, SyncFileState.QUEUED, clock()).copy(attempts = 0, nextAttemptAt = null))
        true
    }

    /** T15 for every `FAILED` row. */
    suspend fun retryFailed(): Int {
        LedgerTransitions.enforce(SyncFileState.FAILED, SyncFileState.QUEUED)
        return files.requeueAllInState(SyncFileState.FAILED.name, clock())
    }

    /** T15 for every `BLOCKED` row. */
    suspend fun retryBlocked(): Int {
        LedgerTransitions.enforce(SyncFileState.BLOCKED, SyncFileState.QUEUED)
        return files.requeueAllInState(SyncFileState.BLOCKED.name, clock())
    }

    /** The check-in `run.failedSample` (≤50): the most recently failed or blocked files. */
    suspend fun failedSample(limit: Int = FAILED_SAMPLE): List<FailedSampleEntry> =
        files.recentInStates(listOf(SyncFileState.FAILED.name, SyncFileState.BLOCKED.name), limit.coerceIn(0, FAILED_SAMPLE)).map {
            FailedSampleEntry(
                name = it.displayName,
                relativePath = it.relativePath,
                sizeBytes = it.sizeBytes,
                attempts = it.attempts,
                lastError = it.lastError?.let(LedgerPolicy::truncateError),
            )
        }

    /** Diagnostics: one file's row. */
    suspend fun file(id: Long): SyncFileEntity? = files.get(id)

    /** Files in [states] (newest first), for the Files screen (#513). */
    suspend fun filesIn(states: Collection<SyncFileState>, limit: Int): List<SyncFileEntity> =
        files.inStates(states.map { it.name }, limit)

    suspend fun isEmpty(): Boolean = files.count() == 0

    /** Records a finished local run and keeps the newest [SyncRunDao.KEEP]. */
    suspend fun recordRun(run: SyncRunEntity): Long = tx.run {
        val id = runs.insert(run)
        runs.trim(SyncRunDao.KEEP)
        id
    }

    suspend fun recentRuns(limit: Int = SyncRunDao.KEEP): List<SyncRunEntity> = runs.recent(limit)

    /**
     * Diagnostics "Reset local sync state" (§8.3): clears the ledger and the scan cursors, keeps
     * pairing, `pairedAt`, the installation id and the run history. The next scan is full and
     * rebuilds the ledger; server dedup prevents duplicates.
     */
    suspend fun resetLocalState() {
        tx.run { files.deleteAll() }
        cursors?.clear()
        AppLog.i(TAG, "ledger.reset")
    }

    private fun transition(row: SyncFileEntity, to: SyncFileState, now: Long): SyncFileEntity {
        LedgerTransitions.enforce(row.state, to)
        return row.copy(state = to, updatedAt = now)
    }

    private fun newEntity(row: MediaRow, state: SyncFileState, now: Long) = SyncFileEntity(
        mediaStoreId = row.mediaStoreId,
        volume = row.volume,
        uri = row.uri,
        bucketId = row.bucketId,
        bucketName = row.bucketName,
        relativePath = row.relativePath,
        displayName = row.displayName,
        mimeType = row.mimeType,
        isVideo = row.isVideo,
        sizeBytes = row.sizeBytes,
        dateModified = row.dateModifiedSec,
        dateTaken = row.dateTakenMs,
        generationModified = row.generationModified,
        state = state,
        createdAt = now,
        updatedAt = now,
    )

    companion object {
        private const val TAG = "Ledger"
        const val INGEST_CHUNK = 500
        const val SCOPE_PAGE = 1000
        const val FAILED_SAMPLE = 50
        /** `lastErrorCode` of a file that changed while it was hashed or uploaded. */
        const val SOURCE_CHANGED = "SOURCE_CHANGED"
    }
}

/** [this] with the scan row's metadata; [keepContentFields] keeps size and `dateModified` (a `REGISTERING` row). */
internal fun SyncFileEntity.withMeta(row: MediaRow, keepContentFields: Boolean = false): SyncFileEntity = copy(
    uri = row.uri,
    displayName = row.displayName,
    relativePath = row.relativePath,
    bucketId = row.bucketId,
    bucketName = row.bucketName,
    mimeType = row.mimeType,
    isVideo = row.isVideo,
    dateTaken = row.dateTakenMs,
    generationModified = row.generationModified,
    sizeBytes = if (keepContentFields) sizeBytes else row.sizeBytes,
    dateModified = if (keepContentFields) dateModified else row.dateModifiedSec,
)
