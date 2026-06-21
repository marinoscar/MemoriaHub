package cr.marin.memoriahub.core.auth

/** Coarse auth state used to gate navigation between the auth and main flows. */
enum class AuthState {
    LoggedOut,
    LoggedIn,
}
