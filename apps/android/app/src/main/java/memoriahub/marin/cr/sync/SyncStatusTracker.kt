package memoriahub.marin.cr.sync

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import memoriahub.marin.cr.contract.SyncStatusView
import memoriahub.marin.cr.upload.UploadProgress

/**
 * The live [SyncStatusView] behind `SyncControl.status` (the Hub, #513) and the "Upload progress"
 * notification. The worker reports into it; the last run and check-in times are seeded from (and
 * persisted in) the [SyncStateStore], so a fresh process shows the right "last synced".
 */
class SyncStatusTracker(private val store: SyncStateStore) {
    private val _status = MutableStateFlow(fromStore(running = false))
    val status: StateFlow<SyncStatusView> = _status.asStateFlow()

    fun runStarted() {
        _status.value = fromStore(running = true)
    }

    fun progress(progress: UploadProgress?) {
        if (progress == null) return
        _status.update {
            it.copy(
                running = true,
                currentFile = progress.fileName,
                bytesSent = progress.bytesSent,
                bytesTotal = progress.bytesTotal,
                filesDone = progress.filesDone,
                filesTotal = progress.filesTotal,
            )
        }
    }

    fun runFinished(record: SyncRunRecord?) {
        if (record != null) store.lastRun = LastRun(record.finishedAtMs, record.status, record.errorCode)
        _status.value = fromStore(running = false)
    }

    /** Re-reads the persisted fields (after a check-in or a pairing change). */
    fun refresh() {
        _status.update { fromStore(running = it.running).copy(
            currentFile = it.currentFile, bytesSent = it.bytesSent, bytesTotal = it.bytesTotal,
            filesDone = it.filesDone, filesTotal = it.filesTotal,
        ) }
    }

    private fun fromStore(running: Boolean): SyncStatusView {
        val last = store.lastRun
        return SyncStatusView(
            running = running,
            currentFile = null,
            bytesSent = 0,
            bytesTotal = 0,
            filesDone = 0,
            filesTotal = 0,
            lastRunAtMs = last?.atMs,
            lastRunStatus = last?.status,
            lastError = last?.error,
            lastCheckinAtMs = store.lastCheckinAtMs,
        )
    }
}
