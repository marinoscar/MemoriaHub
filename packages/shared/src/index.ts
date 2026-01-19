// Types
export type {
  User,
  UserDTO,
  UpdateUserProfileInput,
  UserSettings,
  OAuthProvider,
} from './types/user.types.js';
export { DEFAULT_USER_SETTINGS } from './types/user.types.js';

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

// Validation schemas
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

// Constants
export {
  HttpStatus,
  HttpHeaders,
  ContentTypes,
  ApiRoutes,
} from './constants/http.constants.js';
export type { HttpStatusCode } from './constants/http.constants.js';
