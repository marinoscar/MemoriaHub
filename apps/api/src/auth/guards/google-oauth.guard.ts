import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { encodeOAuthState, sanitizeReturnTo } from '../utils/oauth-state.util';

/**
 * Google OAuth guard for Fastify
 *
 * Initiates the Google OAuth flow when applied to a route.
 * Used on both the initial OAuth endpoint and the callback endpoint.
 *
 * Note: Passport OAuth strategies expect Express-style request/response objects.
 * This guard overrides getRequest/getResponse to return raw Node.js http objects
 * that Passport can work with. After authentication, it copies the user back
 * to the Fastify request so controllers can access req.user normally.
 *
 * The guard also carries an optional `returnTo` destination through the OAuth
 * round-trip by encoding it in the signed `state` parameter. The callback
 * controller decodes it and appends it to the post-login redirect URL.
 */
@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google') {
  constructor(private readonly configService: ConfigService) {
    super();
  }

  /**
   * Encode an optional `returnTo` query param into the signed OAuth `state`.
   * Called for both the init route (where we encode) and the callback route
   * (where passport ignores this option and reads `req.query.state` instead).
   */
  override getAuthenticateOptions(context: ExecutionContext) {
    const request = context
      .switchToHttp()
      .getRequest<{ query?: Record<string, unknown> }>();
    const returnTo = sanitizeReturnTo(request.query?.['returnTo']);
    const secret = this.configService.get<string>('jwt.secret') ?? '';
    return { state: encodeOAuthState(returnTo, secret) };
  }

  override getRequest(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    // Return the raw Node.js IncomingMessage for Passport compatibility
    return request.raw || request;
  }

  getResponse(context: ExecutionContext) {
    const response = context.switchToHttp().getResponse();
    // Return the raw Node.js ServerResponse for Passport compatibility
    return response.raw || response;
  }

  override handleRequest<TUser = unknown>(
    err: Error | null,
    user: TUser | false,
    _info: unknown,
    context: ExecutionContext,
  ): TUser {
    if (err || !user) {
      throw err || new Error('Authentication failed');
    }

    // Copy user from raw request to Fastify request so controllers can access it
    const fastifyRequest = context.switchToHttp().getRequest();
    fastifyRequest.user = user;

    return user;
  }
}
