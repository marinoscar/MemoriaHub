// =============================================================================
// Owner-scope request parameters (RETRO-I3, #573)
// =============================================================================
//
// Every MemoriaHub route that works inside one owner scope names it with
// `circleId` (query or body). Since RETRO-I3 a client names it instead with
//
//   ownerGroupId=<group id>   a shared library (a former shared circle: the
//                             group id IS the former circle id, decision 1)
//   scope=me                  the caller's own personal library
//
// and `circleId` stays accepted, DEPRECATED, for one release (the CLI and the
// Android app send it until RETRO-I6). The routes' DTOs and services keep
// reading `circleId`: `OwnerScopeParamsInterceptor` (global, after the guards,
// BEFORE the validation pipe) rewrites the two new forms into it, so every
// route takes them with no per-DTO change, and `applyOwnerScopeParams` (an
// OpenAPI document pass) documents them on every operation that has a
// `circleId`.
//
// Rules (both query and JSON body):
//   - `ownerGroupId` -> `circleId`; both given and different -> 400;
//   - `scope=me` -> `circleId` = the caller's personal library; given with a
//     different `circleId`/`ownerGroupId` -> 400; no personal library -> 404;
//   - any other `scope` value is left alone (some routes have their own
//     `scope` parameter, e.g. `scope=mine|all` on the share list).
// The platform's own routes (groups, grants, sharing, public links, auth) are
// never touched.
// =============================================================================

import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  NotFoundException,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

import { PersonalLibraryStore } from './personal-library.store';

/** The personal-library scope value. */
export const OWNER_SCOPE_ME = 'me';

/** Paths the rewrite never touches: the platform slices' own parameters. */
const UNTOUCHED_PREFIXES = ['/api/groups', '/api/grants', '/api/sharing', '/api/public', '/api/auth'] as const;

type Params = Record<string, unknown>;

/** Whether a request path is one of the platform's own (never rewritten). */
export function isUntouchedPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0];
  return UNTOUCHED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Whether a params object carries one of the two new owner-scope forms. */
export function hasOwnerScopeParams(params: unknown): params is Params {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const p = params as Params;
  return p.ownerGroupId !== undefined || p.scope === OWNER_SCOPE_ME;
}

/**
 * Rewrites `ownerGroupId` / `scope=me` into `circleId`, in place. `personal`
 * resolves the caller's personal library id (only called for `scope=me`).
 */
export async function rewriteOwnerScope(params: Params, personal: () => Promise<string | null>): Promise<void> {
  const fromGroup = params.ownerGroupId;
  if (fromGroup !== undefined) {
    if (typeof fromGroup !== 'string' || fromGroup.length === 0) throw new BadRequestException('ownerGroupId must be a group id');
    if (params.circleId !== undefined && params.circleId !== fromGroup) {
      throw new BadRequestException('ownerGroupId and circleId name different owner scopes');
    }
    params.circleId = fromGroup;
    delete params.ownerGroupId;
  }
  if (params.scope === OWNER_SCOPE_ME) {
    const id = await personal();
    if (!id) throw new NotFoundException('No personal library');
    if (params.circleId !== undefined && params.circleId !== id) {
      throw new BadRequestException('scope=me names a different owner scope than circleId/ownerGroupId');
    }
    params.circleId = id;
    delete params.scope;
  }
}

type RequestLike = {
  url?: string;
  query?: unknown;
  body?: unknown;
  user?: { id?: string };
  requestUser?: { id?: string };
};

@Injectable()
export class OwnerScopeParamsInterceptor implements NestInterceptor {
  constructor(private readonly store: PersonalLibraryStore) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<RequestLike>();
    const targets = [request.query, request.body].filter(hasOwnerScopeParams);
    if (targets.length === 0 || isUntouchedPath(request.url)) return next.handle();

    let cached: Promise<string | null> | undefined;
    const personal = () => (cached ??= this.personalLibraryOf(request.requestUser?.id ?? request.user?.id));
    for (const params of targets) await rewriteOwnerScope(params, personal);
    return next.handle();
  }

  /** The caller's personal library id (its former personal circle), or null. */
  private async personalLibraryOf(userId: string | undefined): Promise<string | null> {
    if (!userId) return null;
    return this.store.idOf(userId);
  }
}
