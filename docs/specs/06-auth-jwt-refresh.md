# Spec 06: JWT Refresh Token System

**Domain:** Backend
**Agent:** `backend-dev`
**Depends On:** 05-auth-google-oauth
**Estimated Complexity:** Medium

---

## Objective

Implement secure refresh token handling with HttpOnly cookies, token rotation, and server-side invalidation on logout.

---

## Deliverables

### 1. Updated Auth Service

Add to `apps/api/src/auth/auth.service.ts`:

```typescript
import { createHash, randomBytes } from 'crypto';

// ... existing imports and code ...

export interface FullTokenResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string; // Only returned on initial auth, not refresh
}

@Injectable()
export class AuthService {
  // ... existing code ...

  /**
   * Generate both access and refresh tokens
   */
  async generateFullTokens(
    user: { id: string; email: string; userRoles: Array<{ role: { name: string } }> },
  ): Promise<FullTokenResponse> {
    const accessToken = this.generateAccessToken(user);
    const refreshToken = await this.createRefreshToken(user.id);

    return {
      accessToken: accessToken.token,
      expiresIn: accessToken.expiresIn,
      refreshToken,
    };
  }

  /**
   * Generate access token only
   */
  private generateAccessToken(
    user: { id: string; email: string; userRoles: Array<{ role: { name: string } }> },
  ) {
    const roles = user.userRoles.map((ur) => ur.role.name);

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      roles,
    };

    const accessTtlMinutes = this.config.get<number>('jwt.accessTtlMinutes');

    return {
      token: this.jwtService.sign(payload),
      expiresIn: accessTtlMinutes * 60,
    };
  }

  /**
   * Create a new refresh token
   */
  private async createRefreshToken(userId: string): Promise<string> {
    const refreshTtlDays = this.config.get<number>('jwt.refreshTtlDays');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + refreshTtlDays);

    // Generate random token
    const token = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);

    // Store hashed token in database
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
      },
    });

    this.logger.debug(`Created refresh token for user: ${userId}`);

    return token;
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<FullTokenResponse> {
    const tokenHash = this.hashToken(refreshToken);

    // Find valid refresh token
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            userRoles: {
              include: { role: true },
            },
          },
        },
      },
    });

    if (!storedToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Check if revoked
    if (storedToken.revokedAt) {
      // Potential token reuse attack - revoke all tokens for user
      await this.revokeAllUserTokens(storedToken.userId);
      this.logger.warn(
        `Refresh token reuse detected for user: ${storedToken.userId}`,
      );
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    // Check if expired
    if (storedToken.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token has expired');
    }

    // Check if user is active
    if (!storedToken.user.isActive) {
      throw new UnauthorizedException('User account is deactivated');
    }

    // Rotate token - revoke old one, create new one
    await this.prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { revokedAt: new Date() },
    });

    // Generate new tokens
    const newRefreshToken = await this.createRefreshToken(storedToken.userId);
    const accessToken = this.generateAccessToken(storedToken.user);

    return {
      accessToken: accessToken.token,
      expiresIn: accessToken.expiresIn,
      refreshToken: newRefreshToken,
    };
  }

  /**
   * Logout - revoke refresh token
   */
  async logout(userId: string, refreshToken?: string): Promise<void> {
    if (refreshToken) {
      // Revoke specific token
      const tokenHash = this.hashToken(refreshToken);
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash, userId },
        data: { revokedAt: new Date() },
      });
    } else {
      // Revoke all tokens for user
      await this.revokeAllUserTokens(userId);
    }

    this.logger.log(`User logged out: ${userId}`);
  }

  /**
   * Revoke all refresh tokens for a user
   */
  async revokeAllUserTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Clean up expired tokens (run periodically)
   */
  async cleanupExpiredTokens(): Promise<number> {
    const result = await this.prisma.refreshToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },
          { revokedAt: { not: null } },
        ],
      },
    });

    this.logger.log(`Cleaned up ${result.count} expired/revoked tokens`);
    return result.count;
  }

  /**
   * Hash token for storage
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  // Update handleGoogleLogin to return full tokens
  async handleGoogleLogin(profile: GoogleProfile): Promise<FullTokenResponse> {
    // ... existing user provisioning code ...

    // At the end, use generateFullTokens instead of generateTokens
    return this.generateFullTokens(freshUser!);
  }
}
```

### 2. Updated Auth Controller

Update `apps/api/src/auth/auth.controller.ts`:

