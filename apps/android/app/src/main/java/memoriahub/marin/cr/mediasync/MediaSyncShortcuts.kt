package memoriahub.marin.cr.mediasync

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import memoriahub.marin.cr.R
import memoriahub.marin.cr.deeplink.MediaSyncAction
import memoriahub.marin.cr.deeplink.MediaSyncLinks
import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.util.Brand

/** One dynamic launcher shortcut (pure description; [MediaSyncShortcuts.publish] turns it into a ShortcutInfo). */
data class DynamicShortcut(val id: String, val shortLabel: String, val longLabel: String, val uri: String, val rank: Int)

/**
 * Dynamic long-press shortcuts (docs/specs/android-media-sync.md §12.1). The static ones
 * (Media sync, Diagnostics) are generated into res/xml/shortcuts.xml by app/build.gradle.kts.
 *
 * Published only while paired, refreshed whenever the paused state may have changed (Hub resume,
 * Start/Stop, a pause/resume deep link): "Sync now" → `?action=sync`; "Pause sync" or
 * "Resume sync" → `?action=pause|resume`.
 */
object MediaSyncShortcuts {
    const val SYNC_NOW = "sync_now"
    const val PAUSE_RESUME = "pause_resume"

    fun dynamic(paired: Boolean, paused: Boolean, scheme: String = Brand.deepLinkScheme): List<DynamicShortcut> {
        if (!paired) return emptyList()
        val toggle = if (paused) {
            DynamicShortcut(PAUSE_RESUME, "Resume sync", "Resume media sync", MediaSyncLinks.uri(action = MediaSyncAction.RESUME, scheme = scheme), 1)
        } else {
            DynamicShortcut(PAUSE_RESUME, "Pause sync", "Pause media sync", MediaSyncLinks.uri(action = MediaSyncAction.PAUSE, scheme = scheme), 1)
        }
        return listOf(
            DynamicShortcut(SYNC_NOW, "Sync now", "Sync photos now", MediaSyncLinks.uri(action = MediaSyncAction.SYNC, scheme = scheme), 0),
            toggle,
        )
    }

    /** Replaces the app's dynamic shortcuts with [shortcuts] (removes them all when empty). Never throws. */
    fun publish(context: Context, shortcuts: List<DynamicShortcut>) {
        runCatching {
            if (shortcuts.isEmpty()) {
                ShortcutManagerCompat.removeAllDynamicShortcuts(context)
                return
            }
            val icon = IconCompat.createWithResource(context, R.mipmap.ic_launcher)
            val infos = shortcuts.map { s ->
                ShortcutInfoCompat.Builder(context, s.id)
                    .setShortLabel(s.shortLabel)
                    .setLongLabel(s.longLabel)
                    .setIcon(icon)
                    .setRank(s.rank)
                    .setIntent(Intent(Intent.ACTION_VIEW, Uri.parse(s.uri)).setClass(context, MediaSyncActivity::class.java))
                    .build()
            }
            ShortcutManagerCompat.setDynamicShortcuts(context, infos)
        }.onFailure { AppLog.w("MediaSync", "shortcuts.publish failed: ${it.javaClass.simpleName}") }
    }

    fun refresh(context: Context, paired: Boolean, paused: Boolean) = publish(context, dynamic(paired, paused))
}
