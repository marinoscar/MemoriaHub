import { z } from 'zod';

// =============================================================================
// System Settings Schemas
// =============================================================================

/**
 * System settings category validation
 */
export const systemSettingsCategorySchema = z.enum(['smtp', 'push', 'storage', 'features', 'general']);

/**
 * SMTP settings validation
 */
export const smtpSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  host: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  username: z.string().max(255).optional(),
  password: z.string().max(500).optional(),
  fromAddress: z.string().email().or(z.literal('')).optional(),
  fromName: z.string().max(100).optional(),
});

/**
 * Push notification settings validation
 */
export const pushSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['firebase', 'webpush']).nullable().optional(),
  firebaseProjectId: z.string().max(255).optional(),
  firebasePrivateKey: z.string().optional(),
  firebaseClientEmail: z.string().email().optional(),
  vapidPublicKey: z.string().optional(),
  vapidPrivateKey: z.string().optional(),
});

/**
 * Storage settings validation
 */
export const storageSettingsSchema = z.object({
  defaultBackend: z.enum(['local', 's3']).optional(),
  localPath: z.string().max(500).optional(),
  s3Endpoint: z.string().url().optional(),
  s3Bucket: z.string().max(63).optional(),
  s3Region: z.string().max(50).optional(),
});

/**
 * Feature flags validation
 */
export const featureSettingsSchema = z.object({
  aiSearch: z.boolean().optional(),
  faceRecognition: z.boolean().optional(),
  webdavSync: z.boolean().optional(),
  publicSharing: z.boolean().optional(),
  guestUploads: z.boolean().optional(),
});

/**
 * General settings validation
 */
export const generalSettingsSchema = z.object({
  siteName: z.string().min(1).max(100).optional(),
  siteDescription: z.string().max(500).optional(),
  allowRegistration: z.boolean().optional(),
  requireEmailVerification: z.boolean().optional(),
  maxUploadSizeMB: z.number().int().min(1).max(10000).optional(),
  supportedFormats: z.array(z.string().max(10)).max(50).optional(),
});

/**
 * Map of category to schema for dynamic validation
 */
export const systemSettingsSchemaByCatgory = {
  smtp: smtpSettingsSchema,
  push: pushSettingsSchema,
  storage: storageSettingsSchema,
  features: featureSettingsSchema,
  general: generalSettingsSchema,
} as const;

// =============================================================================
// User Preferences Schemas
// =============================================================================

/**
 * Email notification preferences validation
 */
export const emailNotificationPreferencesSchema = z.object({
  enabled: z.boolean().optional(),
  digest: z.enum(['instant', 'daily', 'weekly', 'never']).optional(),
  newShares: z.boolean().optional(),
  comments: z.boolean().optional(),
  albumUpdates: z.boolean().optional(),
  systemAlerts: z.boolean().optional(),
});

/**
 * Push notification preferences validation
 */
export const pushNotificationPreferencesSchema = z.object({
  enabled: z.boolean().optional(),
  newShares: z.boolean().optional(),
  comments: z.boolean().optional(),
  albumUpdates: z.boolean().optional(),
});

/**
 * UI preferences validation
 */
export const uiPreferencesSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']).optional(),
  language: z.string().min(2).max(10).optional(),
  gridSize: z.enum(['small', 'medium', 'large']).optional(),
  autoPlayVideos: z.boolean().optional(),
  showMetadata: z.boolean().optional(),
});

/**
 * Privacy preferences validation
 */
export const privacyPreferencesSchema = z.object({
  showOnlineStatus: z.boolean().optional(),
  allowTagging: z.boolean().optional(),
  defaultAlbumVisibility: z.enum(['private', 'shared', 'public']).optional(),
});

/**
 * Complete user preferences validation (for partial updates)
 */
export const userPreferencesInputSchema = z.object({
  notifications: z.object({
    email: emailNotificationPreferencesSchema.optional(),
    push: pushNotificationPreferencesSchema.optional(),
  }).optional(),
  ui: uiPreferencesSchema.optional(),
  privacy: privacyPreferencesSchema.optional(),
});

// =============================================================================
// Request Validation Schemas
// =============================================================================

/**
 * Update system settings request
 */
export const updateSystemSettingsRequestSchema = z.object({
  settings: z.record(z.unknown()),
});

/**
 * Test SMTP connection request
 */
export const testSmtpRequestSchema = z.object({
  recipientEmail: z.string().email(),
});

/**
 * Test push notification request
 */
export const testPushRequestSchema = z.object({
  userId: z.string().uuid().optional(), // If not provided, send to current user
});

// =============================================================================
// Type Exports
// =============================================================================

export type SystemSettingsCategoryInput = z.infer<typeof systemSettingsCategorySchema>;
export type SmtpSettingsInput = z.infer<typeof smtpSettingsSchema>;
export type PushSettingsInput = z.infer<typeof pushSettingsSchema>;
export type StorageSettingsInput = z.infer<typeof storageSettingsSchema>;
export type FeatureSettingsInput = z.infer<typeof featureSettingsSchema>;
export type GeneralSettingsInput = z.infer<typeof generalSettingsSchema>;
export type EmailNotificationPreferencesInput = z.infer<typeof emailNotificationPreferencesSchema>;
export type PushNotificationPreferencesInput = z.infer<typeof pushNotificationPreferencesSchema>;
export type UIPreferencesInput = z.infer<typeof uiPreferencesSchema>;
export type PrivacyPreferencesInput = z.infer<typeof privacyPreferencesSchema>;
export type UserPreferencesInput = z.infer<typeof userPreferencesInputSchema>;
export type UpdateSystemSettingsRequestInput = z.infer<typeof updateSystemSettingsRequestSchema>;
export type TestSmtpRequestInput = z.infer<typeof testSmtpRequestSchema>;
export type TestPushRequestInput = z.infer<typeof testPushRequestSchema>;
