package cr.marin.memoriahub.ui.photos

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cr.marin.memoriahub.data.db.MediaType
import cr.marin.memoriahub.data.db.SyncFileEntity
import cr.marin.memoriahub.data.db.SyncStatus
import cr.marin.memoriahub.data.repo.SyncRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import javax.inject.Inject

data class PhotoUiModel(
    val mediaStoreId: Long,
    val contentUri: String,
    val isVideo: Boolean,
    val status: SyncStatus,
    val captureMillis: Long,
)

data class PhotoSection(
    val label: String,
    val items: List<PhotoUiModel>,
)

@HiltViewModel
class PhotosViewModel @Inject constructor(
    private val syncRepository: SyncRepository,
) : ViewModel() {

    init {
        // Populate the grid immediately from MediaStore (cheap; no upload).
        viewModelScope.launch { runCatching { syncRepository.reconcile() } }
    }

    val sections: StateFlow<List<PhotoSection>> =
        syncRepository.observeFiles()
            .map { entities -> entities.toSections() }
            .stateIn(
                scope = viewModelScope,
                started = SharingStarted.WhileSubscribed(5_000),
                initialValue = emptyList(),
            )

    private fun SyncFileEntity.captureMillis(): Long = dateTakenMs ?: dateAddedSec * 1000L

    private fun List<SyncFileEntity>.toSections(): List<PhotoSection> {
        // The device zone is CORRECT here and must not be changed to UTC.
        //
        // This screen groups the phone's own MediaStore rows, not server DTOs.
        // `dateTakenMs` is MediaStore DATE_TAKEN — a real epoch-millis INSTANT,
        // not the civil timestamp the API stores in `capturedAt` (see
        // docs/specs/date-model.md, epic #440). Rendering that instant in the
        // device zone recovers the wall clock at capture, which is the same
        // value ingest will later store as a civil timestamp, so this grouping
        // already agrees with the server's. Pinning it to UTC would introduce
        // exactly the offset the epic exists to remove.
        //
        // Residual gap: MediaStore exposes no capture offset, so a photo taken
        // abroad regroups if the device zone changes. The device zone is the
        // best proxy available and is right in the common case.
        val zone = ZoneId.systemDefault()
        return asSequence()
            .map { entity ->
                PhotoUiModel(
                    mediaStoreId = entity.mediaStoreId,
                    contentUri = entity.contentUri,
                    isVideo = entity.type == MediaType.VIDEO,
                    status = entity.status,
                    captureMillis = entity.captureMillis(),
                )
            }
            .sortedByDescending { it.captureMillis }
            .groupBy { Instant.ofEpochMilli(it.captureMillis).atZone(zone).toLocalDate() }
            .map { (date, items) -> PhotoSection(date.toLabel(), items) }
    }

    private fun LocalDate.toLabel(): String = when (this) {
        LocalDate.now() -> "Today"
        LocalDate.now().minusDays(1) -> "Yesterday"
        else -> format(DATE_FORMAT)
    }

    private companion object {
        val DATE_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("MMMM d, yyyy")
    }
}
