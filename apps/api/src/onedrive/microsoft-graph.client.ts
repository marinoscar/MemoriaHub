import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { RateLimitError, parseRetryAfterMs } from '../enrichment/rate-limit.error';
import { OneDriveConnectionExpiredError } from './onedrive.errors';

/** OAuth scopes requested for the data-access (import) grant. */
export const ONEDRIVE_SCOPES = 'offline_access Files.Read User.Read';

/** Result of an authorization-code or refresh-token grant. */
export interface OneDriveTokens {
  accessToken: string;
  /** Present on a code exchange; may be absent on a refresh that does not rotate. */
  refreshToken?: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Space-delimited granted scopes. */
  scopes: string;
}

/** Minimal Microsoft account profile used for display. */
export interface OneDriveUserProfile {
  id: string;
  email: string;
}

/** A normalized OneDrive DriveItem. */
export interface OneDriveDriveItem {
  id: string;
  name: string;
  /** Best-effort full path relative to the drive root (leading '/'), or the name when unknown. */
  path: string;
  size: number;
  isFolder: boolean;
  /** MIME type from the `file` facet; null for folders. */
  mimeType: string | null;
}

interface GraphTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GraphDriveItemRaw {
  id: string;
  name: string;
  size?: number;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  parentReference?: { path?: string };
}

interface GraphChildrenResponse {
  value?: GraphDriveItemRaw[];
  '@odata.nextLink'?: string;
}

/**
 * Thin wrapper over the slices of Microsoft Graph the OneDrive Data Import
 * feature needs. NOT a Passport strategy — it captures and refreshes the
 * data-access grant (refresh token) directly. See docs/specs/onedrive-import.md §3.
 */
@Injectable()
export class MicrosoftGraphClient {
  private readonly logger = new Logger(MicrosoftGraphClient.name);
  private static readonly GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

  constructor(private readonly configService: ConfigService) {}

  private get tenant(): string {
    return this.configService.get<string>('microsoft.tenant') || 'common';
  }

  private get clientId(): string {
    return this.configService.get<string>('microsoft.clientId') || '';
  }

  private get clientSecret(): string {
    return this.configService.get<string>('microsoft.clientSecret') || '';
  }

  private get redirectUri(): string {
    return this.configService.get<string>('microsoft.redirectUri') || '';
  }

  private tokenEndpoint(): string {
    return `https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/token`;
  }

