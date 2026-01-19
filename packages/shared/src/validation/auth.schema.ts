import { z } from 'zod';

/**
 * OAuth provider validation
 */
export const oauthProviderSchema = z.enum(['google', 'microsoft', 'github']);

/**
 * Refresh token request validation
 */
export const refreshTokenRequestSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

/**
 * Logout request validation
 */
export const logoutRequestSchema = z.object({
  refreshToken: z.string().optional(),
});

/**
 * OAuth callback query parameters validation
 */
export const oauthCallbackParamsSchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
  state: z.string().min(1, 'State parameter is required'),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

/**
 * Update user profile validation
 */
export const updateUserProfileSchema = z.object({
  displayName: z
    .string()
    .min(1, 'Display name cannot be empty')
    .max(255, 'Display name is too long')
    .optional(),
});

/**
 * User settings validation
 */
export const userSettingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']).optional(),
  language: z.string().min(2).max(10).optional(),
  notifications: z
    .object({
      email: z.boolean().optional(),
      push: z.boolean().optional(),
    })
    .optional(),
});

/**
 * Pagination params validation
 */
export const paginationParamsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Type exports for validated schemas
 */
export type OAuthProviderInput = z.infer<typeof oauthProviderSchema>;
export type RefreshTokenRequestInput = z.infer<typeof refreshTokenRequestSchema>;
export type LogoutRequestInput = z.infer<typeof logoutRequestSchema>;
export type OAuthCallbackParamsInput = z.infer<typeof oauthCallbackParamsSchema>;
export type UpdateUserProfileInput = z.infer<typeof updateUserProfileSchema>;
export type UserSettingsInput = z.infer<typeof userSettingsSchema>;
export type PaginationParamsInput = z.infer<typeof paginationParamsSchema>;
