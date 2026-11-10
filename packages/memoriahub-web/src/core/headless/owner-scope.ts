// The owner-scope shapes a slice reads (RETRO-I6 #588). The app's provider
// builds the value; the shapes are declared here so a slice needs no app import.

/**
 * The persisted owner-scope choice: "My library" or one group.
 *
 * @stability experimental
 */
export type MemoriahubOwnerScope = { kind: 'me' } | { kind: 'group'; groupId: string };

/**
 * The caller's role in a scope (the platform group roles; `admin` on their own library).
 *
 * @stability experimental
 */
export type MemoriahubOwnerRole = 'viewer' | 'editor' | 'admin';

/**
 * The legacy per-circle role the pages still branch on.
 *
 * @stability experimental
 */
export type MemoriahubCircleRole = 'circle_admin' | 'collaborator' | 'viewer';

/**
 * One library the switcher lists.
 *
 * @stability experimental
 */
export interface MemoriahubOwnerScopeOption {
  /** The scope id the pages pass to the API (a group id, or the personal library's id). */
  id: string;
  /** `me` for the personal library. */
  kind: 'me' | 'group';
  /** The display name. */
  name: string;
  /** The description, if any. */
  description: string | null;
  /** The caller's role; `admin` on their own library. */
  role: MemoriahubOwnerRole | null;
}

/**
 * A library as the pages written against the former circle model read it.
 *
 * @stability experimental
 */
export interface MemoriahubCircle {
  /** The scope id. */
  id: string;
  /** The display name. */
  name: string;
  /** The description, if any. */
  description: string | null;
  /** The owner's user id. */
  ownerId: string;
  /** True for the personal library. */
  isPersonal: boolean;
  /** ISO creation time. */
  createdAt: string;
  /** ISO update time. */
  updatedAt: string;
  /** The caller's role, when the source carries it. */
  memberRole?: MemoriahubCircleRole;
}

/**
 * The active owner scope as a slice reads it: the new fields plus the legacy
 * `circle` fields the ~50 pages written against the former `CircleContext` use.
 *
 * @stability experimental
 */
export interface MemoriahubOwnerScopeValue {
  /** "My library" first, then the caller's groups by name. */
  scopes: MemoriahubOwnerScopeOption[];
  /** The selected scope. */
  activeScope: MemoriahubOwnerScope;
  /** The selected scope's option, `null` before the scopes load. */
  activeOption: MemoriahubOwnerScopeOption | null;
  /** The caller's role in the selected scope. */
  activeRole: MemoriahubOwnerRole | null;
  /** The personal library's scope id, or `null`. */
  personalLibraryId: string | null;
  /** Select a scope and persist it. */
  setActiveScope: (scope: MemoriahubOwnerScope) => Promise<void>;
  /** Reload the scopes. */
  refreshScopes: () => Promise<void>;
  /** @deprecated read `scopes`. */
  circles: MemoriahubCircle[];
  /** @deprecated read `activeOption`. */
  activeCircle: MemoriahubCircle | null;
  /** @deprecated read `activeOption.id`. The opaque scope id. */
  activeCircleId: string | null;
  /** @deprecated read `activeRole`. */
  activeCircleRole: MemoriahubCircleRole | null;
  /** True while the scopes load. */
  loading: boolean;
  /** @deprecated call `setActiveScope`. Selects a scope by its id. */
  setActiveCircle: (scopeId: string) => Promise<void>;
  /** @deprecated call `refreshScopes`. */
  refreshCircles: () => Promise<void>;
}
