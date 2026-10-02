import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PatService } from '../../pat/pat.service';
import { NodeCredentialService } from '../../nodes/node-credential.service';
import type { AuthCredentialInfo } from '../decorators/auth-credential.decorator';

/**
 * JWT authentication guard
 *
 * Validates JWT tokens on protected routes.
 * Routes marked with @Public() decorator are skipped.
 * Supports Personal Access Tokens (PAT) via "Bearer pat_..." Authorization header.
 * Supports worker-node credentials via "Bearer nod_..." — accepted ONLY on
 * /api/nodes/* routes (least-privilege: a node credential can never reach
 * media, settings, or even its own /api/node-credentials management routes).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private patService: PatService,
    private nodeCredentialService: NodeCredentialService,
  ) {
    super();
  }

  /**
   * Determines if the route requires authentication.
   * Skips authentication for routes marked with @Public().
   * Handles PAT tokens (Bearer pat_...) and node credentials (Bearer nod_...)
   * before falling back to JWT validation.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers?.authorization;

    if (authHeader?.startsWith('Bearer pat_')) {
      const token = authHeader.slice(7); // Remove "Bearer "
      const resolved = await this.patService.resolveToken(token);
      if (!resolved) {
        throw new UnauthorizedException('Invalid or expired personal access token');
      }
      // Set the full AuthenticatedUser on request.user so RolesGuard/PermissionsGuard
      // can call toRequestUser() on it (same format as JWT strategy validate() returns)
      request.user = resolved.user;
      // Which PAT it was (its id, never the token): `@AuthCredential()`.
      request.authCredential = { kind: 'pat', tokenId: resolved.tokenId } satisfies AuthCredentialInfo;
      return true;
    }

    if (authHeader?.startsWith('Bearer nod_')) {
      // Route allowlist FIRST: a node credential is only ever valid on the
      // node data/control plane. Rejecting before validateToken also avoids
      // stamping lastUsedAt for requests that would be forbidden anyway.
      if (!this.isNodeRoute(request)) {
        throw new ForbiddenException('node credentials are valid only for node endpoints');
      }

      const token = authHeader.slice(7); // Remove "Bearer "
      const user = await this.nodeCredentialService.validateToken(token);
      if (!user) {
        throw new UnauthorizedException('Invalid, expired, or revoked node credential');
      }
      request.user = user;
      request.authCredential = { kind: 'node' } satisfies AuthCredentialInfo;
      return true;
    }

    const admitted = await (super.canActivate(context) as Promise<boolean>);
    if (admitted) request.authCredential = { kind: 'jwt' } satisfies AuthCredentialInfo;
    return admitted;
  }

  /**
   * True when the request targets /api/nodes or /api/nodes/*.
   *
   * Uses the raw request URL (Fastify's `request.url` — includes the global
   * `/api` prefix and any query string; `originalUrl` preferred when present
   * since `url` can be rewritten) with the query string stripped, so
   * `/api/nodesX` or `/api/node-credentials` never match.
   */
  private isNodeRoute(request: { originalUrl?: string; url?: string }): boolean {
    const rawUrl: string = request.originalUrl ?? request.url ?? '';
    const path = rawUrl.split('?')[0];
    return path === '/api/nodes' || path.startsWith('/api/nodes/');
  }
}
