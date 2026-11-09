/**
 * Owner-scope request parameters on the wire (RETRO-I6, #588).
 *
 * The app's pages still name the library they work in as `circleId` (the
 * opaque scope id every page passes around: a group id, or the personal
 * library's id). Since RETRO-I3 the API takes the scope as
 *
 *   ownerGroupId=<group id>   a shared library (a platform group), or
 *   scope=me                  the caller's personal library,
 *
 * and keeps `circleId` only as a deprecated alias. This module rewrites the
 * legacy name at the ONE place every request passes through (`services/api.ts`),
 * so no page sends `circleId` and the alias can be retired without touching
 * the ~50 pages that read the active scope.
 *
 * The rewrite is armed by `OwnerScopeProvider` once it knows the caller's
 * personal library id (`GET /api/users/me/library`); before that (and in a
 * unit test that never mounts the provider) requests go out unchanged, which
 * the API still accepts. A request that already carries its own `scope`
 * parameter (e.g. `scope=mine|all`) keeps `circleId`, so nothing is clobbered,
 * and the platform's own routes are never touched.
 */

/** Paths the API never rewrites either (`owner-scope-params.ts`): the platform slices' own. */
const UNTOUCHED_PREFIXES = ['/groups', '/grants', '/sharing', '/public', '/auth'];

let personalLibraryId: string | null = null;
let armed = false;

/** Arms the rewrite with the caller's personal library id (null: no personal library). */
export function armOwnerScopeParams(personalId: string | null): void {
  personalLibraryId = personalId;
  armed = true;
}

/** Disarms it (sign-out). */
export function disarmOwnerScopeParams(): void {
  personalLibraryId = null;
  armed = false;
}

function untouched(path: string): boolean {
  return UNTOUCHED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** The new-form parameter for one legacy scope id. */
function ownerParam(scopeId: string): ['scope', 'me'] | ['ownerGroupId', string] {
  return scopeId === personalLibraryId ? ['scope', 'me'] : ['ownerGroupId', scopeId];
}

/** Rewrites `circleId` in an endpoint's query string. */
export function rewriteEndpoint(endpoint: string): string {
  if (!armed) return endpoint;
  const q = endpoint.indexOf('?');
  if (q < 0) return endpoint;
  const path = endpoint.slice(0, q);
  if (untouched(path)) return endpoint;
  const params = new URLSearchParams(endpoint.slice(q + 1));
  const circleId = params.get('circleId');
  if (!circleId || params.has('scope') || params.has('ownerGroupId')) return endpoint;
  const [key, value] = ownerParam(circleId);
  const next = new URLSearchParams();
  params.forEach((v, k) => {
    if (k === 'circleId') next.append(key, value);
    else next.append(k, v);
  });
  return `${path}?${next.toString()}`;
}

/** Rewrites a top-level `circleId` in a JSON body (a new object; the caller's is untouched). */
export function rewriteBody(endpoint: string, body: unknown): unknown {
  if (!armed || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (untouched(endpoint.split('?')[0])) return body;
  const record = body as Record<string, unknown>;
  const circleId = record.circleId;
  if (typeof circleId !== 'string' || circleId.length === 0) return body;
  if ('scope' in record || 'ownerGroupId' in record) return body;
  const [key, value] = ownerParam(circleId);
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === 'circleId') next[key] = value;
    else next[k] = v;
  }
  return next;
}
