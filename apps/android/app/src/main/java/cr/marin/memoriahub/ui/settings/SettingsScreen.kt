package cr.marin.memoriahub.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun SettingsScreen(
    onOpenFolders: () -> Unit = {},
    modifier: Modifier = Modifier,
    viewModel: SettingsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        Text("Settings", style = MaterialTheme.typography.headlineSmall)

        Section("Account") {
            Text(state.displayName ?: state.email ?: "—", style = MaterialTheme.typography.bodyLarge)
            if (state.displayName != null && state.email != null) {
                Text(state.email!!, style = MaterialTheme.typography.bodySmall)
            }
            Text(
                state.serverUrl ?: "",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.outline,
                modifier = Modifier.padding(top = 4.dp),
            )
        }

        Section("Backup circle") {
            if (state.error != null) {
                Text(state.error!!, color = MaterialTheme.colorScheme.error)
            }
            state.circles.forEach { circle ->
                Row(
                    selected = circle.id == state.targetCircleId,
                    onSelect = { viewModel.selectCircle(circle.id) },
                    label = if (circle.isPersonal) "${circle.name} (personal)" else circle.name,
                )
            }
            if (state.circles.isEmpty() && !state.loading) {
                Text("No circles available", style = MaterialTheme.typography.bodySmall)
            }
        }

        Section("Backup folders") {
            androidx.compose.foundation.layout.Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onOpenFolders)
                    .padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Synced folders", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        "Choose which device folders are backed up",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.outline,
                    )
                }
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                )
            }
        }

        Button(
            onClick = viewModel::logout,
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 32.dp),
        ) {
            Text("Log out")
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Text(
        title,
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.padding(top = 24.dp, bottom = 8.dp),
    )
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) { content() }
    }
}

@Composable
private fun Row(selected: Boolean, onSelect: () -> Unit, label: String) {
    androidx.compose.foundation.layout.Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(selected = selected, onClick = onSelect)
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onSelect)
        Text(label, modifier = Modifier.padding(start = 8.dp))
    }
}
