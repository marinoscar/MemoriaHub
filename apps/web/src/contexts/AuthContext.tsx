import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  ReactNode,
} from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api, ApiError } from '../services/api';
import { User, AuthProvider as AuthProviderType } from '../types';
import {
  useTimezoneAutoDetect,
  type TimezoneMismatch,
} from '../hooks/useTimezoneAutoDetect';

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  providers: AuthProviderType[];
  login: (provider: string) => void;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
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

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [providers, setProviders] = useState<AuthProviderType[]>([]);
  const navigate = useNavigate();
  const location = useLocation();
  const initRef = useRef(false);

  // Fetch auth providers on mount
  useEffect(() => {
    const fetchProviders = async () => {
      try {
        const response = await api.get<{ providers: AuthProviderType[] }>('/auth/providers', {
          skipAuth: true,
        });
        setProviders(response.providers);
      } catch (error) {
        console.error('Failed to fetch auth providers:', error);
      }
    };
    fetchProviders();
  }, []);

  // Check for existing session on mount (runs only once)
  useEffect(() => {
    // Skip if already initialized or on auth callback page
    // (the callback page will set the token directly from URL params)
    if (initRef.current || location.pathname === '/auth/callback') {
      setIsLoading(false);
      return;
    }
    initRef.current = true;

    const initAuth = async () => {
      try {
        // Try to refresh token (uses httpOnly cookie)
        const refreshed = await api.refreshToken();
        if (refreshed) {
          await fetchUser();
        }
      } catch (error) {
        console.error('Auth initialization failed:', error);
      } finally {
        setIsLoading(false);
      }
    };
    initAuth();
  }, [location.pathname]);

  const fetchUser = useCallback(async () => {
    try {
      const userData = await api.get<User>('/auth/me');
      setUser(userData);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setUser(null);
        api.setAccessToken(null);
      }
      throw error;
    }
  }, []);

  /**
   * Login-time time-zone detection (issue #444). Hung off the SESSION here
   * rather than off the OAuth callback page: a returning user restored from
   * the refresh cookie never passes through `/auth/callback`, so a hook there
   * would leave their zone unset until their next full OAuth round trip. This
   * effect covers both entry points, and the hook's own ref guard keeps it to
   * one evaluation per signed-in user.
   */
  const applyLocalTimezone = useCallback((timezone: string) => {
    setUser((prev) => (prev ? { ...prev, timezone } : prev));
  }, []);

  const {
    mismatch: timezoneMismatch,
    applyDetected: applyDetectedTimezone,
    dismiss: dismissTimezoneMismatch,
  } = useTimezoneAutoDetect({ user, onTimezoneApplied: applyLocalTimezone });

  const login = useCallback((provider: string) => {
    // Compute the same-site relative path to return to after OAuth
    const fromLocation = location.state?.from;
    const returnPath = fromLocation
      ? `${fromLocation.pathname}${fromLocation.search || ''}`
      : '/';

    // Keep sessionStorage as a fallback (unreliable in some in-app browsers, but harmless)
    sessionStorage.setItem('auth_return_url', returnPath);

    // Pass returnTo as a query param on the OAuth init URL — this survives the Google
    // OAuth round-trip reliably in Android Custom Tabs (sessionStorage does not).
    // Only append when returnPath is a non-root same-site relative path.
    const oauthUrl =
      returnPath !== '/' && returnPath.startsWith('/')
        ? `/api/auth/${provider}?returnTo=${encodeURIComponent(returnPath)}`
        : `/api/auth/${provider}`;

    window.location.href = oauthUrl;
  }, [location.state]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setUser(null);
      api.setAccessToken(null);
      navigate('/login');
    }
  }, [navigate]);

  const refreshUser = useCallback(async () => {
    await fetchUser();
  }, [fetchUser]);

  const value: AuthContextValue = {
    user,
    isLoading,
    isAuthenticated: !!user,
    providers,
    login,
    logout,
    refreshUser,
    timezoneMismatch,
    applyDetectedTimezone,
    dismissTimezoneMismatch,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
