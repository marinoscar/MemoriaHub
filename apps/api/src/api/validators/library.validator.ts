/**
 * Library Validators
 *
 * Request validation middleware for library endpoints.
 */

import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import {
  createLibrarySchema,
  updateLibrarySchema,
  addLibraryMemberSchema,
  updateLibraryMemberSchema,
  listLibrariesQuerySchema,
  addAssetToLibrarySchema,
  addAssetsToLibrarySchema,
} from '@memoriahub/shared';
import { ValidationError } from '../../domain/errors/ValidationError.js';

/**
 * Helper to check if an error is a ZodError
 * Uses name check instead of instanceof to handle multiple Zod instances
 */
function isZodError(error: unknown): error is ZodError {
  return error instanceof Error && error.name === 'ZodError';
}

/**
 * Validate create library request body
 */
export function validateCreateLibrary(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    createLibrarySchema.parse(req.body);
    next();
  } catch (error) {
    if (isZodError(error)) {
      next(ValidationError.fromZodError(error));
      return;
    }
    next(error);
  }
}

/**
 * Validate update library request body
 */
export function validateUpdateLibrary(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    updateLibrarySchema.parse(req.body);
    next();
  } catch (error) {
    if (isZodError(error)) {
      next(ValidationError.fromZodError(error));
      return;
    }
    next(error);
  }
}

/**
 * Validate add library member request body
 */
export function validateAddLibraryMember(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    addLibraryMemberSchema.parse(req.body);
    next();
  } catch (error) {
    if (isZodError(error)) {
      next(ValidationError.fromZodError(error));
      return;
    }
    next(error);
  }
}

/**
 * Validate update library member request body
 */
export function validateUpdateLibraryMember(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    updateLibraryMemberSchema.parse(req.body);
    next();
  } catch (error) {
    if (isZodError(error)) {
      next(ValidationError.fromZodError(error));
      return;
    }
    next(error);
  }
}

/**
 * Validate list libraries query parameters
 */
export function validateListLibrariesQuery(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    listLibrariesQuerySchema.parse(req.query);
    next();
  } catch (error) {
    if (isZodError(error)) {
      next(ValidationError.fromZodError(error));
      return;
    }
    next(error);
  }
}

/**
 * Validate add asset to library request body
 */
export function validateAddAssetToLibrary(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    addAssetToLibrarySchema.parse(req.body);
    next();
  } catch (error) {
    if (isZodError(error)) {
      next(ValidationError.fromZodError(error));
      return;
    }
    next(error);
  }
}

/**
 * Validate add multiple assets to library request body
 */
export function validateAddAssetsToLibrary(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    addAssetsToLibrarySchema.parse(req.body);
    next();
  } catch (error) {
    if (isZodError(error)) {
      next(ValidationError.fromZodError(error));
      return;
    }
    next(error);
  }
}
