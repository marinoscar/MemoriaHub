import type { OAuthProvider, User, UserDTO, UserRole } from '@memoriahub/shared';

/**
 * Convert database row to User entity
 */
export function rowToUser(row: {
  id: string;
  oauth_provider: OAuthProvider;
  oauth_subject: string;
  email: string;
  email_verified: boolean;
  display_name: string | null;
  avatar_url: string | null;
  refresh_token_hash: string | null;
  role: UserRole;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}): User {
  return {
    id: row.id,
    oauthProvider: row.oauth_provider,
    oauthSubject: row.oauth_subject,
    email: row.email,
    emailVerified: row.email_verified,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

/**
 * Convert User entity to UserDTO for API responses
 */
export function userToDTO(user: User): UserDTO {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    oauthProvider: user.oauthProvider,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}
