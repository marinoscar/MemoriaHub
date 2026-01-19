/**
 * Settings Types
 *
 * This module defines all settings-related types for MemoriaHub.
 * Settings are divided into:
 * - System Settings: App-wide configuration (SMTP, push, features) - admin only
 * - User Preferences: Per-user settings (notifications, UI) - user editable
 */

// =============================================================================
// System Settings Categories
// =============================================================================

/**
 * Valid system settings categories
 */
export type SystemSettingsCategory = 'smtp' | 'push' | 'storage' | 'features' | 'general';

/**
 * SMTP email configuration
 */
export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string; // Encrypted at rest
  fromAddress: string;
  fromName: string;
}

/**
 * Push notification configuration
 */
export interface PushSettings {
  enabled: boolean;
  provider: 'firebase' | 'webpush' | null;
  // Firebase config (if provider is 'firebase')
  firebaseProjectId?: string;
  firebasePrivateKey?: string; // Encrypted at rest
  firebaseClientEmail?: string;
  // Web Push config (if provider is 'webpush')
  vapidPublicKey?: string;
  vapidPrivateKey?: string; // Encrypted at rest
}

/**
 * Storage configuration (for future expansion beyond default S3)
 */
export interface StorageSettings {
  defaultBackend: 'local' | 's3';
  localPath?: string;
  // S3 settings are typically from env vars, but can be overridden
  s3Endpoint?: string;
  s3Bucket?: string;
  s3Region?: string;
}

/**
 * Feature flags for enabling/disabling functionality
 */
export interface FeatureSettings {
  aiSearch: boolean;
  faceRecognition: boolean;
  webdavSync: boolean;
  publicSharing: boolean;
  guestUploads: boolean;
}

/**
 * General application settings
 */
export interface GeneralSettings {
  siteName: string;
  siteDescription: string;
  allowRegistration: boolean;
  requireEmailVerification: boolean;
  maxUploadSizeMB: number;
  supportedFormats: string[];
}

/**
 * Union type for all system settings
 */
export type SystemSettings =
  | { category: 'smtp'; settings: SmtpSettings }
  | { category: 'push'; settings: PushSettings }
  | { category: 'storage'; settings: StorageSettings }
  | { category: 'features'; settings: FeatureSettings }
  | { category: 'general'; settings: GeneralSettings };

/**
 * System settings database row
 */
export interface SystemSettingsRow {
  id: string;
  category: SystemSettingsCategory;
  settings: Record<string, unknown>;
  updatedAt: Date;
  updatedBy: string | null;
}

/**
 * System settings DTO for API responses
 */
export interface SystemSettingsDTO {
  category: SystemSettingsCategory;
  settings: Record<string, unknown>;
  updatedAt: string;
  updatedBy: string | null;
}

// =============================================================================
// User Preferences
// =============================================================================

/**
 * Email notification preferences
 */
export interface EmailNotificationPreferences {
  enabled: boolean;
  digest: 'instant' | 'daily' | 'weekly' | 'never';
  newShares: boolean;
  comments: boolean;
  albumUpdates: boolean;
  systemAlerts: boolean;
}

/**
 * Push notification preferences
 */
export interface PushNotificationPreferences {
  enabled: boolean;
  newShares: boolean;
  comments: boolean;
  albumUpdates: boolean;
}

/**
 * UI preferences
 */
export interface UIPreferences {
  theme: 'dark' | 'light' | 'system';
  language: string;
  gridSize: 'small' | 'medium' | 'large';
  autoPlayVideos: boolean;
  showMetadata: boolean;
}

/**
 * Privacy preferences
 */
export interface PrivacyPreferences {
  showOnlineStatus: boolean;
  allowTagging: boolean;
  defaultAlbumVisibility: 'private' | 'shared' | 'public';
}

/**
 * Complete user preferences structure
 */
export interface UserPreferences {
  notifications: {
    email: EmailNotificationPreferences;
    push: PushNotificationPreferences;
  };
  ui: UIPreferences;
  privacy: PrivacyPreferences;
}

/**
 * User preferences database row
 */
