package cr.marin.memoriahub.ui.status

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cr.marin.memoriahub.data.db.SyncFileEntity

@Composable
fun SyncStatusScreen(
    modifier: Modifier = Modifier,
    viewModel: SyncStatusViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Column(modifier = modifier.fillMaxSize().padding(16.dp)) {
        Text("Backup status", style = MaterialTheme.typography.headlineSmall)

        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            StatCard("Synced", state.synced)
            StatCard("Syncing", state.syncing)
            StatCard("Pending", state.pending)
            StatCard("Failed", state.failed)
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (state.backupEnabled) {
                Button(onClick = viewModel::syncNow, modifier = Modifier.weight(1f)) {
                    Text("Sync now")
                }
            } else {
                // Notification taps land here; give them a direct fix-it action.
                Button(onClick = viewModel::turnOnBackup, modifier = Modifier.weight(1f)) {
                    Text("Turn on backup")
                }
            }
            OutlinedButton(
                onClick = viewModel::retryFailed,
                enabled = state.backupEnabled && state.failed > 0,
                modifier = Modifier.weight(1f),
            ) {
                Text("Retry failed")
            }
        }

        if (state.failures.isNotEmpty()) {
            Text(
                "Failures",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(top = 24.dp, bottom = 8.dp),
            )
            LazyColumn(modifier = Modifier.fillMaxWidth()) {
                items(state.failures, key = { it.mediaStoreId }) { item ->
                    FailureRow(item)
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun StatCard(label: String, value: Int) {
    Card(modifier = Modifier.padding(horizontal = 2.dp)) {
        Column(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally,
        ) {
            Text(value.toString(), style = MaterialTheme.typography.titleLarge)
            Text(label, style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun FailureRow(item: SyncFileEntity) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Text(
            item.displayName,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            item.lastError ?: "Unknown error",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
