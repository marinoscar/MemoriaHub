import { createHmac, timingSafeEqual } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * MediaUrlSigningService
 *
 * Issues and verifies short-lived, HMAC-signed, SAME-ORIGIN media URLs of the
 * form:
 *
 *   /api/media/blob?k=<urlencoded storageKey>&exp=<unixSeconds>&sig=<hex hmac>
 *
 * These replace cross-origin R2 (AWS SigV4) presigned URLs for BROWSER-FACING
 * media (thumbnails + full-res originals). Because `<img>` / `<video>` cannot
 * attach an `Authorization` header and this app holds the access token in
 * memory (not a cookie), the byte-proxy endpoint authorizes via this HMAC
 * token itself rather than the normal JWT guard.
 *
 * Security posture: the HMAC binds to the EXACT storage key, so a holder of one
 * signed URL cannot forge a URL for a different object. This mirrors today's
 * posture — an R2 presigned URL is already a bearer link to a single blob with
 * a ~1h expiry.
 *
 * The secret comes from `media.urlSigningSecret` (env `MEDIA_URL_SIGNING_SECRET`,
 * falling back to `JWT_SECRET`). TTL from `media.proxyUrlTtlSeconds`
 * (env `MEDIA_PROXY_URL_TTL_SECONDS`, default 3600). The feature is gated by
 * `media.proxyEnabled` (env `MEDIA_PROXY_ENABLED`, default true) — when
 * disabled, callers fall back to direct provider presigned URLs.
 */
@Injectable()
export class MediaUrlSigningService {
  private readonly logger = new Logger(MediaUrlSigningService.name);

  /** Whether browser-facing signers should route through the same-origin proxy. */
  readonly enabled: boolean;

  /** Signed-URL lifetime in seconds; also used as the proxy Cache-Control max-age. */
  readonly ttlSeconds: number;

  private readonly secret: string;

  constructor(config: ConfigService) {
    this.enabled = config.get<boolean>('media.proxyEnabled', true);
    this.ttlSeconds = config.get<number>('media.proxyUrlTtlSeconds', 3600);
    this.secret = config.get<string>('media.urlSigningSecret', '') || '';

    if (this.enabled && !this.secret) {
      // No secret and no JWT fallback — signatures would be unverifiable.
      this.logger.warn(
        'MEDIA_PROXY_ENABLED is on but no MEDIA_URL_SIGNING_SECRET / JWT_SECRET is set; signed media URLs cannot be verified.',
      );
    }
  }

  /**
   * Build a same-origin, HMAC-signed proxy URL for the given storage key.
   * Returns a relative path (resolved against the current origin by the browser),
   * so it works behind the same-origin Nginx routing regardless of host.
   */
  signBlobUrl(storageKey: string): string {
    const exp = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    const sig = this.computeSig(storageKey, exp);
    const params = new URLSearchParams({ k: storageKey, exp: String(exp), sig });
    return `/api/media/blob?${params.toString()}`;
  }

  /**
   * Verify a signed blob request. Returns true only when the signature matches
   * (timing-safe) AND the token has not expired.
   *
   * Reads ONLY the three named parameters — any extra query param injected by a
   * corporate proxy (e.g. Zscaler's `_sm_nck`) is not part of the signed input
   * and is therefore harmless.
   */
  verify(storageKey: string, exp: number, sig: string): boolean {
    if (!storageKey || !sig) return false;
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
      return false;
    }

    const expected = this.computeSig(storageKey, exp);

    let a: Buffer;
    let b: Buffer;
    try {
      a = Buffer.from(expected, 'hex');
      b = Buffer.from(sig, 'hex');
    } catch {
      return false;
    }

    if (a.length === 0 || a.length !== b.length) {
      return false;
    }

    return timingSafeEqual(a, b);
  }

  private computeSig(storageKey: string, exp: number): string {
    return createHmac('sha256', this.secret)
      .update(`${storageKey}\n${exp}`)
      .digest('hex');
  }
}
