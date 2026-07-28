/**
 * Unit tests for SmtpEmailProvider.
 *
 * These exist primarily as a regression guard around the nodemailer 6.x -> 9.x
 * upgrade (issue #216). Transactional sends are deliberately fire-and-forget —
 * `EmailService.sendEmailAsync` never lets a failed send fail the user-facing
 * action — so a broken transport surfaces only as a logged warning. That makes
 * a silent regression here very cheap to miss, hence the explicit assertions on
 * the `EmailSendResult` and on the TLS options handed to `createTransport`.
 *
 * The `nodemailer` module is mocked entirely, so no SMTP connection is ever
 * opened. SECRETS_ENCRYPTION_KEY is set to a valid test value so the stored
 * password ciphertext round-trips, mirroring ses-email.provider.spec.ts.
 */

const mockSendMail = jest.fn();
const mockCreateTransport = jest.fn(() => ({ sendMail: mockSendMail }));

jest.mock('nodemailer', () => ({
  createTransport: (...args: unknown[]) => mockCreateTransport(...(args as [])),
}));

import { SmtpEmailProvider } from './smtp-email.provider';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { encryptSecret } from '../../common/crypto/secret-cipher';
import { EmailMessage } from '../types/email.types';

const VALID_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';

describe('SmtpEmailProvider', () => {
  let provider: SmtpEmailProvider;
  let mockSystemSettings: { getSettings: jest.Mock };
  let originalKey: string | undefined;

  const testMessage: EmailMessage = {
    to: 'recipient@example.com',
    from: 'noreply@example.com',
    subject: 'Test subject',
    html: '<p>hello</p>',
    text: 'hello',
  };

  /** Build a settings object with the smtp.* shape the provider reads. */
  const smtpSettings = (overrides: Record<string, unknown> = {}) => ({
    email: {
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpUseTls: true,
      smtpUsername: 'mailer@example.com',
      smtpPassword: encryptSecret('smtp-secret'),
      ...overrides,
    },
  });

  beforeAll(() => {
    originalKey = process.env['SECRETS_ENCRYPTION_KEY'];
    process.env['SECRETS_ENCRYPTION_KEY'] = VALID_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env['SECRETS_ENCRYPTION_KEY'];
    } else {
      process.env['SECRETS_ENCRYPTION_KEY'] = originalKey;
    }
  });

  beforeEach(() => {
    mockSendMail.mockReset();
    mockCreateTransport.mockClear();
    mockCreateTransport.mockImplementation(() => ({ sendMail: mockSendMail }));

    mockSystemSettings = { getSettings: jest.fn().mockResolvedValue(smtpSettings()) };

    provider = new SmtpEmailProvider(
      mockSystemSettings as unknown as SystemSettingsService,
    );
  });

  // ---------------------------------------------------------------------------
  // Transport construction — the TLS surface nodemailer 9 tightened
  // ---------------------------------------------------------------------------

  describe('transport construction', () => {
    it('uses STARTTLS (requireTLS, not secure) on port 587', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'id-587' });

      await provider.send(testMessage);

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.example.com',
          port: 587,
          secure: false,
          requireTLS: true,
        }),
      );
    });

    it('uses implicit TLS (secure, not requireTLS) on port 465', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(smtpSettings({ smtpPort: 465 }));
      mockSendMail.mockResolvedValue({ messageId: 'id-465' });

      await provider.send(testMessage);

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ port: 465, secure: true, requireTLS: false }),
      );
    });

    it('does not require TLS when smtpUseTls is false on a non-465 port', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(smtpSettings({ smtpUseTls: false }));
      mockSendMail.mockResolvedValue({ messageId: 'id-plain' });

      await provider.send(testMessage);

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ secure: false, requireTLS: false }),
      );
    });

    it('decrypts the stored password ciphertext into the auth block', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'id-auth' });

      await provider.send(testMessage);

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: { user: 'mailer@example.com', pass: 'smtp-secret' },
        }),
      );
    });

    it('omits auth entirely when no username is configured', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        smtpSettings({ smtpUsername: null }),
      );
      mockSendMail.mockResolvedValue({ messageId: 'id-noauth' });

      await provider.send(testMessage);

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ auth: undefined }),
      );
    });

    it('defaults to port 587 when smtpPort is not set', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(smtpSettings({ smtpPort: null }));
      mockSendMail.mockResolvedValue({ messageId: 'id-default-port' });

      await provider.send(testMessage);

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ port: 587, secure: false, requireTLS: true }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Transport caching
  // ---------------------------------------------------------------------------

  describe('transport caching', () => {
    it('reuses one transport across sends when the config is unchanged', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'id-cached' });

      await provider.send(testMessage);
      await provider.send(testMessage);

      expect(mockCreateTransport).toHaveBeenCalledTimes(1);
      expect(mockSendMail).toHaveBeenCalledTimes(2);
    });

    it('rebuilds the transport when the effective config changes', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'id-rebuilt' });

      await provider.send(testMessage);
      mockSystemSettings.getSettings.mockResolvedValue(
        smtpSettings({ smtpHost: 'smtp2.example.com' }),
      );
      await provider.send(testMessage);

      expect(mockCreateTransport).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // send — must never throw; the caller treats it as fire-and-forget
  // ---------------------------------------------------------------------------

  describe('send', () => {
    it('returns success with the provider messageId on a delivered message', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'smtp-message-1' });

      const result = await provider.send(testMessage);

      expect(result).toEqual({ success: true, messageId: 'smtp-message-1' });
    });

    it('passes the message through unchanged to sendMail', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'smtp-message-2' });

      await provider.send(testMessage);

      expect(mockSendMail).toHaveBeenCalledWith({
        from: testMessage.from,
        to: testMessage.to,
        subject: testMessage.subject,
        html: testMessage.html,
        text: testMessage.text,
      });
    });

    it('never throws and returns success:false when SMTP is not configured', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({ email: { smtpHost: null } });

      const result = await provider.send(testMessage);

      expect(result.success).toBe(false);
      expect(result.error).toContain('SMTP host');
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('never throws and returns success:false when the transport rejects', async () => {
      mockSendMail.mockRejectedValue(new Error('535 auth failed'));

      const result = await provider.send(testMessage);

      expect(result).toEqual({ success: false, error: '535 auth failed' });
    });

    it('never throws when transport construction itself fails', async () => {
      mockCreateTransport.mockImplementation(() => {
        throw new Error('bad TLS options');
      });

      const result = await provider.send(testMessage);

      expect(result).toEqual({ success: false, error: 'bad TLS options' });
    });
  });
});
