import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
  useMemo,
} from 'react';
import { useAuth } from './AuthContext';
import { listCircles } from '../services/circles';
import { api } from '../services/api';
import type { Circle, CircleRole } from '../types/circles';

interface CircleContextValue {
  circles: Circle[];
  activeCircle: Circle | null;
  activeCircleId: string | null;
  activeCircleRole: CircleRole | null;
  loading: boolean;
  setActiveCircle: (circleId: string) => Promise<void>;
  refreshCircles: () => Promise<void>;
}

export const CircleContext = createContext<CircleContextValue | null>(null);

interface CircleProviderProps {
  children: ReactNode;
}

export function CircleProvider({ children }: CircleProviderProps) {
  const { isAuthenticated, user } = useAuth();
  const [circles, setCircles] = useState<Circle[]>([]);
  const [activeCircleId, setActiveCircleId] = useState<string | null>(null);
  const [activeCircleRole, setActiveCircleRole] = useState<CircleRole | null>(null);
  const [loading, setLoading] = useState(false);

  const refreshCircles = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      const response = await listCircles();
      setCircles(response.items);
    } catch (err) {
      console.error('Failed to load circles:', err);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) {
      setCircles([]);
      setActiveCircleId(null);
      setActiveCircleRole(null);
      return;
    }

    const init = async () => {
      setLoading(true);
      try {
        // Load circles
        const resp = await listCircles();
        setCircles(resp.items);

        // Load user settings to get persisted activeCircleId
        let settingsActiveId: string | null = null;
        try {
          const settings = await api.get<{ activeCircleId?: string | null }>('/user-settings');
          settingsActiveId = settings.activeCircleId ?? null;
        } catch {
          // ignore — fallback below
        }

        // Resolve: persisted → personal circle → first circle
        const targetId = settingsActiveId ?? null;
        const found = targetId ? resp.items.find((c) => c.id === targetId) : null;
        const personal = resp.items.find((c) => c.isPersonal);
        const resolved = found ?? personal ?? resp.items[0] ?? null;
        setActiveCircleId(resolved?.id ?? null);
      } catch (err) {
        console.error('Circle init failed:', err);
      } finally {
        setLoading(false);
      }
    };

    void init();
  }, [isAuthenticated]);

  const activeCircle = useMemo(
    () => (activeCircleId ? circles.find((c) => c.id === activeCircleId) ?? null : null),
    [activeCircleId, circles],
  );

  // Basic role inference: if ownerId === user.id → circle_admin; else null (unknown until members loaded)
  const inferredRole: CircleRole | null = useMemo(
    () =>
      activeCircle && user
        ? activeCircle.ownerId === user.id
          ? 'circle_admin'
          : null
        : null,
    [activeCircle, user],
  );

  const setActiveCircle = useCallback(async (circleId: string) => {
    setActiveCircleId(circleId);
    // Persist to user settings (fire-and-forget, no version header needed for simple patch)
    try {
      await api.patch('/user-settings', { activeCircleId: circleId });
    } catch (err) {
      console.error('Failed to persist activeCircleId:', err);
    }
  }, []);

  const value: CircleContextValue = {
    circles,
    activeCircle,
    activeCircleId,
    activeCircleRole: activeCircleRole ?? inferredRole,
    loading,
    setActiveCircle,
    refreshCircles,
  };

  return <CircleContext.Provider value={value}>{children}</CircleContext.Provider>;
}

export function useCircleContext(): CircleContextValue {
  const ctx = useContext(CircleContext);
  if (!ctx) throw new Error('useCircleContext must be used within a CircleProvider');
  return ctx;
}
