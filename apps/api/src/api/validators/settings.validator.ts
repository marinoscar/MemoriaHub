/**
 * Settings Validators
 *
 * Request validation middleware for settings endpoints.
 */

import type { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import {
  systemSettingsCategorySchema,
  systemSettingsSchemaByCatgory,
  userPreferencesInputSchema,
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
 * Validate system settings category parameter
 */
export function validateSystemSettingsCategory(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    systemSettingsCategorySchema.parse(req.params.category);
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
 * Validate system settings update request body
 * Validates against the schema for the specific category
 */
export function validateSystemSettingsUpdate(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    // First validate that settings is an object
    const bodySchema = z.object({
      settings: z.record(z.unknown()),
    });
    const body = bodySchema.parse(req.body);

    // Then validate against category-specific schema
    const category = req.params.category as keyof typeof systemSettingsSchemaByCatgory;
    const categorySchema = systemSettingsSchemaByCatgory[category];

    if (categorySchema) {
      categorySchema.parse(body.settings);
    }

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
 * Validate user preferences update request body
 */
export function validateUserPreferencesUpdate(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    userPreferencesInputSchema.parse(req.body);
    next();
  } catch (error) {
    if (isZodError(error)) {
      next(ValidationError.fromZodError(error));
      return;
    }
    next(error);
  }
}
