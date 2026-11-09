/**
 * The active owner scope: which library the app shows (RETRO-I6, #588).
 *
 * A user sees "My library" (their personal library) plus every shared library
 * they belong to, which since RETRO-I2 are platform groups
 * (`GET /api/groups?scope=mine`). The choice is UX state, persisted in
 * `user_settings.activeOwnerScope` (`{ kind: 'me' } | { kind: 'group', groupId }`,
 * absent means `me`); it never authorizes anything, every route re-checks.
 *
 * Each scope also carries an opaque `id`, the value the pages pass around and
 * send to the API as the scope: a group's id, or the personal library's id
 * (`GET /api/users/me/library`). `services/ownerScopeParams.ts` turns it into
 * `ownerGroupId` / `scope=me` on the wire; arming that rewrite is this
 * provider's job.
 *
 * COMPATIBILITY. The ~50 pages written against the former `CircleContext` read
 * `activeCircleId`, `activeCircleRole`, `circles` and `setActiveCircle`. The
 * same value carries those fields, derived from the scopes (a personal library
 * reads as `isPersonal`, a group role maps `admin` -> `circle_admin`,
 * `editor` -> `collaborator`, `viewer` -> `viewer`), so the pages keep working
 * unchanged; new code reads `scopes` / `activeScope` / `activeRole`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from './AuthContext';
import { api } from '../services/api';
import { armOwnerScopeParams, disarmOwnerScopeParams } from '../services/ownerScopeParams';
import type { Circle, CircleRole } from '../types/circles';

/** The persisted choice. */
export type OwnerScope = { kind: 'me' } | { kind: 'group'; groupId: string };

/** The caller's role in a scope (the platform group roles; `admin` on their own library). */
export type OwnerRole = 'viewer' | 'editor' | 'admin';

/** One library the switcher lists. */
export interface OwnerScopeOption {
  /** The scope id the pages pass to the API (a group id, or the personal library's id). */
  id: string;
  kind: 'me' | 'group';
  name: string;
  description: string | null;
  /** The caller's role; `admin` on their own library. */
  role: OwnerRole | null;
}

/** The label of the personal library. */
export const MY_LIBRARY_NAME = 'My library';

/** Group role to the legacy per-circle role the pages still branch on. */
export const OWNER_ROLE_TO_CIRCLE_ROLE: Readonly<Record<OwnerRole, CircleRole>> = Object.freeze({
  admin: 'circle_admin',
  editor: 'collaborator',
  viewer: 'viewer',
});

export interface OwnerScopeContextValue {
  /** "My library" first (when the account has one), then the caller's groups by name. */
  scopes: OwnerScopeOption[];
  /** The selected scope (resolved: a group the caller left falls back to `me`). */
  activeScope: OwnerScope;
  /** The selected scope's option, or null before the scopes load. */
  activeOption: OwnerScopeOption | null;
  /** The caller's role in the selected scope. */
  activeRole: OwnerRole | null;
  /** The personal library's scope id, or null (not loaded, or none). */
  personalLibraryId: string | null;
  /** Select a scope and persist it. */
  setActiveScope: (scope: OwnerScope) => Promise<void>;
  /** Reload the scopes (after creating, leaving or renaming a group). */
  refreshScopes: () => Promise<void>;

  // --- Legacy (`CircleContext`) fields, derived from the scopes ---------------
  /** @deprecated read `scopes`. */
  circles: Circle[];
  /** @deprecated read `activeOption`. */
  activeCircle: Circle | null;
  /** @deprecated read `activeOption.id`. The opaque scope id. */
  activeCircleId: string | null;
  /** @deprecated read `activeRole`. */
  activeCircleRole: CircleRole | null;
  loading: boolean;
  /** @deprecated call `setActiveScope`. Selects a scope by its id. */
  setActiveCircle: (scopeId: string) => Promise<void>;
  /** @deprecated call `refreshScopes`. */
  refreshCircles: () => Promise<void>;
}

export const OwnerScopeContext = createContext<OwnerScopeContextValue | null>(null);

interface GroupListItem {
  id: string;
  name: string;
  description: string | null;
  myRole: string | null;
  createdAt?: string;
  updatedAt?: string;
}

function asOwnerRole(role: string | null | undefined): OwnerRole | null {
  return role === 'admin' || role === 'editor' || role === 'viewer' ? role : null;
}

/** Reads a stored `activeOwnerScope` defensively (a malformed value is "no choice"). */
export function parseStoredOwnerScope(value: unknown): OwnerScope | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { kind?: unknown; groupId?: unknown };
  if (v.kind === 'me') return { kind: 'me' };
  if (v.kind === 'group' && typeof v.groupId === 'string' && v.groupId) return { kind: 'group', groupId: v.groupId };
  return null;
}

/**
 * The scope to show: the stored one when it is still listed, else "My
 * library", else the first group (an account without a personal library).
 */
