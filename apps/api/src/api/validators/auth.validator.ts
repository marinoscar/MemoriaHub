import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  oauthProviderSchema,
  refreshTokenRequestSchema,
  oauthCallbackParamsSchema,
} from '@memoriahub/shared';
import { ValidationError } from '../../domain/errors/index.js';

/**
 * Validate OAuth provider parameter
 */
export function validateOAuthProvider(req: Request, _res: Response, next: NextFunction): void {
  try {
    oauthProviderSchema.parse(req.params.provider);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      next(ValidationError.fromZodError(error));
      return;
    }
    next(error);
  }
}

/**
 * Validate OAuth callback query parameters
 */
export function validateOAuthCallback(req: Request, _res: Response, next: NextFunction): void {
  try {
    oauthCallbackParamsSchema.parse(req.query);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      next(ValidationError.fromZodError(error));
      return;
    }
    next(error);
  }
}

/**
 * Validate refresh token request body
 */
export function validateRefreshToken(req: Request, _res: Response, next: NextFunction): void {
  try {
    refreshTokenRequestSchema.parse(req.body);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      next(ValidationError.fromZodError(error));
      return;
    }
    next(error);
  }
}
