package cr.marin.memoriahub.ui.main

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cr.marin.memoriahub.core.storage.AppConfigStore
import cr.marin.memoriahub.sync.BackupController
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject

@HiltViewModel
class BackupBannerViewModel @Inject constructor(
    appConfigStore: AppConfigStore,
    private val backupController: BackupController,
) : ViewModel() {
    val backupEnabled: StateFlow<Boolean> = appConfigStore.backupEnabledFlow

    fun turnOn() = backupController.turnOn()
}

/**
 * Persistent "Backup is off" banner shown above every tab while backup is
 * disabled, so the paused state is unmissable and one tap away from fixing.
 */
@Composable
fun BackupOffBanner(
    modifier: Modifier = Modifier,
    viewModel: BackupBannerViewModel = hiltViewModel(),
) {
    val backupEnabled by viewModel.backupEnabled.collectAsStateWithLifecycle()
    if (backupEnabled) return

    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
            contentColor = MaterialTheme.colorScheme.onErrorContainer,
        ),
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Filled.CloudOff,
                contentDescription = null,
                modifier = Modifier.padding(end = 12.dp),
            )
            Column(modifier = Modifier.weight(1f)) {
                Text("Backup is off", style = MaterialTheme.typography.titleSmall)
                Text(
                    "New photos and videos on this device aren't being backed up.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            FilledTonalButton(
                onClick = viewModel::turnOn,
                modifier = Modifier.padding(start = 12.dp),
            ) {
                Text("Turn on")
            }
        }
    }
}