  /**
   * Build the Microsoft OAuth authorize URL the browser is redirected to.
   * The signed `state` carries the initiating MemoriaHub user (see the controller).
   */
  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      response_mode: 'query',
      scope: ONEDRIVE_SCOPES,
      state,
    });
    return `https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  /** Exchange an authorization code for tokens. */
  async exchangeCodeForTokens(code: string): Promise<OneDriveTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri,
      scope: ONEDRIVE_SCOPES,
    });
    return this.requestToken(body);
  }

  /**
   * Mint a fresh access token from a refresh token. Microsoft may rotate the
   * refresh token, in which case the new value is returned in `refreshToken`.
   * Throws {@link OneDriveConnectionExpiredError} on `invalid_grant`.
   */
  async refreshAccessToken(refreshToken: string): Promise<OneDriveTokens> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      scope: ONEDRIVE_SCOPES,
    });
    return this.requestToken(body);
  }

  private async requestToken(body: URLSearchParams): Promise<OneDriveTokens> {
    const response = await fetch(this.tokenEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (response.status === 429) {
      throw new RateLimitError(
        'Microsoft token endpoint returned HTTP 429',
        parseRetryAfterMs(response.headers.get('retry-after')) ?? undefined,
        'onedrive',
      );
    }

    const data = (await response.json().catch(() => ({}))) as GraphTokenResponse;

    if (!response.ok || data.error) {
      // invalid_grant => the refresh token is revoked/expired; surface as reconnect-required.
      if (data.error === 'invalid_grant') {
        throw new OneDriveConnectionExpiredError(
          `OneDrive connection expired — please reconnect (${data.error_description ?? 'invalid_grant'})`,
        );
      }
      const detail = data.error_description || data.error || `HTTP ${response.status}`;
      throw new Error(`Microsoft token request failed: ${detail}`);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      scopes: data.scope || ONEDRIVE_SCOPES,
    };
  }

  /** Fetch the connected Microsoft account's id and email for display. */
  async getUserProfile(accessToken: string): Promise<OneDriveUserProfile> {
    const response = await this.graphGet(`${MicrosoftGraphClient.GRAPH_BASE}/me`, accessToken);
    const data = (await response.json()) as {
      id: string;
      mail?: string | null;
      userPrincipalName?: string | null;
    };
    return {
      id: data.id,
      email: data.mail ?? data.userPrincipalName ?? '',
    };
  }

  /**
   * List the children of a folder. `folderPathOrNull` = null lists the drive
   * root; otherwise it is treated as a path relative to the root. Follows
   * `@odata.nextLink` fully before returning.
   */
  async listChildren(
    accessToken: string,
    folderPathOrNull: string | null,
    opts: { foldersOnly?: boolean; imagesAndVideosOnly?: boolean } = {},
  ): Promise<OneDriveDriveItem[]> {
    const encodedPath = folderPathOrNull
      ? folderPathOrNull.split('/').filter(Boolean).map(encodeURIComponent).join('/')
      : null;
    let url: string | undefined = encodedPath
      ? `${MicrosoftGraphClient.GRAPH_BASE}/me/drive/root:/${encodedPath}:/children`
      : `${MicrosoftGraphClient.GRAPH_BASE}/me/drive/root/children`;

    const items: OneDriveDriveItem[] = [];

    while (url) {
      const response = await this.graphGet(url, accessToken);
      const data = (await response.json()) as GraphChildrenResponse;

      for (const raw of data.value ?? []) {
        const isFolder = !!raw.folder;
        const mimeType = raw.file?.mimeType ?? null;

        if (opts.foldersOnly && !isFolder) continue;
        // imagesAndVideosOnly returns ONLY image/video FILES — folders and other
        // file types are both excluded. Callers that need folders (e.g. the
        // recursive enumeration in OneDriveImportService) omit this option and
        // partition the unfiltered listing on `isFolder` themselves.
        if (opts.imagesAndVideosOnly && (isFolder || !this.isImageOrVideo(mimeType))) continue;

        items.push({
          id: raw.id,
          name: raw.name,
          path: this.buildItemPath(raw),
          size: raw.size ?? 0,
          isFolder,
          mimeType,
        });
      }

      url = data['@odata.nextLink'];
    }

    return items;
  }

  /**
   * Download a DriveItem's content. Graph returns a redirect to a
   * pre-authenticated URL; `fetch` follows it by default. The WHATWG
   * ReadableStream returned by `fetch` is converted to a Node {@link Readable}
   * here at the HTTP boundary, so callers always consume a Node stream.
   */
  async downloadContent(accessToken: string, itemId: string): Promise<Readable> {
    const url = `${MicrosoftGraphClient.GRAPH_BASE}/me/drive/items/${encodeURIComponent(itemId)}/content`;
    const response = await this.graphGet(url, accessToken);
    if (!response.body) {
      throw new Error(`Microsoft Graph returned an empty body for item ${itemId}`);
    }
    return Readable.fromWeb(response.body as any);
  }

  /**
   * Perform an authenticated Graph GET, mapping HTTP 429 onto the enrichment
   * rate-limit deferral path and 401 onto a reconnect-required error.
   */
  private async graphGet(url: string, accessToken: string): Promise<Response> {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 429) {
      throw new RateLimitError(
        `Microsoft Graph returned HTTP 429 for ${url}`,
        parseRetryAfterMs(response.headers.get('retry-after')) ?? undefined,
        'onedrive',
      );
    }

    if (response.status === 401) {
      throw new OneDriveConnectionExpiredError(
        'Microsoft Graph rejected the access token (401) — please reconnect',
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Microsoft Graph request failed (HTTP ${response.status}): ${detail.slice(0, 500)}`);
    }

    return response;
  }

  private isImageOrVideo(mimeType: string | null): boolean {
    if (!mimeType) return false;
    return mimeType.startsWith('image/') || mimeType.startsWith('video/');
  }

  /**
   * Derive a display path from the DriveItem's parentReference. Graph reports
   * `parentReference.path` like `/drive/root:/Photos/2024`; we strip the
   * `/drive/root:` prefix and append the item name.
   */
  private buildItemPath(raw: GraphDriveItemRaw): string {
    const parentPath = raw.parentReference?.path;
    if (!parentPath) return `/${raw.name}`;
    const rootMarker = 'root:';
    const idx = parentPath.indexOf(rootMarker);
    const relative = idx >= 0 ? parentPath.slice(idx + rootMarker.length) : parentPath;
    const decoded = (() => {
      try {
        return decodeURIComponent(relative);
      } catch {
        return relative;
      }
    })();
    const base = decoded.endsWith('/') ? decoded.slice(0, -1) : decoded;
    return `${base}/${raw.name}`;
  }
}