```typescript
import {
  Controller,
  Get,
  Post,
  UseGuards,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { FastifyReply, FastifyRequest } from 'fastify';

import { AuthService, GoogleProfile } from './auth.service';
import { GoogleOAuthGuard } from './guards/google-oauth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';

const REFRESH_TOKEN_COOKIE = 'refresh_token';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/api/auth',
  maxAge: 14 * 24 * 60 * 60 * 1000, // 14 days in ms
};

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('providers')
  @Public()
  @ApiOperation({ summary: 'Get enabled OAuth providers' })
  getProviders() {
    return this.authService.getEnabledProviders();
  }

  @Get('google')
  @Public()
  @UseGuards(GoogleOAuthGuard)
  @ApiOperation({ summary: 'Initiate Google OAuth flow' })
  googleAuth() {
    // Guard redirects to Google
  }

  @Get('google/callback')
  @Public()
  @UseGuards(GoogleOAuthGuard)
  @ApiOperation({ summary: 'Google OAuth callback' })
  async googleCallback(
    @Req() req: FastifyRequest & { user: GoogleProfile },
    @Res() res: FastifyReply,
  ) {
    const tokens = await this.authService.handleGoogleLogin(req.user);

    // Set refresh token in HttpOnly cookie
    res.setCookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken!, COOKIE_OPTIONS);

    // Redirect to frontend with access token only
    const redirectUrl = new URL('/auth/callback', process.env.APP_URL);
    redirectUrl.searchParams.set('token', tokens.accessToken);
    redirectUrl.searchParams.set('expiresIn', tokens.expiresIn.toString());

    return res.redirect(302, redirectUrl.toString());
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'New access token' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE];

    if (!refreshToken) {
      throw new UnauthorizedException('No refresh token provided');
    }

    const tokens = await this.authService.refreshAccessToken(refreshToken);

    // Set new refresh token in cookie (rotation)
    res.setCookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken!, COOKIE_OPTIONS);

    // Return new access token
    return {
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
    };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get current user details' })
  async getMe(@CurrentUser('id') userId: string) {
    return this.authService.getCurrentUser(userId);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Logout current user' })
  async logout(
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE];

    await this.authService.logout(userId, refreshToken);

    // Clear refresh token cookie
    res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/api/auth' });

    return;
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Logout from all devices' })
  async logoutAll(
    @CurrentUser('id') userId: string,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    await this.authService.revokeAllUserTokens(userId);

    // Clear refresh token cookie
    res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/api/auth' });

    return;
  }
}
```

### 3. Cookie Plugin Setup

Update `apps/api/src/main.ts`:

```typescript
import fastifyCookie from '@fastify/cookie';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );

  // Register cookie plugin
  await app.register(fastifyCookie, {
    secret: process.env.COOKIE_SECRET || process.env.JWT_SECRET,
  });

  // ... rest of setup ...
}
```

### 4. Token Cleanup Scheduled Task

Create `apps/api/src/auth/tasks/token-cleanup.task.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuthService } from '../auth.service';

@Injectable()
export class TokenCleanupTask {
  private readonly logger = new Logger(TokenCleanupTask.name);

  constructor(private readonly authService: AuthService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleCron() {
    this.logger.log('Running token cleanup task');
    const count = await this.authService.cleanupExpiredTokens();
    this.logger.log(`Token cleanup completed: ${count} tokens removed`);
  }
}
```

Update `apps/api/src/auth/auth.module.ts`:

```typescript
import { ScheduleModule } from '@nestjs/schedule';
import { TokenCleanupTask } from './tasks/token-cleanup.task';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    // ... other imports
  ],
  providers: [
    // ... other providers
    TokenCleanupTask,
  ],
})
export class AuthModule {}
```

---

## Additional Dependencies

Add to `apps/api/package.json`:

```json
{
  "dependencies": {
    "@fastify/cookie": "^9.x",
    "@nestjs/schedule": "^4.x"
  }
}
```

---

## Security Considerations

### Token Rotation
- Each refresh creates a new token and invalidates the old one
- Prevents token replay attacks
- Detects token reuse (potential theft)

### HttpOnly Cookies
- Refresh tokens stored in HttpOnly cookies
- Not accessible to JavaScript (XSS protection)
- SameSite=Lax for CSRF protection

### Token Reuse Detection
- If a revoked token is used, all user tokens are revoked
- Indicates potential token theft
- User must re-authenticate

---

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/auth/refresh` | POST | Cookie | Refresh access token |
| `/api/auth/logout` | POST | JWT | Logout (revoke current token) |
| `/api/auth/logout-all` | POST | JWT | Logout all devices |

---

## Cookie Details

| Property | Value | Reason |
|----------|-------|--------|
| httpOnly | true | Prevent XSS access |
| secure | true (prod) | HTTPS only in production |
| sameSite | lax | CSRF protection |
| path | /api/auth | Only sent to auth endpoints |
| maxAge | 14 days | Match refresh token TTL |

---

## Acceptance Criteria

- [ ] Refresh token stored in HttpOnly cookie after OAuth callback
- [ ] `POST /api/auth/refresh` returns new access token
- [ ] Refresh token is rotated on each refresh
- [ ] Old refresh token is invalidated after rotation
- [ ] Reuse of revoked token triggers revocation of all user tokens
- [ ] `POST /api/auth/logout` clears cookie and revokes token
- [ ] `POST /api/auth/logout-all` revokes all user tokens
- [ ] Expired tokens are cleaned up daily
- [ ] Deactivated users cannot refresh tokens

---

## Notes

- Access tokens are short-lived (15 min default)
- Refresh tokens are long-lived (14 days default)
- Token cleanup runs daily at 3 AM to remove expired/revoked tokens
- In development, secure=false allows HTTP cookies
