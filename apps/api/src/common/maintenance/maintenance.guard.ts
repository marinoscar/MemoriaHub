import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ALLOW_DURING_MAINTENANCE_KEY } from './allow-during-maintenance.decorator';
import { MaintenanceModeService } from './maintenance-mode.service';
import { ROLES } from '../constants/roles.constants';

/**
 * Stable marker in the 503 body. The frontend keys off THIS string to tell a
 * maintenance window apart from an ordinary upstream 503 (a crashed API, a
 * proxy with no backend) and render the maintenance screen instead of a
 * generic error. Do not change it without changing apps/web in the same PR.
 */
export const MAINTENANCE_ERROR_MARKER = 'maintenance';

/** Seconds advertised in the `Retry-After` header of a maintenance 503. */
export const MAINTENANCE_RETRY_AFTER_SECONDS = 120;

/**
 * Global guard (registered as `APP_GUARD` in app.module.ts) implementing
 * admin-controlled maintenance mode — issue #348.
 *
 * ORDERING NOTE, and why this guard resolves the admin role itself:
 * a global guard runs BEFORE any route-level `UseGuards(JwtAuthGuard, ...)`,
 * so `request.user` is still undefined here. To honor the `allowAdmins`
 * bypass this guard therefore verifies the bearer JWT on its own and reads
 * the `roles` claim. It never populates `request.user` — authentication
 * remains entirely JwtAuthGuard's job, and a token that fails verification
 * here is simply treated as "not an admin", not rejected.
 *
 * LIMITATION (deliberate): only JWTs grant the admin bypass. Personal access
 * tokens (`pat_`) and worker-node credentials (`nod_`) are opaque, need a DB
 * lookup to resolve, and belong to unattended clients — the CLI and the
 * worker fleet — which SHOULD back off during a maintenance window. They are
 * blocked regardless of `allowAdmins`. See docs/runbooks/maintenance-mode.md.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  private readonly logger = new Logger(MaintenanceGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly maintenance: MaintenanceModeService,
    private readonly jwtService: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Non-HTTP execution contexts (none today, but a future microservice or
    // websocket transport must not be blocked by an HTTP-shaped 503).
    if (context.getType() !== 'http') {
      return true;
    }

    // LOCKOUT SAFEGUARD #1 — exempt routes (health probes, the sign-in auth
    // routes, and the maintenance endpoints themselves).
    const exempt = this.reflector.getAllAndOverride<boolean>(
      ALLOW_DURING_MAINTENANCE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (exempt) {
      return true;
    }

    const state = await this.maintenance.getState();
    if (!state.active) {
      return true;
    }

    // LOCKOUT SAFEGUARD #2 — the admin bypass, on by default.
    if (state.allowAdmins && this.isAdminRequest(context)) {
      return true;
    }

    const response = context.switchToHttp().getResponse();
    // Set the header on the reply WITHOUT sending: HttpExceptionFilter calls
    // response.code(...).send(...) afterwards and preserves headers already set.
    response?.header?.('Retry-After', String(MAINTENANCE_RETRY_AFTER_SECONDS));

    throw new ServiceUnavailableException({
      error: MAINTENANCE_ERROR_MARKER,
      message:
        state.message || 'The application is temporarily down for maintenance.',
      startedAt: state.startedAt,
    });
  }

  /**
   * True when the request carries a valid JWT whose `roles` claim includes
   * the Admin role. Any failure — no header, a PAT/node credential, an
   * expired or forged token — resolves to false rather than throwing, so an
   * unauthenticated request gets the maintenance 503 (not a 401) and a
   * genuinely bad token is still rejected later by JwtAuthGuard.
   */
  private isAdminRequest(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    // Defensive: if some future ordering does populate request.user before
    // this guard runs, prefer that already-resolved identity.
    const existing = request?.user;
    if (existing?.userRoles && Array.isArray(existing.userRoles)) {
      return existing.userRoles.some(
        (ur: { role?: { name?: string } }) => ur?.role?.name === ROLES.ADMIN,
      );
    }

    const authHeader: string | undefined = request?.headers?.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return false;
    }

    const token = authHeader.slice(7);
    // Opaque credentials are not JWTs and are never granted the bypass.
    if (token.startsWith('pat_') || token.startsWith('nod_')) {
      return false;
    }

    try {
      const payload = this.jwtService.verify<{ roles?: string[] }>(token);
      return Array.isArray(payload?.roles) && payload.roles.includes(ROLES.ADMIN);
    } catch {
      // Expired / invalid / wrong-secret token: not an admin.
      return false;
    }
  }
}
