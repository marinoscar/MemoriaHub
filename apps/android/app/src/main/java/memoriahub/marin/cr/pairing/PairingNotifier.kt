package memoriahub.marin.cr.pairing

/**
 * The "Pairing expired — re-pair" notification, behind an interface so the 401 reaction is
 * JVM-testable. Android implementation: [memoriahub.marin.cr.notifications.MediaSyncNotifications].
 */
interface PairingNotifier {
    fun notifyPairingExpired()
    fun cancelPairingExpired()
}
