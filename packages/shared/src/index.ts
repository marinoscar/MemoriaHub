// Types - User
export type {
  User,
  UserDTO,
  UserRole,
  UpdateUserProfileInput,
  UserSettings,
  OAuthProvider,
} from './types/user.types.js';
export { DEFAULT_USER_SETTINGS } from './types/user.types.js';

// Types - Auth
export type {
  OAuthProviderInfo,
  TokenResponse,
  RefreshTokenRequest,
  RefreshTokenResponse,
  LogoutRequest,
  LoginResponse,
  AccessTokenPayload,
  RefreshTokenPayload,
  OAuthCallbackParams,
  OAuthState,
} from './types/auth.types.js';

// Types - API
export type {
  ApiResponse,
  ApiMeta,
  ApiError,
  ErrorCode,
  PaginationParams,
  HealthResponse,
  ReadyResponse,
} from './types/api.types.js';
export { ErrorCodes } from './types/api.types.js';

// Types - Settings
export type {
  SystemSettingsCategory,
  SmtpSettings,
  PushSettings,
  StorageSettings,
  FeatureSettings,
  GeneralSettings,
  SystemSettings,
  SystemSettingsRow,
  SystemSettingsDTO,
  EmailNotificationPreferences,
  PushNotificationPreferences,
  UIPreferences,
  PrivacyPreferences,
  UserPreferences,
  UserPreferencesRow,
  UserPreferencesDTO,
  SmtpSettingsInput,
  PushSettingsInput as PushSettingsInputType,
  FeatureSettingsInput as FeatureSettingsInputType,
  GeneralSettingsInput as GeneralSettingsInputType,
  UserPreferencesInput as UserPreferencesInputType,
} from './types/settings.types.js';
export {
  DEFAULT_SMTP_SETTINGS,
  DEFAULT_PUSH_SETTINGS,
  DEFAULT_STORAGE_SETTINGS,
  DEFAULT_FEATURE_SETTINGS,
  DEFAULT_GENERAL_SETTINGS,
  DEFAULT_EMAIL_NOTIFICATION_PREFS,
  DEFAULT_PUSH_NOTIFICATION_PREFS,
  DEFAULT_UI_PREFERENCES,
  DEFAULT_PRIVACY_PREFERENCES,
  DEFAULT_USER_PREFERENCES,
  SENSITIVE_SETTINGS_FIELDS,
  MASKED_SETTINGS_FIELDS,
} from './types/settings.types.js';

// Validation schemas - Auth
export {
  oauthProviderSchema,
  refreshTokenRequestSchema,
  logoutRequestSchema,
  oauthCallbackParamsSchema,
  updateUserProfileSchema,
  userSettingsSchema,
  paginationParamsSchema,
} from './validation/auth.schema.js';

export type {
  OAuthProviderInput,
  RefreshTokenRequestInput,
  LogoutRequestInput,
  OAuthCallbackParamsInput,
  UserSettingsInput,
  PaginationParamsInput,
} from './validation/auth.schema.js';

// Validation schemas - Settings
export {
  systemSettingsCategorySchema,
  smtpSettingsSchema,
  pushSettingsSchema,
  storageSettingsSchema,
  featureSettingsSchema,
  generalSettingsSchema,
  systemSettingsSchemaByCatgory,
  emailNotificationPreferencesSchema,
  pushNotificationPreferencesSchema,
  uiPreferencesSchema,
  privacyPreferencesSchema,
  userPreferencesInputSchema,
  updateSystemSettingsRequestSchema,
  testSmtpRequestSchema,
  testPushRequestSchema,
} from './validation/settings.schema.js';

export type {
  SystemSettingsCategoryInput,
  SmtpSettingsInput as SmtpSettingsSchemaInput,
  PushSettingsInput as PushSettingsSchemaInput,
  StorageSettingsInput as StorageSettingsSchemaInput,
  FeatureSettingsInput as FeatureSettingsSchemaInput,
  GeneralSettingsInput as GeneralSettingsSchemaInput,
  EmailNotificationPreferencesInput,
  PushNotificationPreferencesInput,
  UIPreferencesInput,
  PrivacyPreferencesInput,
  UserPreferencesInput as UserPreferencesSchemaInput,
  UpdateSystemSettingsRequestInput,
  TestSmtpRequestInput,
  TestPushRequestInput,
} from './validation/settings.schema.js';

// Constants
export {
  HttpStatus,
  HttpHeaders,
  ContentTypes,
  ApiRoutes,
} from './constants/http.constants.js';
export type { HttpStatusCode } from './constants/http.constants.js';
