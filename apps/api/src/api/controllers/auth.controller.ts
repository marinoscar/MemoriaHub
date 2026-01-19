import type { Request, Response, NextFunction } from 'express';
import type { OAuthProvider, ApiResponse, OAuthProviderInfo, RefreshTokenResponse, UserDTO } from '@memoriahub/shared';
import { authService, getOAuthProvider, getAvailableProviders } from '../../services/auth/index.js';
import { oauthConfig } from '../../config/index.js';

/**
 * Authentication controller
 * Single Responsibility: Only handles HTTP request/response for auth
 */
export class AuthController {
  /**
   * GET /api/auth/providers
   * List available OAuth providers
   */
  async getProviders(_req: Request, res: Response): Promise<void> {
    const providers = getAvailableProviders();
    const response: ApiResponse<OAuthProviderInfo[]> = { data: providers };
    res.json(response);
  }

  /**
   * GET /api/auth/:provider
   * Initiate OAuth flow by redirecting to provider
   */
  async initiateOAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const providerId = req.params.provider as OAuthProvider;
      const provider = getOAuthProvider(providerId);

      // Get optional redirect URI from query params
      const frontendRedirectUri = req.query.redirect_uri as string | undefined;

      const { authUrl } = authService.initiateOAuth(provider, frontendRedirectUri);

      // Redirect to OAuth provider
      res.redirect(authUrl);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/auth/:provider/callback
   * Handle OAuth callback from provider
   */
  async handleCallback(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const providerId = req.params.provider as OAuthProvider;
      const provider = getOAuthProvider(providerId);

      const code = req.query.code as string;
      const state = req.query.state as string;

      // Check for error from provider
      if (req.query.error) {
        const errorDesc = req.query.error_description || req.query.error;
        const redirectUrl = new URL('/auth/callback', oauthConfig.frontendUrl);
        redirectUrl.searchParams.set('error', String(errorDesc));
        res.redirect(redirectUrl.toString());
        return;
      }

      const result = await authService.handleOAuthCallback(provider, code, state);

      // Build redirect URL with tokens
      const redirectUrl = new URL('/auth/callback', result.frontendRedirectUri);
      redirectUrl.searchParams.set('access_token', result.tokens.accessToken);
      redirectUrl.searchParams.set('refresh_token', result.tokens.refreshToken);
      redirectUrl.searchParams.set('expires_in', String(result.tokens.expiresIn));

      res.redirect(redirectUrl.toString());
    } catch (error) {
      // Redirect to frontend with error
      const redirectUrl = new URL('/auth/callback', oauthConfig.frontendUrl);
      redirectUrl.searchParams.set('error', error instanceof Error ? error.message : 'Authentication failed');
      res.redirect(redirectUrl.toString());
    }
  }

  /**
   * POST /api/auth/refresh
   * Refresh access token
   */
  async refreshToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { refreshToken } = req.body as { refreshToken: string };

      const result = await authService.refreshToken(refreshToken);

      const response: ApiResponse<RefreshTokenResponse> = {
        data: {
          accessToken: result.accessToken,
          tokenType: 'Bearer',
          expiresIn: result.expiresIn,
        },
      };

      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/auth/logout
   * Logout user
   */
  async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
        return;
      }

      const { refreshToken } = req.body as { refreshToken?: string };

      await authService.logout(req.user.id, refreshToken);

      const response: ApiResponse<{ message: string }> = {
        data: { message: 'Logged out successfully' },
      };

      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/auth/me
   * Get current user
   */
  async getCurrentUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
        return;
      }

      const user = await authService.getCurrentUser(req.user.id);

      const response: ApiResponse<UserDTO> = { data: user };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }
}

// Export singleton instance
export const authController = new AuthController();
