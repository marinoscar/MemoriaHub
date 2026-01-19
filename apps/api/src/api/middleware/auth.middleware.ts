import type { Request, Response, NextFunction } from 'express';
import { ErrorCodes } from '@memoriahub/shared';
import type { UserRole } from '@memoriahub/shared';
import { tokenService } from '../../services/auth/index.js';
import { AuthError, ForbiddenError } from '../../domain/errors/index.js';
import { logger, LogEventTypes } from '../../infrastructure/logging/logger.js';
import { setUserId, getTraceId } from '../../infrastructure/logging/request-context.js';

/**
 * Extend Express Request type with user info
 */
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: UserRole;
      };
    }
  }
}

/**
 * Authentication middleware
 * Verifies JWT access token and attaches user info to request
 */
export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    next(new AuthError('Authorization header required', ErrorCodes.UNAUTHORIZED));
    return;
  }

  if (!authHeader.startsWith('Bearer ')) {
    next(new AuthError('Invalid authorization header format', ErrorCodes.UNAUTHORIZED));
    return;
  }

  const token = authHeader.substring(7);

  if (!token) {
    next(new AuthError('Token required', ErrorCodes.UNAUTHORIZED));
    return;
  }

  try {
    const payload = tokenService.verifyAccessToken(token);

    // Attach user info to request
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
    };

    // Set user ID in request context for logging
    setUserId(payload.sub);

    logger.debug(
      {
        eventType: 'auth.verified',
        userId: payload.sub,
        role: payload.role,
        traceId: getTraceId(),
      },
      'Token verified'
    );

    next();
  } catch (error) {
    if (error instanceof AuthError) {
      logger.debug(
        {
          eventType: LogEventTypes.AUTH_TOKEN_INVALID,
          error: error.message,
          traceId: getTraceId(),
        },
        'Token verification failed'
      );
      next(error);
      return;
    }

    next(new AuthError('Authentication failed', ErrorCodes.UNAUTHORIZED));
  }
}

/**
 * Optional authentication middleware
 * Attaches user info if valid token present, but doesn't require it
 */
export function optionalAuthMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = authHeader.substring(7);

  if (!token) {
    next();
    return;
  }

  try {
    const payload = tokenService.verifyAccessToken(token);

    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
    };

    setUserId(payload.sub);
  } catch {
    // Token invalid, but that's okay for optional auth
  }

  next();
}

/**
 * Admin authorization middleware
 * Requires authentication and admin role
 * Must be used after authMiddleware
 */
export function adminMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new AuthError('Authentication required', ErrorCodes.UNAUTHORIZED));
    return;
  }

  if (req.user.role !== 'admin') {
    logger.warn(
      {
        eventType: 'auth.admin.denied',
        userId: req.user.id,
        role: req.user.role,
        path: req.path,
        method: req.method,
        traceId: getTraceId(),
      },
      'Non-admin user attempted admin action'
    );
    next(new ForbiddenError('Admin access required'));
    return;
  }

  logger.debug(
    {
      eventType: 'auth.admin.verified',
      userId: req.user.id,
      traceId: getTraceId(),
    },
    'Admin access verified'
  );

  next();
}
