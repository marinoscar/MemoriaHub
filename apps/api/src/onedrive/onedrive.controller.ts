import {
  Controller,
  Get,
  Delete,
  Query,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { Auth } from '../auth/decorators/auth.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import {
  encodeConnectState,
  decodeConnectState,
} from '../auth/utils/oauth-state.util';
import { MicrosoftGraphClient } from './microsoft-graph.client';
import { OneDriveConnectionService } from './onedrive-connection.service';
import {
  OneDriveConnectionExpiredError,
  OneDriveNotConnectedError,
} from './onedrive.errors';
import {
  ListFoldersQueryDto,
  OneDriveConnectionStatusDto,
  OneDriveFolderDto,
} from './dto/onedrive.dto';

const ONEDRIVE_FEATURE = 'oneDriveImport';
/** Frontend surface the OAuth callback redirects back to. */
const FRONTEND_SETTINGS_PATH = '/settings/onedrive';

@ApiTags('OneDrive')
@Controller('onedrive')
export class OneDriveController {
  private readonly logger = new Logger(OneDriveController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly graphClient: MicrosoftGraphClient,
    private readonly connectionService: OneDriveConnectionService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  private async assertFeatureEnabled(): Promise<void> {
    const enabled = await this.systemSettings.isFeatureEnabled(ONEDRIVE_FEATURE);
    if (!enabled) {
      throw new BadRequestException('OneDrive Data Import is disabled');
    }
  }

  private get stateSecret(): string {
    return this.configService.get<string>('jwt.secret') ?? '';
  }

  /**
   * GET /onedrive/auth/start
   * Begin the Microsoft OAuth data-access grant. The signed state carries the
   * caller's userId so the public callback can recover who initiated the connect.
   */
  @Get('auth/start')
  @Auth({ permissions: [PERMISSIONS.ONEDRIVE_CONNECT] })
  @ApiOperation({
    summary: 'Start OneDrive OAuth connect flow',
    description:
      'Redirects the browser to Microsoft\'s OAuth authorize endpoint. The signed ' +
      '`state` parameter carries the initiating MemoriaHub user id (HMAC-SHA256).',
  })
  @ApiQuery({
    name: 'returnTo',
    required: false,
    description: 'Same-site relative path to return the user to after connecting.',
  })
  @ApiResponse({ status: 302, description: 'Redirects to Microsoft OAuth' })
  async authStart(
    @CurrentUser() user: RequestUser,
    @Res() res: FastifyReply,
    @Query('returnTo') returnTo?: string,
  ) {
    await this.assertFeatureEnabled();
    const state = encodeConnectState({ userId: user.id, returnTo }, this.stateSecret);
    const url = this.graphClient.buildAuthorizeUrl(state);
    return res.status(302).redirect(url);
  }

  /**
   * GET /onedrive/auth/callback
   * Public (the browser redirect from Microsoft carries no app JWT). Recovers the
   * userId from the signed state, exchanges the code, and upserts the connection.
   */
  @Public()
  @Get('auth/callback')
  @ApiOperation({
    summary: 'OneDrive OAuth callback',
    description:
      'Handles the Microsoft OAuth redirect: verifies the signed state, exchanges the ' +
      'authorization code for tokens, and stores the caller\'s connection.',
  })
  @ApiResponse({ status: 302, description: 'Redirects back to the frontend OneDrive settings page' })
  async authCallback(
    @Res() res: FastifyReply,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') oauthError?: string,
  ) {
    const appUrl = this.configService.get<string>('appUrl');
    const redirect = (params: Record<string, string>) => {
      const url = new URL(FRONTEND_SETTINGS_PATH, appUrl);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      return res.status(302).redirect(url.toString());
    };

    try {
      // Feature disabled: fail closed without leaking internals.
      if (!(await this.systemSettings.isFeatureEnabled(ONEDRIVE_FEATURE))) {
        return redirect({ error: 'feature_disabled' });
      }

      // Microsoft reported an error (e.g. user denied consent).
      if (oauthError) {
        this.logger.warn(`OneDrive OAuth callback returned error: ${oauthError}`);
        return redirect({ error: 'access_denied' });
      }

      if (!code) {
        return redirect({ error: 'missing_code' });
      }

      // Verify the signed state and recover the initiating user.
      const { userId } = decodeConnectState(state, this.stateSecret);
      if (!userId) {
        this.logger.warn('OneDrive OAuth callback rejected: invalid or missing state');
        return redirect({ error: 'invalid_state' });
      }

      const tokens = await this.graphClient.exchangeCodeForTokens(code);
      const profile = await this.graphClient.getUserProfile(tokens.accessToken);
      await this.connectionService.upsertFromCallback(userId, tokens, profile);

      return redirect({ connected: '1' });
    } catch (error) {
      this.logger.error(
        `OneDrive OAuth callback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return redirect({ error: 'connect_failed' });
    }
  }

  /**
   * GET /onedrive/connection
   * Return the caller's connection status. Ungated (reading status is harmless).
   */
  @Get('connection')
  @Auth({ permissions: [PERMISSIONS.ONEDRIVE_CONNECT] })
  @ApiOperation({ summary: 'Get OneDrive connection status' })
  @ApiResponse({ status: 200, type: OneDriveConnectionStatusDto })
  async getConnection(@CurrentUser() user: RequestUser): Promise<OneDriveConnectionStatusDto> {
    return this.connectionService.getStatus(user.id);
  }

  /**
   * DELETE /onedrive/connection
   * Disconnect the caller's OneDrive account. Imported media is unaffected.
   */
  @Delete('connection')
  @Auth({ permissions: [PERMISSIONS.ONEDRIVE_CONNECT] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disconnect OneDrive' })
  @ApiResponse({ status: 204, description: 'Connection removed' })
  async deleteConnection(@CurrentUser() user: RequestUser): Promise<void> {
    await this.connectionService.disconnect(user.id);
  }

  /**
   * GET /onedrive/folders?path=
   * List subfolders under `path` (or the drive root) for the folder picker.
   */
  @Get('folders')
  @Auth({ permissions: [PERMISSIONS.ONEDRIVE_CONNECT] })
  @ApiOperation({
    summary: 'List OneDrive folders',
    description: 'Proxies Microsoft Graph\'s children listing, returning only folders.',
  })
  @ApiResponse({ status: 200, type: [OneDriveFolderDto] })
  async listFolders(
    @CurrentUser() user: RequestUser,
    @Query() query: ListFoldersQueryDto,
  ): Promise<OneDriveFolderDto[]> {
    await this.assertFeatureEnabled();
    try {
      const accessToken = await this.connectionService.getFreshAccessToken(user.id);
      const children = await this.graphClient.listChildren(accessToken, query.path ?? null, {
        foldersOnly: true,
      });
      return children.map((c) => ({ id: c.id, name: c.name, path: c.path }));
    } catch (error) {
      if (error instanceof OneDriveNotConnectedError) {
        throw new BadRequestException('No OneDrive connection — connect an account first');
      }
      if (error instanceof OneDriveConnectionExpiredError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
