package memoriahub.marin.cr.mediasync

import memoriahub.marin.cr.contract.SyncControl
import memoriahub.marin.cr.deeplink.MediaSyncAction
import memoriahub.marin.cr.deeplink.MediaSyncPath
import memoriahub.marin.cr.deeplink.MediaSyncRoute
import memoriahub.marin.cr.diagnostics.AppLog

/** What running a `?action=` (or a Hub button doing the same) produced: a snackbar message. */
data class ActionOutcome(val action: MediaSyncAction, val ok: Boolean, val message: String)

/** The Media Sync screens of the in-memory screen enum (no NavHost, same as evopath). */
enum class MediaSyncScreen(val title: String) {
    Hub("Media sync"),
    Connect("Connect"),
    Folders("Folders"),
    Network("Network & power"),
    Files("Files"),
    Diagnostics("Diagnostics"),
    ;

    companion object {
        /** The screen a deep-link path (or `EXTRA_OPEN`) opens; `/paired` is the Hub after pairing. */
        fun of(path: MediaSyncPath): MediaSyncScreen = when (path) {
            MediaSyncPath.HUB, MediaSyncPath.PAIRED -> Hub
            MediaSyncPath.CONNECT -> Connect
            MediaSyncPath.FOLDERS -> Folders
            MediaSyncPath.NETWORK -> Network
            MediaSyncPath.FILES -> Files
            MediaSyncPath.DIAGNOSTICS -> Diagnostics
        }

        /** Restores a saved screen name, defaulting to the Hub. */
        fun named(name: String?): MediaSyncScreen = entries.firstOrNull { it.name == name } ?: Hub
    }
}

/** Where an incoming intent lands: the screen, plus the action to run once it is shown. */
data class RouteTarget(val screen: MediaSyncScreen, val action: MediaSyncAction?, val pokePairing: Boolean)

/**
 * The deep-link `?action=` table of docs/specs/android-media-sync.md §12.2, over [SyncControl]
 * (#512). Pure apart from the control it is handed (JVM-tested with a fake).
 *
 * | Action  | Effect |
 * |---------|--------|
 * | apply   | immediate check-in (applies the desired config), "Settings applied" |
 * | sync    | `syncNow()` |
 * | retry   | `retryFailed()` then `syncNow()` |
 * | pause   | `setPaused(true)` |
 * | resume  | `setPaused(false)` (the control then runs "now") |
 */
object MediaSyncActions {
    fun target(route: MediaSyncRoute): RouteTarget =
        RouteTarget(MediaSyncScreen.of(route.path), route.action, route.isPairingReturn)

    suspend fun run(action: MediaSyncAction, paired: Boolean, control: SyncControl): ActionOutcome {
        if (!paired) return ActionOutcome(action, ok = false, message = "Pair this phone first.")
        AppLog.i(TAG, "action ${action.value}")
        return when (action) {
            MediaSyncAction.APPLY -> outcome(action, control.checkinNow(), "Settings applied", "Could not apply the settings")
            MediaSyncAction.SYNC -> {
                control.syncNow()
                ActionOutcome(action, ok = true, message = "Sync started")
            }
            MediaSyncAction.RETRY -> {
                val result = control.retryFailed()
                if (result.isSuccess) control.syncNow()
                outcome(action, result, "Retrying failed files", "Could not retry the failed files")
            }
            MediaSyncAction.PAUSE -> outcome(action, control.setPaused(true), "Sync paused", "Could not pause sync")
            MediaSyncAction.RESUME -> outcome(action, control.setPaused(false), "Sync resumed", "Could not resume sync")
        }
    }

    private fun outcome(action: MediaSyncAction, result: Result<Unit>, ok: String, failed: String): ActionOutcome =
        result.fold(
            onSuccess = { ActionOutcome(action, ok = true, message = ok) },
            onFailure = { e ->
                AppLog.w(TAG, "action ${action.value} failed: ${e.javaClass.simpleName}")
                ActionOutcome(action, ok = false, message = listOfNotNull(failed, e.message?.takeIf { it.isNotBlank() }).joinToString(": "))
            },
        )

    private const val TAG = "MediaSync"
}