export interface UserPreferencesRow {
  userId: string;
  preferences: UserPreferences;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * User preferences DTO for API responses
 */
export interface UserPreferencesDTO {
  userId: string;
  preferences: UserPreferences;
  updatedAt: string;
}

// =============================================================================
// Default Values
// =============================================================================

/**
 * Default SMTP settings (disabled)
 */
export const DEFAULT_SMTP_SETTINGS: SmtpSettings = {
  enabled: false,
  host: '',
  port: 587,
  secure: true,
  username: '',
  password: '',
  fromAddress: '',
  fromName: 'MemoriaHub',
};

/**
 * Default push notification settings (disabled)
 */
export const DEFAULT_PUSH_SETTINGS: PushSettings = {
  enabled: false,
  provider: null,
};

/**
 * Default storage settings
 */
export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  defaultBackend: 's3',
};

/**
 * Default feature flags
 */
export const DEFAULT_FEATURE_SETTINGS: FeatureSettings = {
  aiSearch: false,
  faceRecognition: false,
  webdavSync: true,
  publicSharing: true,
  guestUploads: false,
};

/**
 * Default general settings
 */
export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  siteName: 'MemoriaHub',
  siteDescription: 'Your family photo memories, secured.',
  allowRegistration: true,
  requireEmailVerification: false,
  maxUploadSizeMB: 100,
  supportedFormats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'mp4', 'mov', 'avi'],
};

/**
 * Default email notification preferences
 */
export const DEFAULT_EMAIL_NOTIFICATION_PREFS: EmailNotificationPreferences = {
  enabled: true,
  digest: 'daily',
  newShares: true,
  comments: true,
  albumUpdates: true,
  systemAlerts: true,
};

/**
 * Default push notification preferences
 */
export const DEFAULT_PUSH_NOTIFICATION_PREFS: PushNotificationPreferences = {
  enabled: false,
  newShares: true,
  comments: true,
  albumUpdates: true,
};

/**
 * Default UI preferences
 */
export const DEFAULT_UI_PREFERENCES: UIPreferences = {
  theme: 'dark',
  language: 'en',
  gridSize: 'medium',
  autoPlayVideos: true,
  showMetadata: true,
};

/**
 * Default privacy preferences
 */
export const DEFAULT_PRIVACY_PREFERENCES: PrivacyPreferences = {
  showOnlineStatus: true,
  allowTagging: true,
  defaultAlbumVisibility: 'private',
};

/**
 * Complete default user preferences
 */
export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  notifications: {
    email: DEFAULT_EMAIL_NOTIFICATION_PREFS,
    push: DEFAULT_PUSH_NOTIFICATION_PREFS,
  },
  ui: DEFAULT_UI_PREFERENCES,
  privacy: DEFAULT_PRIVACY_PREFERENCES,
};

// =============================================================================
// Input Types (for partial updates)
// =============================================================================

/**
 * Partial SMTP settings update
 */
export type SmtpSettingsInput = Partial<SmtpSettings>;

/**
 * Partial push settings update
 */
export type PushSettingsInput = Partial<PushSettings>;

/**
 * Partial feature settings update
 */
export type FeatureSettingsInput = Partial<FeatureSettings>;

/**
 * Partial general settings update
 */
export type GeneralSettingsInput = Partial<GeneralSettings>;

/**
 * Deep partial for user preferences updates
 */
export interface UserPreferencesInput {
  notifications?: {
    email?: Partial<EmailNotificationPreferences>;
    push?: Partial<PushNotificationPreferences>;
  };
  ui?: Partial<UIPreferences>;
  privacy?: Partial<PrivacyPreferences>;
}

// =============================================================================
// Sensitive Fields (for encryption)
// =============================================================================

/**
 * Fields that should be encrypted at rest
 */
export const SENSITIVE_SETTINGS_FIELDS: Record<SystemSettingsCategory, string[]> = {
  smtp: ['password'],
  push: ['firebasePrivateKey', 'vapidPrivateKey'],
  storage: [],
  features: [],
  general: [],
};

/**
 * Fields that should be masked in API responses (show only last 4 chars)
 */
export const MASKED_SETTINGS_FIELDS: Record<SystemSettingsCategory, string[]> = {
  smtp: ['password', 'username'],
  push: ['firebasePrivateKey', 'vapidPrivateKey', 'firebaseClientEmail'],
  storage: [],
  features: [],
  general: [],
};
