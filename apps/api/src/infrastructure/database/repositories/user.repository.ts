import type { OAuthProvider, User } from '@memoriahub/shared';
import type { IUserRepository, CreateUserInput, UpdateUserInput } from '../../../interfaces/index.js';
import { query, withTransaction } from '../client.js';
import { rowToUser } from '../../../domain/entities/User.js';
import { logger } from '../../logging/logger.js';

/**
 * PostgreSQL implementation of user repository
 */
export class UserRepository implements IUserRepository {
  async findById(id: string): Promise<User | null> {
    const result = await query<{
      id: string;
      oauth_provider: OAuthProvider;
      oauth_subject: string;
      email: string;
      email_verified: boolean;
      display_name: string | null;
      avatar_url: string | null;
      refresh_token_hash: string | null;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
      last_login_at: Date | null;
    }>(
      'SELECT * FROM users WHERE id = $1 AND is_active = true',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToUser(result.rows[0]);
  }

  async findByOAuthIdentity(provider: OAuthProvider, subject: string): Promise<User | null> {
    const result = await query<{
      id: string;
      oauth_provider: OAuthProvider;
      oauth_subject: string;
      email: string;
      email_verified: boolean;
      display_name: string | null;
      avatar_url: string | null;
      refresh_token_hash: string | null;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
      last_login_at: Date | null;
    }>(
      'SELECT * FROM users WHERE oauth_provider = $1 AND oauth_subject = $2 AND is_active = true',
      [provider, subject]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToUser(result.rows[0]);
  }

  async findByEmail(provider: OAuthProvider, email: string): Promise<User | null> {
    const result = await query<{
      id: string;
      oauth_provider: OAuthProvider;
      oauth_subject: string;
      email: string;
      email_verified: boolean;
      display_name: string | null;
      avatar_url: string | null;
      refresh_token_hash: string | null;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
      last_login_at: Date | null;
    }>(
      'SELECT * FROM users WHERE oauth_provider = $1 AND email = $2 AND is_active = true',
      [provider, email]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToUser(result.rows[0]);
  }

  async create(input: CreateUserInput): Promise<User> {
    const result = await query<{
      id: string;
      oauth_provider: OAuthProvider;
      oauth_subject: string;
      email: string;
      email_verified: boolean;
      display_name: string | null;
      avatar_url: string | null;
      refresh_token_hash: string | null;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
      last_login_at: Date | null;
    }>(
      `INSERT INTO users (oauth_provider, oauth_subject, email, email_verified, display_name, avatar_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.oauthProvider,
        input.oauthSubject,
        input.email,
        input.emailVerified,
        input.displayName ?? null,
        input.avatarUrl ?? null,
      ]
    );

    const user = rowToUser(result.rows[0]);

    logger.info(
      {
        eventType: 'user.created',
        userId: user.id,
        email: user.email,
        oauthProvider: user.oauthProvider,
      },
      'User created'
    );

    return user;
  }

  async update(id: string, input: UpdateUserInput): Promise<User> {
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.displayName !== undefined) {
      updates.push(`display_name = $${paramIndex++}`);
      values.push(input.displayName);
    }
    if (input.avatarUrl !== undefined) {
      updates.push(`avatar_url = $${paramIndex++}`);
      values.push(input.avatarUrl);
    }
    if (input.email !== undefined) {
      updates.push(`email = $${paramIndex++}`);
      values.push(input.email);
    }
    if (input.emailVerified !== undefined) {
      updates.push(`email_verified = $${paramIndex++}`);
      values.push(input.emailVerified);
    }
    if (input.refreshTokenHash !== undefined) {
      updates.push(`refresh_token_hash = $${paramIndex++}`);
      values.push(input.refreshTokenHash);
    }
    if (input.lastLoginAt !== undefined) {
      updates.push(`last_login_at = $${paramIndex++}`);
      values.push(input.lastLoginAt);
    }

    if (updates.length === 0) {
      const user = await this.findById(id);
      if (!user) {
        throw new Error(`User ${id} not found`);
      }
      return user;
    }

    values.push(id);

    const result = await query<{
      id: string;
      oauth_provider: OAuthProvider;
      oauth_subject: string;
      email: string;
      email_verified: boolean;
      display_name: string | null;
      avatar_url: string | null;
      refresh_token_hash: string | null;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
      last_login_at: Date | null;
    }>(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new Error(`User ${id} not found`);
    }

    return rowToUser(result.rows[0]);
  }

  async findOrCreate(input: CreateUserInput): Promise<{ user: User; created: boolean }> {
    return withTransaction(async (client) => {
      // Try to find existing user
      const existing = await client.query<{
        id: string;
        oauth_provider: OAuthProvider;
        oauth_subject: string;
        email: string;
        email_verified: boolean;
        display_name: string | null;
        avatar_url: string | null;
        refresh_token_hash: string | null;
        is_active: boolean;
        created_at: Date;
        updated_at: Date;
        last_login_at: Date | null;
      }>(
        'SELECT * FROM users WHERE oauth_provider = $1 AND oauth_subject = $2 FOR UPDATE',
        [input.oauthProvider, input.oauthSubject]
      );

      if (existing.rows.length > 0) {
        // Update profile info from provider
        const updated = await client.query<{
          id: string;
          oauth_provider: OAuthProvider;
          oauth_subject: string;
          email: string;
          email_verified: boolean;
          display_name: string | null;
          avatar_url: string | null;
          refresh_token_hash: string | null;
          is_active: boolean;
          created_at: Date;
          updated_at: Date;
          last_login_at: Date | null;
        }>(
          `UPDATE users SET
            email = $1,
            email_verified = $2,
            display_name = COALESCE($3, display_name),
            avatar_url = COALESCE($4, avatar_url),
            last_login_at = NOW()
           WHERE id = $5
           RETURNING *`,
          [
            input.email,
            input.emailVerified,
            input.displayName,
            input.avatarUrl,
            existing.rows[0].id,
          ]
        );

        return { user: rowToUser(updated.rows[0]), created: false };
      }

      // Create new user
      const created = await client.query<{
        id: string;
        oauth_provider: OAuthProvider;
        oauth_subject: string;
        email: string;
        email_verified: boolean;
        display_name: string | null;
        avatar_url: string | null;
        refresh_token_hash: string | null;
        is_active: boolean;
        created_at: Date;
        updated_at: Date;
        last_login_at: Date | null;
      }>(
        `INSERT INTO users (oauth_provider, oauth_subject, email, email_verified, display_name, avatar_url, last_login_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`,
        [
          input.oauthProvider,
          input.oauthSubject,
          input.email,
          input.emailVerified,
          input.displayName ?? null,
          input.avatarUrl ?? null,
        ]
      );

      const user = rowToUser(created.rows[0]);

      logger.info(
        {
          eventType: 'user.created',
          userId: user.id,
          email: user.email,
          oauthProvider: user.oauthProvider,
        },
        'User created'
      );

      return { user, created: true };
    });
  }
}

// Export singleton instance
export const userRepository = new UserRepository();
