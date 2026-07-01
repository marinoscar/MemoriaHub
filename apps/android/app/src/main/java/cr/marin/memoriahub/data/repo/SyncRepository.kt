package cr.marin.memoriahub.data.repo

import androidx.room.withTransaction
import cr.marin.memoriahub.core.storage.AppConfigStore
import cr.marin.memoriahub.core.util.TimeProvider
import cr.marin.memoriahub.data.db.AppDatabase
import cr.marin.memoriahub.data.db.StatusCount
import cr.marin.memoriahub.data.db.SyncFileDao
import cr.marin.memoriahub.data.db.SyncFileEntity
import cr.marin.memoriahub.data.db.SyncRunDao
import cr.marin.memoriahub.data.db.SyncRunEntity
import cr.marin.memoriahub.data.db.SyncStatus
import cr.marin.memoriahub.data.db.getExistingIdsChunked
import cr.marin.memoriahub.data.db.getReconcileRowsChunked
import cr.marin.memoriahub.data.media.MediaStoreScanner
import cr.marin.memoriahub.data.media.ScannedMedia
import cr.marin.memoriahub.data.media.MediaStoreScanner.Companion.CAMERA_BUCKETS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.max

@Singleton
class SyncRepository @Inject constructor(
    private val scanner: MediaStoreScanner,
    private val db: AppDatabase,
    private val syncFileDao: SyncFileDao,
    private val syncRunDao: SyncRunDao,
    private val appConfigStore: AppConfigStore,
    private val time: TimeProvider,
) {
    fun observeFiles(): Flow<List<SyncFileEntity>> = syncFileDao.observeAll()

    fun observeStatusCounts(): Flow<List<StatusCount>> = syncFileDao.observeStatusCounts()

    fun observeLatestRun(): Flow<SyncRunEntity?> = syncRunDao.observeLatest()

    fun observeByStatus(status: SyncStatus): Flow<List<SyncFileEntity>> =
        syncFileDao.observeByStatus(status)

    fun observeFailures(): Flow<List<SyncFileEntity>> = syncFileDao.observeFailures()

    /**
     * Reconciles MediaStore against the local state table — the idempotent diff that
     * guarantees completeness. New items are queued; edited items (changed size/mtime)
     * are reset and re-queued; unchanged uploaded items are left as-is (fast skip).
     *
     * @param fullScan when true, ignores the high-water mark and scans the whole bucket.
     * @return the number of items newly queued or re-queued.
     */
    suspend fun reconcile(fullScan: Boolean = false): Int = withContext(Dispatchers.IO) {
        val since = if (fullScan) 0L else appConfigStore.lastScanDateAddedSec
        val scanned = scanner.scan(appConfigStore.selectedBucketIds, sinceDateAddedSec = since)
        val now = time.nowMillis()
        var queuedCount = 0
        var maxAdded = appConfigStore.lastScanDateAddedSec

        db.withTransaction {
            // One bulk projection load replaces a point query per scanned item; only the
            // rare changed rows fetch their full entity below.
            val existingById = syncFileDao.getReconcileRowsChunked(scanned.map { it.mediaStoreId })
                .associateBy { it.mediaStoreId }

            for (item in scanned) {
                when (computeReconcileAction(item, existingById[item.mediaStoreId])) {
                    ReconcileAction.Queue -> {
                        syncFileDao.upsert(item.toQueuedEntity(appConfigStore.targetCircleId, now))
                        queuedCount++
                    }
                    ReconcileAction.Requeue -> {
                        // Content changed on device: drop prior upload identity and re-queue.
                        val existing = syncFileDao.getById(item.mediaStoreId) ?: continue
                        syncFileDao.upsert(existing.resetForRescan(item, now))
                        queuedCount++
                    }
                    ReconcileAction.RefreshMeta -> {
                        // Pure metadata refresh; preserve sync status (fast skip).
                        val existing = syncFileDao.getById(item.mediaStoreId) ?: continue
                        syncFileDao.upsert(
                            existing.copy(
                                contentUri = item.contentUri,
                                displayName = item.displayName,
                                bucketId = item.bucketId,
                                bucket = item.bucket,
                                dateTakenMs = item.dateTakenMs ?: existing.dateTakenMs,
                                updatedAt = now,
                            ),
                        )
                    }
                    ReconcileAction.Unchanged -> Unit
                }
                maxAdded = max(maxAdded, item.dateAddedSec)
            }
        }

        appConfigStore.lastScanDateAddedSec = maxAdded
        queuedCount
    }

    /** Crash recovery: return any rows left mid-flight by a killed run to the queue. */
    suspend fun resetStaleActive(): Int = withContext(Dispatchers.IO) {
        syncFileDao.resetStaleActive(time.nowMillis())
    }

    suspend fun requeueFailed(includeBlocked: Boolean): Int = withContext(Dispatchers.IO) {
        syncFileDao.requeueFailed(
            includeBlocked = includeBlocked,
            resetAttempts = includeBlocked,
            now = time.nowMillis(),
        )
    }

    suspend fun pendingWorkCount(): Int = withContext(Dispatchers.IO) {
        syncFileDao.pendingWorkCount()
    }

    /** Items currently stuck in FAILED or BLOCKED, for the issue notification. */
    suspend fun failureCount(): Int = withContext(Dispatchers.IO) {
        syncFileDao.failureCount()
    }

    /**
     * How many device items are not backed up: media added since the last scan that has
     * no state row yet, plus rows already queued/failed. Used by the backup-off reminder,
     * where reconcile doesn't run — so this is a READ-ONLY scan that must not advance
     * [AppConfigStore.lastScanDateAddedSec] (that high-water mark belongs to the engine).
     */
    suspend fun countNotBackedUp(): Int = withContext(Dispatchers.IO) {
        val scanned = scanner.scan(
            appConfigStore.selectedBucketIds,
            sinceDateAddedSec = appConfigStore.lastScanDateAddedSec,
        )
        // Items with an existing row are either done (UPLOADED/SKIPPED) or already counted
        // by pendingWorkCount below; only unseen items are new gap entries.
        val existingIds = syncFileDao.getExistingIdsChunked(scanned.map { it.mediaStoreId }).toHashSet()
        val newItems = scanned.count { it.mediaStoreId !in existingIds }
        newItems + syncFileDao.pendingWorkCount()
    }

    /**
     * Enumerate device folders that contain media, each marked selected per the user's
     * saved selection. When nothing has been configured yet (`selectedBucketIds == null`),
     * the legacy camera folders are shown pre-selected so the default matches current
     * backup behavior — without persisting anything until the user actually toggles.
     */
    suspend fun listSyncableFolders(): List<SyncFolder> = withContext(Dispatchers.IO) {
        val selection = appConfigStore.selectedBucketIds
        scanner.listBuckets().map { bucket ->
            val selected = selection?.contains(bucket.id)
                ?: (bucket.displayName in CAMERA_BUCKETS)
            SyncFolder(id = bucket.id, displayName = bucket.displayName, selected = selected)
        }
    }

    /** Remove not-yet-uploaded rows for deselected folders so they stop syncing. */
    suspend fun dropPendingForBuckets(bucketIds: List<String>): Int = withContext(Dispatchers.IO) {
        if (bucketIds.isEmpty()) 0 else syncFileDao.deletePendingByBucketIds(bucketIds)
    }
}

