/**
 * Unit tests for EmailService.
 *
 * EmailService.sendEmail() must NEVER throw — every failure path (feature
 * disabled, missing provider config, provider throwing) is captured into an
 * EmailSendResult. sendEmailAsync() is fire-and-forget and must never produce
 * an unhandled rejection.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EmailService } from './email.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { SesEmailProvider } from './providers/ses-email.provider';
import { SmtpEmailProvider } from './providers/smtp-email.provider';

describe('EmailService', () => {
  let service: EmailService;
  let mockSystemSettings: { getSettings: jest.Mock };
  let mockSesProvider: { send: jest.Mock };
  let mockSmtpProvider: { send: jest.Mock };

  const membershipData = {
    circleName: 'The Marins',
    circleDescription: 'Family photos',
    role: 'viewer',
    viewUrl: 'http://localhost:3535/circles/c1',
  };

  beforeEach(async () => {
    mockSystemSettings = { getSettings: jest.fn() };
    mockSesProvider = { send: jest.fn() };
    mockSmtpProvider = { send: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        { provide: SystemSettingsService, useValue: mockSystemSettings },
        { provide: SesEmailProvider, useValue: mockSesProvider },
        { provide: SmtpEmailProvider, useValue: mockSmtpProvider },
      ],
    }).compile();

    service = module.get<EmailService>(EmailService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Disabled / unconfigured
  // -------------------------------------------------------------------------

  describe('disabled / unconfigured settings', () => {
    it('returns email_disabled when settings.email is missing entirely', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({});

      const result = await service.sendEmail(
        'user@example.com',
        'membership-confirmation',
        membershipData,
      );

      expect(result).toEqual({ success: false, error: 'email_disabled' });
      expect(mockSesProvider.send).not.toHaveBeenCalled();
      expect(mockSmtpProvider.send).not.toHaveBeenCalled();
    });

    it('returns email_disabled when enabled is false', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        email: {
          enabled: false,
          provider: 'smtp',
          fromAddress: 'noreply@example.com',
        },
      });

      const result = await service.sendEmail(
        'user@example.com',
        'membership-confirmation',
        membershipData,
      );

      expect(result).toEqual({ success: false, error: 'email_disabled' });
      expect(mockSesProvider.send).not.toHaveBeenCalled();
      expect(mockSmtpProvider.send).not.toHaveBeenCalled();
    });

    it('returns email_disabled when provider is null', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        email: {
          enabled: true,
          provider: null,
          fromAddress: 'noreply@example.com',
        },
      });

      const result = await service.sendEmail(
        'user@example.com',
        'membership-confirmation',
        membershipData,
      );

      expect(result).toEqual({ success: false, error: 'email_disabled' });
      expect(mockSesProvider.send).not.toHaveBeenCalled();
      expect(mockSmtpProvider.send).not.toHaveBeenCalled();
    });

    it('returns email_disabled when fromAddress is missing', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        email: {
          enabled: true,
          provider: 'smtp',
          fromAddress: null,
        },
      });

      const result = await service.sendEmail(
        'user@example.com',
        'membership-confirmation',
        membershipData,
      );

      expect(result).toEqual({ success: false, error: 'email_disabled' });
      expect(mockSesProvider.send).not.toHaveBeenCalled();
      expect(mockSmtpProvider.send).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // SMTP provider path
  // -------------------------------------------------------------------------

  describe('enabled + provider: smtp', () => {
    it('renders the template and calls the SMTP provider with a full message', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        email: {
          enabled: true,
          provider: 'smtp',
          fromAddress: 'noreply@example.com',
          fromName: null,
        },
      });
      mockSmtpProvider.send.mockResolvedValue({ success: true, messageId: 'smtp-123' });

      const result = await service.sendEmail(
        'user@example.com',
        'membership-confirmation',
        membershipData,
      );

      expect(mockSmtpProvider.send).toHaveBeenCalledTimes(1);
      const message = mockSmtpProvider.send.mock.calls[0][0];
      expect(message.to).toBe('user@example.com');
      expect(message.from).toBe('noreply@example.com');
      expect(typeof message.subject).toBe('string');
      expect(message.subject.length).toBeGreaterThan(0);
      expect(typeof message.html).toBe('string');
      expect(message.html.length).toBeGreaterThan(0);
      expect(typeof message.text).toBe('string');
      expect(message.text.length).toBeGreaterThan(0);

      expect(mockSesProvider.send).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, messageId: 'smtp-123' });
    });

    it('quotes a configured fromName in the From header', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        email: {
          enabled: true,
          provider: 'smtp',
          fromAddress: 'noreply@example.com',
          fromName: 'MemoriaHub',
        },
      });
      mockSmtpProvider.send.mockResolvedValue({ success: true, messageId: 'smtp-1' });

      await service.sendEmail('user@example.com', 'membership-confirmation', membershipData);

      const message = mockSmtpProvider.send.mock.calls[0][0];
      expect(message.from).toBe('"MemoriaHub" <noreply@example.com>');
    });

    it('never throws when the SMTP provider rejects, and maps the error', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        email: {
          enabled: true,
          provider: 'smtp',
          fromAddress: 'noreply@example.com',
        },
      });
      mockSmtpProvider.send.mockRejectedValue(new Error('SMTP connection refused'));

      const result = await service.sendEmail(
        'user@example.com',
        'membership-confirmation',
        membershipData,
      );

      expect(result).toEqual({ success: false, error: 'SMTP connection refused' });
    });

    it('never throws when systemSettings.getSettings itself rejects', async () => {
      mockSystemSettings.getSettings.mockRejectedValue(new Error('DB unavailable'));

      const result = await service.sendEmail(
        'user@example.com',
        'membership-confirmation',
        membershipData,
      );

      expect(result).toEqual({ success: false, error: 'DB unavailable' });
      expect(mockSmtpProvider.send).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // SES provider path
  // -------------------------------------------------------------------------

  describe('enabled + provider: ses', () => {
    it('calls the SES provider instead of SMTP', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        email: {
          enabled: true,
          provider: 'ses',
          fromAddress: 'noreply@example.com',
        },
      });
      mockSesProvider.send.mockResolvedValue({ success: true, messageId: 'ses-123' });

      const result = await service.sendEmail(
        'user@example.com',
        'membership-confirmation',
        membershipData,
      );

      expect(mockSesProvider.send).toHaveBeenCalledTimes(1);
      expect(mockSmtpProvider.send).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, messageId: 'ses-123' });
    });

    it('never throws when the SES provider rejects', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        email: {
          enabled: true,
          provider: 'ses',
          fromAddress: 'noreply@example.com',
        },
      });
      mockSesProvider.send.mockRejectedValue(new Error('SES throttled'));

      const result = await service.sendEmail(
        'user@example.com',
        'membership-confirmation',
        membershipData,
      );

      expect(result).toEqual({ success: false, error: 'SES throttled' });
    });
  });

  // -------------------------------------------------------------------------
  // sendEmailAsync
  // -------------------------------------------------------------------------

  describe('sendEmailAsync', () => {
    it('returns undefined synchronously (fire-and-forget)', () => {
      mockSystemSettings.getSettings.mockResolvedValue({});

      const result = service.sendEmailAsync(
        'user@example.com',
        'membership-confirmation',
        membershipData,
      );

      expect(result).toBeUndefined();
    });

    it('swallows a rejected provider send without an unhandled rejection', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        email: {
          enabled: true,
          provider: 'smtp',
          fromAddress: 'noreply@example.com',
        },
      });
      mockSmtpProvider.send.mockRejectedValue(new Error('boom'));

      expect(() => {
        service.sendEmailAsync('user@example.com', 'membership-confirmation', membershipData);
      }).not.toThrow();

      // Flush microtasks so the internal .catch() has a chance to run.
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockSmtpProvider.send).toHaveBeenCalled();
    });

    it('swallows a rejected getSettings() call without an unhandled rejection', async () => {
      mockSystemSettings.getSettings.mockRejectedValue(new Error('DB down'));

      expect(() => {
        service.sendEmailAsync('user@example.com', 'membership-confirmation', membershipData);
      }).not.toThrow();

      await new Promise((resolve) => setImmediate(resolve));
    });
  });
});
