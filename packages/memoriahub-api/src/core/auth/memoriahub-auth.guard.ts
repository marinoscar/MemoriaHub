import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { MEMORIAHUB_IDENTITY, type MemoriahubIdentityPort, type MemoriahubPrincipal } from '../../ports/index.js';
import {
  MEMORIAHUB_ANY_PERMISSIONS_KEY,
  MEMORIAHUB_AUTH_FAILURE_PROPERTY,
  MEMORIAHUB_CREDENTIALS_KEY,
  MEMORIAHUB_IS_PUBLIC_KEY,
  MEMORIAHUB_PERMISSIONS_KEY,
  MEMORIAHUB_REQUEST_CREDENTIAL_PROPERTY,
  MEMORIAHUB_REQUEST_USER_PROPERTY,
  MEMORIAHUB_ROLES_KEY,
} from './memoriahub-auth.constants.js';

type RequestBag = Record<string, unknown>;

/**
 * The guard behind `@MemoriahubAuth()`. It authenticates through the `MEMORIAHUB_IDENTITY` port and then
 * applies, in the order the web edition's guards do, the role check, the permission check and the
 * credential-kind check. The refusals carry the web edition's messages, so a host that binds the port
 * with the platform identity adapter answers byte-for-byte what its `@Auth()` answered.
 *
 * @extensionPoint guard
 * @stability experimental
 */
@Injectable()
export class MemoriahubAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(MEMORIAHUB_IDENTITY) private readonly identity: MemoriahubIdentityPort,
  ) {}

  /**
   * Decides a request.
   *
   * @param context - the execution context.
   * @returns `true` when the request may proceed; otherwise it throws a 401 or 403.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const request = context.switchToHttp().getRequest<RequestBag>();

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(MEMORIAHUB_IS_PUBLIC_KEY, targets);
    let principal: MemoriahubPrincipal | null = null;
    if (!isPublic) {
      principal = await this.identity.authenticate(context);
      if (!principal) {
        const failure = request[MEMORIAHUB_AUTH_FAILURE_PROPERTY];
        throw typeof failure === 'string' ? new UnauthorizedException(failure) : new UnauthorizedException();
      }
      request[MEMORIAHUB_REQUEST_USER_PROPERTY] = {
        id: principal.userId,
        roles: [...principal.roles],
        permissions: [...principal.permissions],
        activeOrgId: principal.orgId,
      };
      request[MEMORIAHUB_REQUEST_CREDENTIAL_PROPERTY] = principal.credential ?? null;
    }

    this.checkRoles(this.reflector.getAllAndOverride<string[] | undefined>(MEMORIAHUB_ROLES_KEY, targets), principal);
    this.checkPermissions(
      this.reflector.getAllAndOverride<string[] | undefined>(MEMORIAHUB_PERMISSIONS_KEY, targets),
      this.reflector.getAllAndOverride<string[] | undefined>(MEMORIAHUB_ANY_PERMISSIONS_KEY, targets),
      principal,
    );
    this.checkCredential(this.reflector.getAllAndOverride<string[] | undefined>(MEMORIAHUB_CREDENTIALS_KEY, targets), principal);
    return true;
  }

  private checkRoles(required: string[] | undefined, principal: MemoriahubPrincipal | null): void {
    if (!required || required.length === 0) return;
    if (!principal) throw new ForbiddenException('No user in request');
    if (!required.some((role) => principal.roles.includes(role))) {
      throw new ForbiddenException(`Required roles: ${required.join(', ')}`);
    }
  }

  private checkPermissions(required: string[] | undefined, anyOf: string[] | undefined, principal: MemoriahubPrincipal | null): void {
    const all = required ?? [];
    const alternatives = anyOf ?? [];
    if (all.length === 0 && alternatives.length === 0) return;
    if (!principal) throw new ForbiddenException('No user in request');
    const missing = all.filter((permission) => !principal.permissions.has(permission));
    if (missing.length > 0) throw new ForbiddenException(`Missing permissions: ${missing.join(', ')}`);
    if (alternatives.length > 0 && !alternatives.some((permission) => principal.permissions.has(permission))) {
      throw new ForbiddenException(`Missing permissions: one of ${alternatives.join(', ')}`);
    }
  }

  private checkCredential(accepted: string[] | undefined, principal: MemoriahubPrincipal | null): void {
    if (!accepted || accepted.length === 0 || !principal) return;
    const kind = principal.credential?.kind;
    if (!kind || !accepted.includes(kind)) {
      throw new ForbiddenException(`Accepted credentials: ${accepted.join(', ')}`);
    }
  }
}
