package cr.marin.memoriahub.ui.photos

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudDone
import androidx.compose.material.icons.filled.CloudQueue
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import cr.marin.memoriahub.data.db.SyncStatus
import cr.marin.memoriahub.ui.theme.FailedRed
import cr.marin.memoriahub.ui.theme.PendingAmber
import cr.marin.memoriahub.ui.theme.SyncedGreen

@Composable
fun PhotosScreen(
    modifier: Modifier = Modifier,
    viewModel: PhotosViewModel = hiltViewModel(),
) {
    val sections by viewModel.sections.collectAsStateWithLifecycle()

    if (sections.isEmpty()) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No camera photos found yet", style = MaterialTheme.typography.bodyMedium)
        }
        return
    }

    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 112.dp),
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(2.dp),
    ) {
        sections.forEach { section ->
            item(span = { GridItemSpan(maxLineSpan) }) {
                Text(
                    text = section.label,
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.surface)
                        .padding(horizontal = 6.dp, vertical = 10.dp),
                )
            }
            items(section.items, key = { it.mediaStoreId }) { photo ->
                PhotoTile(photo)
            }
        }
    }
}

@Composable
private fun PhotoTile(photo: PhotoUiModel) {
    Box(
        modifier = Modifier
            .padding(1.dp)
            .aspectRatio(1f)
            .background(MaterialTheme.colorScheme.surfaceVariant),
    ) {
        AsyncImage(
            model = photo.contentUri,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
        )
        if (photo.isVideo) {
            Icon(
                imageVector = Icons.Filled.PlayCircle,
                contentDescription = "Video",
                tint = Color.White,
                modifier = Modifier
                    .align(Alignment.Center)
                    .size(28.dp),
            )
        }
        StatusBadge(
            status = photo.status,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(3.dp),
        )
    }
}

@Composable
private fun StatusBadge(status: SyncStatus, modifier: Modifier = Modifier) {
    val (icon, tint) = status.badge()
    Box(
        modifier = modifier
            .size(18.dp)
            .background(Color.Black.copy(alpha = 0.35f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = status.name,
            tint = tint,
            modifier = Modifier.size(13.dp),
        )
    }
}

private fun SyncStatus.badge(): Pair<ImageVector, Color> = when (this) {
    SyncStatus.UPLOADED, SyncStatus.SKIPPED -> Icons.Filled.CloudDone to SyncedGreen
    SyncStatus.QUEUED -> Icons.Filled.CloudQueue to Color.White
    SyncStatus.HASHING, SyncStatus.UPLOADING -> Icons.Filled.CloudUpload to PendingAmber
    SyncStatus.FAILED, SyncStatus.BLOCKED -> Icons.Filled.ErrorOutline to FailedRed
}
