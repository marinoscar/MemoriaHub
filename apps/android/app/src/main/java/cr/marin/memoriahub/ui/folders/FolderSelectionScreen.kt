package cr.marin.memoriahub.ui.folders

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cr.marin.memoriahub.data.repo.SyncFolder

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FolderSelectionScreen(
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: FolderSelectionViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text("Synced folders") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            when {
                state.loading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                state.error != null -> Text(
                    state.error!!,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.align(Alignment.Center).padding(24.dp),
                )
                state.folders.isEmpty() -> Text(
                    "No folders with photos or videos were found on this device.",
                    textAlign = TextAlign.Center,
                    modifier = Modifier.align(Alignment.Center).padding(24.dp),
                )
                else -> FolderList(
                    folders = state.folders,
                    onToggle = viewModel::toggle,
                )
            }
        }
    }
}

@Composable
private fun FolderList(
    folders: List<SyncFolder>,
    onToggle: (String, Boolean) -> Unit,
) {
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        item {
            Text(
                "Choose which device folders are backed up. Only folders that contain " +
                    "photos or videos are shown.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.outline,
                modifier = Modifier.padding(16.dp),
            )
        }
        items(folders, key = { it.id }) { folder ->
            FolderRow(folder = folder, onToggle = onToggle)
            HorizontalDivider()
        }
    }
}

@Composable
private fun FolderRow(
    folder: SyncFolder,
    onToggle: (String, Boolean) -> Unit,
) {
    androidx.compose.foundation.layout.Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.weight(1f).padding(end = 16.dp)) {
            Text(folder.displayName, style = MaterialTheme.typography.bodyLarge)
        }
        Switch(
            checked = folder.selected,
            onCheckedChange = { onToggle(folder.id, it) },
        )
    }
}
