# Spec 05: Google OAuth Authentication

**Domain:** Backend
**Agent:** `backend-dev`
**Depends On:** 04-api-core-setup, 03-database-seeds
**Estimated Complexity:** High

---

## Objective

Implement Google OAuth 2.0 authentication using Passport.js, including user provisioning, identity linking, and session initiation with JWT tokens.

---

## Deliverables

### 1. Auth Module Structure

```
apps/api/src/auth/
├── auth.module.ts
├── auth.controller.ts
├── auth.service.ts
├── strategies/
│   └── google.strategy.ts
├── guards/
│   ├── google-oauth.guard.ts
│   └── jwt-auth.guard.ts
├── decorators/
│   └── current-user.decorator.ts
└── dto/
    ├── auth-provider.dto.ts
    └── auth-user.dto.ts
```

### 2. Auth Module

Update `apps/api/src/auth/auth.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleStrategy } from './strategies/google.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret'),
        signOptions: {
          expiresIn: `${config.get<number>('jwt.accessTtlMinutes')}m`,
        },
      }),
    }),
    CommonModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, GoogleStrategy, JwtStrategy],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
```

### 3. Auth Service

Create `apps/api/src/auth/auth.service.ts`:

```typescript
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AdminBootstrapService } from '../common/services/admin-bootstrap.service';
import { DEFAULT_ROLE, ROLES } from '../common/constants/roles.constants';
import { DEFAULT_USER_SETTINGS } from '../common/types/settings.types';

export interface GoogleProfile {
  id: string;
  email: string;
  displayName: string;
  picture?: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  roles: string[];
}

export interface TokenResponse {
  accessToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly adminBootstrap: AdminBootstrapService,
  ) {}

  /**
   * Handle Google OAuth callback - provision or update user
   */
  async handleGoogleLogin(profile: GoogleProfile): Promise<TokenResponse> {
    const { id: providerSubject, email, displayName, picture } = profile;

    // Find existing identity
    let identity = await this.prisma.userIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider: 'google',
          providerSubject,
        },
      },
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

    let user = identity?.user;

    if (!user) {
      // Check if user exists by email (link identity)
      user = await this.prisma.user.findUnique({
        where: { email },
        include: {
          userRoles: {
            include: { role: true },
          },
        },
      });

      if (user) {
        // Link new identity to existing user
        await this.prisma.userIdentity.create({
          data: {
            userId: user.id,
            provider: 'google',
            providerSubject,
            providerEmail: email,
          },
        });
        this.logger.log(`Linked Google identity to existing user: ${email}`);
      }
    }

    if (!user) {
      // Create new user
      user = await this.createNewUser(email, displayName, picture, providerSubject);
    } else {
      // Update provider fields (don't overwrite user overrides)
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          providerDisplayName: displayName,
          providerProfileImageUrl: picture,
        },
      });
    }

    // Check if user is active
    if (!user.isActive) {
      throw new UnauthorizedException('User account is deactivated');
    }

    // Get fresh user with roles
    const freshUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      include: {
        userRoles: {
          include: { role: true },
        },
      },
    });

    return this.generateTokens(freshUser!);
  }

  /**
   * Create a new user with default role and settings
   */
  private async createNewUser(
    email: string,
    displayName: string,
    picture: string | undefined,
    providerSubject: string,
  ) {
    // Get default role
    const defaultRole = await this.prisma.role.findUnique({
      where: { name: DEFAULT_ROLE },
    });

    if (!defaultRole) {
      throw new Error('Default role not found - run database seeds');
    }

    // Check if should grant admin
    const shouldBeAdmin = await this.adminBootstrap.shouldGrantAdminRole(email);
    const roleToAssign = shouldBeAdmin
      ? await this.prisma.role.findUnique({ where: { name: ROLES.ADMIN } })
      : defaultRole;

    // Create user with identity, role, and settings in transaction
    const user = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email,
          providerDisplayName: displayName,
          providerProfileImageUrl: picture,
          identities: {
            create: {
              provider: 'google',
              providerSubject,
              providerEmail: email,
            },
          },
          userRoles: {
            create: {
              roleId: roleToAssign!.id,
            },
          },
          userSettings: {
            create: {
              value: DEFAULT_USER_SETTINGS,
            },
          },
        },
        include: {
          userRoles: {
            include: { role: true },
          },
        },
      });

      return newUser;
    });

    this.logger.log(
      `Created new user: ${email} with role: ${roleToAssign!.name}`,
    );

    return user;
  }

  /**
   * Generate JWT access token
   */
  private generateTokens(
    user: { id: string; email: string; userRoles: Array<{ role: { name: string } }> },
  ): TokenResponse {
    const roles = user.userRoles.map((ur) => ur.role.name);

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      roles,
    };

    const accessTtlMinutes = this.config.get<number>('jwt.accessTtlMinutes');

    return {
      accessToken: this.jwtService.sign(payload),
      expiresIn: accessTtlMinutes * 60, // seconds
    };
  }

  /**
   * Validate JWT payload and return user
   */
  async validateJwtPayload(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: {
                  include: { permission: true },
                },
              },
            },
          },
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid or inactive user');
    }

    return user;
  }

  /**
   * Get enabled auth providers
   */
  getEnabledProviders(): Array<{ name: string; authUrl: string }> {
    const providers: Array<{ name: string; authUrl: string }> = [];

    // Google is always enabled in MVP
    if (this.config.get<string>('google.clientId')) {
      providers.push({
        name: 'google',
        authUrl: '/api/auth/google',
      });
    }

    return providers;
  }

  /**
   * Get current user details
   */
  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: {
                  include: { permission: true },
                },
              },
            },
          },
        },
        userSettings: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Extract roles and permissions
    const roles = user.userRoles.map((ur) => ur.role.name);
    const permissions = [
      ...new Set(
        user.userRoles.flatMap((ur) =>
          ur.role.rolePermissions.map((rp) => rp.permission.name),
        ),
      ),
    ];

    // Compute effective display name and image
    const effectiveDisplayName = user.displayName || user.providerDisplayName;
    const useProviderImage = user.userSettings?.value?.profile?.useProviderImage ?? true;
    const effectiveImageUrl = useProviderImage
      ? user.providerProfileImageUrl
      : user.profileImageUrl || user.providerProfileImageUrl;

    return {
      id: user.id,
      email: user.email,
      displayName: effectiveDisplayName,
      profileImageUrl: effectiveImageUrl,
      isActive: user.isActive,
      roles,
      permissions,
      createdAt: user.createdAt,
    };
  }
}
```