export function resolveOwnerScope(stored: OwnerScope | null, scopes: readonly OwnerScopeOption[]): OwnerScope {
  if (stored?.kind === 'group' && scopes.some((s) => s.kind === 'group' && s.id === stored.groupId)) return stored;
  if (scopes.some((s) => s.kind === 'me')) return { kind: 'me' };
  const firstGroup = scopes.find((s) => s.kind === 'group');
  return firstGroup ? { kind: 'group', groupId: firstGroup.id } : { kind: 'me' };
}

function optionFor(scope: OwnerScope, scopes: readonly OwnerScopeOption[]): OwnerScopeOption | null {
  if (scope.kind === 'me') return scopes.find((s) => s.kind === 'me') ?? null;
  return scopes.find((s) => s.kind === 'group' && s.id === scope.groupId) ?? null;
}

function toLegacyCircle(option: OwnerScopeOption, userId: string | undefined): Circle {
  return {
    id: option.id,
    name: option.name,
    description: option.description,
    ownerId: option.kind === 'me' ? userId ?? '' : '',
    isPersonal: option.kind === 'me',
    createdAt: '',
    updatedAt: '',
    ...(option.role ? { memberRole: OWNER_ROLE_TO_CIRCLE_ROLE[option.role] } : {}),
  };
}

async function loadScopes(): Promise<OwnerScopeOption[]> {
  const [library, groups] = await Promise.all([
    api.get<{ id: string | null; name?: string }>('/users/me/library').catch(() => null),
    api.get<{ items?: GroupListItem[] }>('/groups?scope=mine&pageSize=100').catch(() => null),
  ]);
  const scopes: OwnerScopeOption[] = [];
  if (library?.id) {
    scopes.push({ id: library.id, kind: 'me', name: MY_LIBRARY_NAME, description: null, role: 'admin' });
  }
  const items = [...(groups?.items ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  for (const g of items) {
    scopes.push({ id: g.id, kind: 'group', name: g.name, description: g.description ?? null, role: asOwnerRole(g.myRole) });
  }
  // Arm the wire rewrite (`circleId` -> `ownerGroupId` / `scope=me`).
  armOwnerScopeParams(library?.id ?? null);
  return scopes;
}

export function OwnerScopeProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useAuth();
  const [scopes, setScopes] = useState<OwnerScopeOption[]>([]);
  const [stored, setStored] = useState<OwnerScope | null>(null);
  const [loading, setLoading] = useState(false);

  const refreshScopes = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoading(true);
    try {
      setScopes(await loadScopes());
    } catch (err) {
      console.error('Failed to load libraries:', err);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) {
      setScopes([]);
      setStored(null);
      disarmOwnerScopeParams();
      return;
    }
    let cancelled = false;
    const init = async () => {
      setLoading(true);
      try {
        const [loaded, settings] = await Promise.all([
          loadScopes(),
          api.get<{ activeOwnerScope?: unknown }>('/user-settings').catch(() => null),
        ]);
        if (cancelled) return;
        setScopes(loaded);
        setStored(parseStoredOwnerScope(settings?.activeOwnerScope));
      } catch (err) {
        console.error('Owner scope init failed:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void init();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  const activeScope = useMemo(() => resolveOwnerScope(stored, scopes), [stored, scopes]);
  const activeOption = useMemo(() => optionFor(activeScope, scopes), [activeScope, scopes]);

  const setActiveScope = useCallback(async (scope: OwnerScope) => {
    setStored(scope);
    try {
      await api.patch('/user-settings', { activeOwnerScope: scope });
    } catch (err) {
      console.error('Failed to persist activeOwnerScope:', err);
    }
  }, []);

  const setActiveCircle = useCallback(
    async (scopeId: string) => {
      const option = scopes.find((s) => s.id === scopeId);
      if (!option) return;
      await setActiveScope(option.kind === 'me' ? { kind: 'me' } : { kind: 'group', groupId: option.id });
    },
    [scopes, setActiveScope],
  );

  const circles = useMemo(() => scopes.map((s) => toLegacyCircle(s, user?.id)), [scopes, user?.id]);
  const activeCircle = useMemo(
    () => (activeOption ? circles.find((c) => c.id === activeOption.id) ?? null : null),
    [activeOption, circles],
  );
  const activeRole = activeOption?.role ?? null;

  const value: OwnerScopeContextValue = {
    scopes,
    activeScope,
    activeOption,
    activeRole,
    personalLibraryId: scopes.find((s) => s.kind === 'me')?.id ?? null,
    setActiveScope,
    refreshScopes,
    circles,
    activeCircle,
    activeCircleId: activeOption?.id ?? null,
    activeCircleRole: activeRole ? OWNER_ROLE_TO_CIRCLE_ROLE[activeRole] : null,
    loading,
    setActiveCircle,
    refreshCircles: refreshScopes,
  };

  return <OwnerScopeContext.Provider value={value}>{children}</OwnerScopeContext.Provider>;
}

export function useOwnerScope(): OwnerScopeContextValue {
  const ctx = useContext(OwnerScopeContext);
  if (!ctx) throw new Error('useOwnerScope must be used within an OwnerScopeProvider');
  return ctx;
}
