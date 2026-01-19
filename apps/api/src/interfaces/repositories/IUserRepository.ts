import type { OAuthProvider, User } from '@memoriahub/shared';

/**
 * User creation input
 */
export interface CreateUserInput {
  oauthProvider: OAuthProvider;
  oauthSubject: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
  avatarUrl?: string;
}

/**
 * User update input
 */
export interface UpdateUserInput {
  displayName?: string;
  avatarUrl?: string;
  email?: string;
  emailVerified?: boolean;
  refreshTokenHash?: string | null;
  lastLoginAt?: Date;
}

/**
 * User repository interface (Dependency Inversion)
 * Data access abstraction for user entities
 */
export interface IUserRepository {
  /**
   * Find user by ID
   * @param id User UUID
   * @returns User or null
   */
  findById(id: string): Promise<User | null>;

  /**
   * Find user by OAuth identity
   * @param provider OAuth provider
   * @param subject Provider's user ID
   * @returns User or null
   */
  findByOAuthIdentity(provider: OAuthProvider, subject: string): Promise<User | null>;

  /**
   * Find user by email and provider
   * @param provider OAuth provider
   * @param email Email address
   * @returns User or null
   */
  findByEmail(provider: OAuthProvider, email: string): Promise<User | null>;

  /**
   * Create a new user
   * @param input User creation input
   * @returns Created user
   */
  create(input: CreateUserInput): Promise<User>;

  /**
   * Update user
   * @param id User ID
   * @param input Update input
   * @returns Updated user
   */
  update(id: string, input: UpdateUserInput): Promise<User>;

  /**
   * Find or create user by OAuth identity
   * @param input User creation input
   * @returns Existing or newly created user
   */
  findOrCreate(input: CreateUserInput): Promise<{ user: User; created: boolean }>;
}