### 4. Google Strategy

Create `apps/api/src/auth/strategies/google.strategy.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback, Profile } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(private readonly config: ConfigService) {
    super({
      clientID: config.get<string>('google.clientId'),
      clientSecret: config.get<string>('google.clientSecret'),
      callbackURL: config.get<string>('google.callbackUrl'),
      scope: ['email', 'profile'],
    });
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): Promise<void> {
    const { id, emails, displayName, photos } = profile;

    const user = {
      id,
      email: emails?.[0]?.value,
      displayName,
      picture: photos?.[0]?.value,
    };

    done(null, user);
  }
}
```

### 5. JWT Strategy

Create `apps/api/src/auth/strategies/jwt.strategy.ts`:

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService, JwtPayload } from '../auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly config: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.secret'),
    });
  }

  async validate(payload: JwtPayload) {
    return this.authService.validateJwtPayload(payload);
  }
}
```

### 6. Auth Guards

Create `apps/api/src/auth/guards/google-oauth.guard.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google') {}
```

Create `apps/api/src/auth/guards/jwt-auth.guard.ts`:

```typescript
import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }
}
```

### 7. Decorators

Create `apps/api/src/auth/decorators/current-user.decorator.ts`:

```typescript
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;

    return data ? user?.[data] : user;
  },
);
```

Create `apps/api/src/auth/decorators/public.decorator.ts`:

```typescript
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

