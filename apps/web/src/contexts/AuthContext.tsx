import { createContext, useCallback, useContext, useMemo, useState, ReactNode } from 'react';
import {
  AuthProvider as IdentityAuthProvider,
  useAuth as useIdentityAuth,
  userExtension,
  type AuthContextValue as IdentityAuthContextValue,
} from '@marinoscar/platform-web/identity/headless';
import { api } from '../services/api';
import { removePushSubscription } from '@marinoscar/platform-web/notifications/headless';
import { User } from '../types';
import {
  useTimezoneAutoDetect,
  type TimezoneMismatch,
} from '../hooks/useTimezoneAutoDetect';

// =============================================================================
// The app's view of the session (RETRO-B2, issue #611)
// =============================================================================
//
// The session itself (the boot-time refresh from the HttpOnly cookie, `GET
// /auth/me`, the provider list, sign-in redirect with `returnTo`, sign-out, the
// "session expired" signal) is the identity slice's `AuthProvider`
// (`@marinoscar/platform-web/identity/headless`). This file adds the one thing
// MemoriaHub keeps on top of it: the per-user IANA time zone (issue #444).
//
// The API puts the RAW stored zone under `extensions.memoriahub.timezone` of
// `GET /api/auth/me` (it was a top-level `timezone` field before the identity
// slice). `useAuth()` here returns the platform's value with `user` widened to
// the app's `User` (the zone as `user.timezone`) and the detection state, so the
// ~20 components that read `user.timezone` or the mismatch prompt are unchanged.

interface AuthContextValue extends Omit<IdentityAuthContextValue, 'user'> {
  user: User | null;
  /**
   * Set when the browser's time zone disagrees with the stored one (issue
   * #444). Rendered by `TimezonePrompt` inside `Layout` — the state lives here
   * because detection must run once per SESSION, and this provider is the only
   * thing in the tree that mounts exactly that often.
   */
  timezoneMismatch: TimezoneMismatch | null;
  /** Accept the browser's time zone. */
  applyDetectedTimezone: () => Promise<void>;
  /** Keep the stored time zone; do not ask again this session. */
  dismissTimezoneMismatch: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

/** The session, the identity slice's, with the app's time-zone detection around the routes. */
export function AuthProvider({ children }: AuthProviderProps) {
  return (
    // Stop this device receiving the signed-out account's Web Pushes (issue #486).
    // Needs the still-valid token, so it runs BEFORE the logout call; never
    // throws and gives up after 3s, so it cannot hold logout hostage.
    <IdentityAuthProvider client={api} onBeforeLogout={removePushSubscription}>
      <TimezoneBridge>{children}</TimezoneBridge>
    </IdentityAuthProvider>
  );
}

function TimezoneBridge({ children }: AuthProviderProps) {
  const identity = useIdentityAuth();
  // A zone applied this session, kept locally so a remount does not PATCH twice.
  const [appliedTimezone, setAppliedTimezone] = useState<string | null>(null);

  const stored = userExtension<{ timezone?: string | null }>(identity.user ?? undefined, 'memoriahub')?.timezone ?? null;
  const user = useMemo<User | null>(
    () =>
      identity.user
        ? ({ ...identity.user, timezone: appliedTimezone ?? stored } as unknown as User)
        : null,
    [identity.user, appliedTimezone, stored],
  );

  const applyLocalTimezone = useCallback((timezone: string) => setAppliedTimezone(timezone), []);

  /**
   * Login-time time-zone detection (issue #444). Hung off the SESSION here
   * rather than off the OAuth callback page: a returning user restored from
   * the refresh cookie never passes through `/auth/callback`, so a hook there
   * would leave their zone unset until their next full OAuth round trip.
   */
  const {
    mismatch: timezoneMismatch,
    applyDetected: applyDetectedTimezone,
    dismiss: dismissTimezoneMismatch,
  } = useTimezoneAutoDetect({ user, onTimezoneApplied: applyLocalTimezone });

  const value: AuthContextValue = {
    ...identity,
    user,
    timezoneMismatch,
    applyDetectedTimezone,
    dismissTimezoneMismatch,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
