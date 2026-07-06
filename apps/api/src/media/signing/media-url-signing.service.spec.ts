import { ConfigService } from '@nestjs/config';
import { MediaUrlSigningService } from './media-url-signing.service';

/**
 * Builds a MediaUrlSigningService with a stubbed ConfigService.
 */
function build(overrides: Record<string, unknown> = {}): MediaUrlSigningService {
  const values: Record<string, unknown> = {
    'media.proxyEnabled': true,
    'media.proxyUrlTtlSeconds': 3600,
    'media.urlSigningSecret': 'test-secret-abcdefghijklmnopqrstuvwxyz',
    ...overrides,
  };
  const config = {
    get: jest.fn((key: string, def?: unknown) =>
      key in values ? values[key] : def,
    ),
  } as unknown as ConfigService;
  return new MediaUrlSigningService(config);
}

describe('MediaUrlSigningService', () => {
  describe('signBlobUrl', () => {
    it('produces a same-origin /api/media/blob path with k, exp, sig', () => {
      const svc = build();
      const url = svc.signBlobUrl('circle/abc/thumb.jpg');
      expect(url.startsWith('/api/media/blob?')).toBe(true);
      const qs = new URLSearchParams(url.split('?')[1]);
      expect(qs.get('k')).toBe('circle/abc/thumb.jpg');
      expect(Number(qs.get('exp'))).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(qs.get('sig')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('round-trips: a freshly signed URL verifies', () => {
      const svc = build();
      const url = svc.signBlobUrl('key/with spaces/and?weird=chars');
      const qs = new URLSearchParams(url.split('?')[1]);
      const k = qs.get('k')!;
      const exp = Number(qs.get('exp'));
      const sig = qs.get('sig')!;
      expect(k).toBe('key/with spaces/and?weird=chars');
      expect(svc.verify(k, exp, sig)).toBe(true);
    });
  });

  describe('verify', () => {
    it('rejects a tampered storage key (HMAC binds to the exact key)', () => {
      const svc = build();
      const url = svc.signBlobUrl('key/original.jpg');
      const qs = new URLSearchParams(url.split('?')[1]);
      const exp = Number(qs.get('exp'));
      const sig = qs.get('sig')!;
      expect(svc.verify('key/other.jpg', exp, sig)).toBe(false);
    });

    it('rejects an expired token', () => {
      const svc = build();
      const past = Math.floor(Date.now() / 1000) - 10;
      // Compute a valid sig for the expired exp by signing then swapping exp is
      // not possible; instead re-sign with a service that mints past exp.
      const svcPast = build({ 'media.proxyUrlTtlSeconds': -10 });
      const url = svcPast.signBlobUrl('key/x.jpg');
      const qs = new URLSearchParams(url.split('?')[1]);
      const exp = Number(qs.get('exp'));
      const sig = qs.get('sig')!;
      expect(exp).toBeLessThanOrEqual(past + 20);
      // Signature is valid but token is expired → reject.
      expect(svc.verify('key/x.jpg', exp, sig)).toBe(false);
    });

    it('rejects a garbage / non-hex signature without throwing', () => {
      const svc = build();
      const exp = Math.floor(Date.now() / 1000) + 100;
      expect(svc.verify('key/x.jpg', exp, 'not-hex-!!!')).toBe(false);
      expect(svc.verify('key/x.jpg', exp, '')).toBe(false);
    });

    it('rejects a signature of the wrong length', () => {
      const svc = build();
      const exp = Math.floor(Date.now() / 1000) + 100;
      expect(svc.verify('key/x.jpg', exp, 'ab')).toBe(false);
    });

    it('rejects NaN / non-finite exp', () => {
      const svc = build();
      expect(svc.verify('key/x.jpg', NaN, 'a'.repeat(64))).toBe(false);
    });

    it('a URL signed with one secret does not verify under another', () => {
      const a = build({ 'media.urlSigningSecret': 'secret-A-aaaaaaaaaaaaaaaaaaaa' });
      const b = build({ 'media.urlSigningSecret': 'secret-B-bbbbbbbbbbbbbbbbbbbb' });
      const url = a.signBlobUrl('key/x.jpg');
      const qs = new URLSearchParams(url.split('?')[1]);
      expect(
        b.verify('key/x.jpg', Number(qs.get('exp')), qs.get('sig')!),
      ).toBe(false);
    });
  });

  describe('feature flag', () => {
    it('reflects media.proxyEnabled', () => {
      expect(build({ 'media.proxyEnabled': true }).enabled).toBe(true);
      expect(build({ 'media.proxyEnabled': false }).enabled).toBe(false);
    });

    it('falls back to JWT secret path via config default (no crash when unset)', () => {
      const svc = build({ 'media.urlSigningSecret': '' });
      // Still functional: sign + verify round-trips with the empty-string secret.
      const url = svc.signBlobUrl('key/x.jpg');
      const qs = new URLSearchParams(url.split('?')[1]);
      expect(svc.verify('key/x.jpg', Number(qs.get('exp')), qs.get('sig')!)).toBe(true);
    });
  });
});