### 8. Auth Controller

Create `apps/api/src/auth/auth.controller.ts`:

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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { FastifyReply, FastifyRequest } from 'fastify';

import { AuthService, GoogleProfile } from './auth.service';
import { GoogleOAuthGuard } from './guards/google-oauth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('providers')
  @Public()
  @ApiOperation({ summary: 'Get enabled OAuth providers' })
  @ApiResponse({ status: 200, description: 'List of enabled providers' })
  getProviders() {
    return this.authService.getEnabledProviders();
  }

  @Get('google')
  @Public()
  @UseGuards(GoogleOAuthGuard)
  @ApiOperation({ summary: 'Initiate Google OAuth flow' })
  @ApiResponse({ status: 302, description: 'Redirect to Google' })
  googleAuth() {
    // Guard redirects to Google
  }

  @Get('google/callback')
  @Public()
  @UseGuards(GoogleOAuthGuard)
  @ApiOperation({ summary: 'Google OAuth callback' })
  @ApiResponse({ status: 302, description: 'Redirect to app with token' })
  async googleCallback(
    @Req() req: FastifyRequest & { user: GoogleProfile },
    @Res() res: FastifyReply,
  ) {
    const tokens = await this.authService.handleGoogleLogin(req.user);

    // Redirect to frontend with token
    // In production, consider using a more secure token passing mechanism
    const redirectUrl = new URL('/auth/callback', process.env.APP_URL);
    redirectUrl.searchParams.set('token', tokens.accessToken);
    redirectUrl.searchParams.set('expiresIn', tokens.expiresIn.toString());

    return res.redirect(302, redirectUrl.toString());
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get current user details' })
  @ApiResponse({ status: 200, description: 'Current user information' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getMe(@CurrentUser('id') userId: string) {
    return this.authService.getCurrentUser(userId);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Logout current user' })
  @ApiResponse({ status: 204, description: 'Logged out successfully' })
  async logout(@CurrentUser('id') userId: string) {
    // JWT is stateless - client should discard token
    // Refresh token invalidation handled in spec 06
    return;
  }
}
```

---

## Additional Dependencies

Add to `apps/api/package.json`:

```json
{
  "dependencies": {
    "@nestjs/passport": "^10.x",
    "@nestjs/jwt": "^10.x",
    "passport": "^0.7.x",
    "passport-google-oauth20": "^2.x",
    "passport-jwt": "^4.x"
  },
  "devDependencies": {
    "@types/passport-google-oauth20": "^2.x",
    "@types/passport-jwt": "^4.x"
  }
}
```

---

## Environment Variables Required

```bash
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3535/api/auth/google/callback
JWT_SECRET=your-secret-min-32-chars
JWT_ACCESS_TTL_MINUTES=15
INITIAL_ADMIN_EMAIL=admin@example.com
APP_URL=http://localhost:3535
```

---

## Acceptance Criteria

- [ ] `GET /api/auth/providers` returns list of enabled providers
- [ ] `GET /api/auth/google` redirects to Google OAuth consent screen
- [ ] `GET /api/auth/google/callback` handles OAuth callback
- [ ] New users are created with default role (viewer)
- [ ] First user matching INITIAL_ADMIN_EMAIL gets admin role
- [ ] JWT access token is generated with correct claims
- [ ] `GET /api/auth/me` returns current user with roles/permissions
- [ ] Deactivated users cannot authenticate
- [ ] Provider display name and image are stored and updated
- [ ] User overrides are not overwritten on login

---

## Notes

- Google OAuth requires valid client credentials from Google Cloud Console
- The callback redirects to frontend with token in URL (simplest approach)
- For production, consider httpOnly cookie for tokens
- JWT contains user id, email, and roles for quick authorization checks