/** A selectable backup folder for the picker UI. */
data class SyncFolder(
    val id: String,
    val displayName: String,
    val selected: Boolean,
)

private fun ScannedMedia.toQueuedEntity(circleId: String?, now: Long): SyncFileEntity =
    SyncFileEntity(
        mediaStoreId = mediaStoreId,
        contentUri = contentUri,
        displayName = displayName,
        bucketId = bucketId,
        bucket = bucket,
        relativePath = null,
        mimeType = mimeType,
        type = type,
        sizeBytes = sizeBytes,
        mtimeMs = mtimeMs,
        dateAddedSec = dateAddedSec,
        dateTakenMs = dateTakenMs,
        circleId = circleId,
        status = SyncStatus.QUEUED,
        updatedAt = now,
    )

private fun SyncFileEntity.resetForRescan(item: ScannedMedia, now: Long): SyncFileEntity =
    copy(
        contentUri = item.contentUri,
        displayName = item.displayName,
        bucketId = item.bucketId,
        bucket = item.bucket,
        mimeType = item.mimeType,
        sizeBytes = item.sizeBytes,
        mtimeMs = item.mtimeMs,
        dateAddedSec = item.dateAddedSec,
        dateTakenMs = item.dateTakenMs,
        sha256 = null,
        status = SyncStatus.QUEUED,
        attemptCount = 0,
        lastError = null,
        mediaItemId = null,
        storageObjectId = null,
        uploadId = null,
        partProgressJson = null,
        uploadedAt = null,
        updatedAt = now,
    )
