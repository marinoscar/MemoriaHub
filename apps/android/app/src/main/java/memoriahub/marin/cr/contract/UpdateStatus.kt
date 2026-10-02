// file: contract/UpdateStatus.kt   (implemented by #514 as update/UpdateChecker)
package memoriahub.marin.cr.contract

import kotlinx.coroutines.flow.StateFlow

data class AvailableUpdate(val releaseId: String, val versionName: String, val versionCode: Long, val sizeBytes: Long, val notes: String?)

interface UpdateStatus {
    val available: StateFlow<AvailableUpdate?>
    suspend fun checkNow(force: Boolean = false)
    /** Fetch a download link and open it in the browser (system installer). */
    suspend fun openDownload(): Result<Unit>
}
