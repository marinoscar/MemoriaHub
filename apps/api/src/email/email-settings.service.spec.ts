/**
 * Unit tests for EmailSettingsService.
 *
 * Tests:
 *   - getMaskedSettings() never returns the smtpPassword ciphertext/plaintext
 *   - passwordConfigured / passwordLast4 reflect the stored (encrypted) password
 *   - updateSettings() encrypts a new password and preserves the stored one
 *     when the field is blank/omitted
 *
 * SECRETS_ENCRYPTION_KEY is set to a valid test value so encrypt/decrypt
 * round-trips work, mirroring apps/api/src/geo/geo-settings.service.spec.ts.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EmailSettingsService } from './email-settings.service';
import { EmailService } from './email.service';
import { SesEmailProvider } from './providers/ses-email.provider';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { encryptSecret, decryptSecret } from '../common/crypto/secret-cipher';

const VALID_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';

describe('EmailSettingsService', () => {
  let service: EmailSettingsService;
  let mockSystemSettings: { getSettings: jest.Mock; patchSettings: jest.Mock };
  let mockEmailService: { sendEmail: jest.Mock };
  let mockSesProvider: { sesCredentialAvailable: jest.Mock };
  let originalKey: string | undefined;

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

  beforeEach(async () => {
    mockSystemSettings = {
      getSettings: jest.fn().mockResolvedValue({}),
      patchSettings: jest.fn().mockResolvedValue(undefined),
    };
    mockEmailService = { sendEmail: jest.fn() };
    mockSesProvider = { sesCredentialAvailable: jest.fn().mockResolvedValue(false) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailSettingsService,
        { provide: SystemSettingsService, useValue: mockSystemSettings },
        { provide: EmailService, useValue: mockEmailService },
        { provide: SesEmailProvider, useValue: mockSesProvider },
      ],
    }).compile();

    service = module.get<EmailSettingsService>(EmailSettingsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // getMaskedSettings
  // -------------------------------------------------------------------------

  describe('getMaskedSettings', () => {
    it('never exposes smtpPassword in the response', async () => {
      const ciphertext = encryptSecret('super-secret-app-password');
      mockSystemSettings.getSettings.mockResolvedValue({
        email: {
          provider: 'smtp',
          enabled: true,
          fromAddress: 'noreply@example.com',
          fromName: null,
          smtpHost: 'smtp.example.com',
          smtpPort: 587,
          smtpUseTls: true,
          smtpUsername: 'user',
          smtpPassword: ciphertext,
        },
      });

      const result = await service.getMaskedSettings();

      const str = JSON.stringify(result);
      expect(str).not.toContain('smtpPassword');
      expect(str).not.toContain(ciphertext);
      expect(str).not.toContain('super-secret-app-password');
    });

    it('returns passwordConfigured:true and the correct last4 when a password is stored', async () => {
      const ciphertext = encryptSecret('my-app-password-9999');
      mockSystemSettings.getSettings.mockResolvedValue({
        email: {
          provider: 'smtp',
          enabled: true,
          fromAddress: 'noreply@example.com',
          smtpHost: 'smtp.example.com',
          smtpPassword: ciphertext,
        },
      });

      const result = await service.getMaskedSettings();

      expect(result.smtp.passwordConfigured).toBe(true);
      expect(result.smtp.passwordLast4).toBe('9999');
    });

    it('returns passwordConfigured:false and passwordLast4:null when no password is stored', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        email: {
          provider: 'smtp',
          enabled: true,
          fromAddress: 'noreply@example.com',
        },
      });

      const result = await service.getMaskedSettings();

      expect(result.smtp.passwordConfigured).toBe(false);
      expect(result.smtp.passwordLast4).toBeNull();
    });

    it('returns passwordLast4:null (not throw) when the stored ciphertext is malformed', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        email: {
          provider: 'smtp',
          enabled: true,
          fromAddress: 'noreply@example.com',
          smtpPassword: 'not-valid-ciphertext',
        },
      });

      const result = await service.getMaskedSettings();

      // passwordConfigured only reflects presence of the field, not validity
      expect(result.smtp.passwordConfigured).toBe(true);
      expect(result.smtp.passwordLast4).toBeNull();
    });

    it('reports sesCredentialAvailable from the SES provider', async () => {
      mockSesProvider.sesCredentialAvailable.mockResolvedValue(true);
      mockSystemSettings.getSettings.mockResolvedValue({ email: null });

      const result = await service.getMaskedSettings();

      expect(result.sesCredentialAvailable).toBe(true);
    });

    it('defaults provider/enabled/fromAddress when settings.email is null', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({ email: null });

      const result = await service.getMaskedSettings();

      expect(result.provider).toBeNull();
      expect(result.enabled).toBe(false);
      expect(result.fromAddress).toBeNull();
      expect(result.credentialSource).toBeNull();
    });

    it('reports credentialSource ses:reuses-s3 for the ses provider', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        email: { provider: 'ses', enabled: true, fromAddress: 'a@b.com' },
      });

      const result = await service.getMaskedSettings();

      expect(result.credentialSource).toBe('ses:reuses-s3');
    });

    it('reports credentialSource smtp:inline for the smtp provider', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        email: { provider: 'smtp', enabled: true, fromAddress: 'a@b.com' },
      });

      const result = await service.getMaskedSettings();

      expect(result.credentialSource).toBe('smtp:inline');
    });
  });

  // -------------------------------------------------------------------------
  // updateSettings
  // -------------------------------------------------------------------------

  describe('updateSettings', () => {
    it('encrypts a new non-empty smtpPassword before persisting', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({ email: {} });

      await service.updateSettings(
        {
          provider: 'smtp',
          enabled: true,
          smtpHost: 'smtp.example.com',
          smtpPassword: 'brand-new-plaintext-password',
        } as any,
        'user-1',
      );

      expect(mockSystemSettings.patchSettings).toHaveBeenCalledTimes(1);
      const [patch] = mockSystemSettings.patchSettings.mock.calls[0];
      const persisted = patch.email.smtpPassword;

      expect(persisted).toBeDefined();
      expect(persisted).not.toBe('brand-new-plaintext-password');
      expect(decryptSecret(persisted)).toBe('brand-new-plaintext-password');
    });

    it('omits smtpPassword from the patch when blank, preserving the stored value', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({ email: {} });

      await service.updateSettings(
        {
          provider: 'smtp',
          enabled: true,
          smtpHost: 'smtp.example.com',
          smtpPassword: '',
        } as any,
        'user-1',
      );

      const [patch] = mockSystemSettings.patchSettings.mock.calls[0];
      expect(patch.email).not.toHaveProperty('smtpPassword');
    });

    it('omits smtpPassword from the patch when omitted entirely', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({ email: {} });

      await service.updateSettings(
        {
          provider: 'smtp',
          enabled: true,
          smtpHost: 'smtp.example.com',
        } as any,
        'user-1',
      );

      const [patch] = mockSystemSettings.patchSettings.mock.calls[0];
      expect(patch.email).not.toHaveProperty('smtpPassword');
    });

    it('returns the masked settings after persisting', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        email: { provider: 'smtp', enabled: true, fromAddress: 'noreply@example.com' },
      });

      const result = await service.updateSettings(
        { provider: 'smtp', enabled: true } as any,
        'user-1',
      );

      expect(result).toHaveProperty('provider');
      expect(JSON.stringify(result)).not.toContain('smtpPassword');
    });
  });

  // -------------------------------------------------------------------------
  // sendTest
  // -------------------------------------------------------------------------

  describe('sendTest', () => {
    it('returns ok:true with messageId on success', async () => {
      mockEmailService.sendEmail.mockResolvedValue({ success: true, messageId: 'test-msg-1' });

      const result = await service.sendTest('someone@example.com');

      expect(mockEmailService.sendEmail).toHaveBeenCalledWith(
        'someone@example.com',
        'membership-confirmation',
        expect.any(Object),
      );
      expect(result).toEqual({ ok: true, messageId: 'test-msg-1', error: undefined });
    });

    it('returns ok:false with error on failure', async () => {
      mockEmailService.sendEmail.mockResolvedValue({ success: false, error: 'email_disabled' });

      const result = await service.sendTest('someone@example.com');

      expect(result).toEqual({ ok: false, messageId: undefined, error: 'email_disabled' });
    });
  });
});
