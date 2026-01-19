/**
 * OAuth provider identifiers
 */
export type OAuthProvider = 'google' | 'microsoft' | 'github';

/**
 * User entity as stored in the database
 */
export interface User {
  id: string;
  oauthProvider: OAuthProvider;
  oauthSubject: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

/**
 * User data transfer object for API responses
 */
export interface UserDTO {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  oauthProvider: OAuthProvider;
  createdAt: string;
}

/**
 * User profile update input
 */
export interface UpdateUserProfileInput {
  displayName?: string;
}

/**
 * User settings
 */
export interface UserSettings {
  theme: 'dark' | 'light' | 'system';
  language: string;
  notifications: {
    email: boolean;
    push: boolean;
  };
}

/**
 * Default user settings
 */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  theme: 'dark',
  language: 'en',
  notifications: {
    email: true,
    push: false,
  },
};
