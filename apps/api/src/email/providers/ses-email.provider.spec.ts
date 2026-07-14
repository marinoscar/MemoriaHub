/**
 * Unit tests for SesEmailProvider.
 *
 * SesEmailProvider stores no secret of its own — it reuses the AWS credentials
 * configured for the S3 storage provider (`storage_provider_credentials` where
 * provider='s3'). These tests verify:
 *   - sesCredentialAvailable() reflects whether an s3 credential row with an
 *     accessKeyId + encryptedKey exists
 *   - send() decrypts the s3 credential's encryptedKey via decryptSecret and
 *     builds an SESv2Client with it (mocked — no real AWS call happens)
 *   - send() never throws; provider/region misconfiguration is captured into
 *     an EmailSendResult
 *
 * SECRETS_ENCRYPTION_KEY is set to a valid test value so encrypt/decrypt
 * round-trips work, mirroring apps/api/src/geo/geo-settings.service.spec.ts.
 * The @aws-sdk/client-sesv2 module is mocked entirely (see
 * src/face/providers/rekognition.provider.spec.ts for the same pattern) so no
 * real AWS call is ever made.
 */

const mockSend = jest.fn();
const SendEmailCommandMock = jest.fn().mockImplementation((input) => input);

jest.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  SendEmailCommand: SendEmailCommandMock,
}));

import { SesEmailProvider } from './ses-email.provider';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import { encryptSecret } from '../../common/crypto/secret-cipher';
import { EmailMessage } from '../types/email.types';

const VALID_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';

describe('SesEmailProvider', () => {
  let provider: SesEmailProvider;
  let mockPrisma: MockPrismaService;
  let mockSystemSettings: { getSettings: jest.Mock };
  let originalKey: string | undefined;

  const testMessage: EmailMessage = {
    to: 'recipient@example.com',
    from: 'noreply@example.com',
    subject: 'Test subject',
    html: '<p>hello</p>',
    text: 'hello',
  };

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
    mockSend.mockReset();
    SendEmailCommandMock.mockClear();

    mockPrisma = createMockPrismaService();
    mockSystemSettings = { getSettings: jest.fn().mockResolvedValue({ email: { sesRegion: 'us-east-1' } }) };

    provider = new SesEmailProvider(
      mockPrisma as unknown as PrismaService,
      mockSystemSettings as unknown as SystemSettingsService,
    );
  });

  // ---------------------------------------------------------------------------
  // sesCredentialAvailable
  // ---------------------------------------------------------------------------

  describe('sesCredentialAvailable', () => {
    it('returns true when an s3 credential row has accessKeyId + encryptedKey', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue({
        accessKeyId: 'AKIA-test',
        encryptedKey: encryptSecret('s3-secret'),
      } as any);

      const result = await provider.sesCredentialAvailable();

      expect(result).toBe(true);
      expect(mockPrisma.storageProviderCredential.findUnique).toHaveBeenCalledWith({
        where: { provider: 's3' },
        select: { accessKeyId: true, encryptedKey: true },
      });
    });

    it('returns false when no s3 credential row exists', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null);

      const result = await provider.sesCredentialAvailable();

      expect(result).toBe(false);
    });

    it('returns false when the s3 credential row is missing accessKeyId', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue({
        accessKeyId: null,
        encryptedKey: encryptSecret('s3-secret'),
      } as any);

      const result = await provider.sesCredentialAvailable();

      expect(result).toBe(false);
    });

    it('returns false when the s3 credential row is missing encryptedKey', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue({
        accessKeyId: 'AKIA-test',
        encryptedKey: null,
      } as any);

      const result = await provider.sesCredentialAvailable();

      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // send
  // ---------------------------------------------------------------------------

  describe('send', () => {
    it('decrypts the s3 credential secret and builds the SES client with it, then returns success', async () => {
      const plainSecret = 'super-secret-aws-key';
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue({
        accessKeyId: 'AKIA-real',
        encryptedKey: encryptSecret(plainSecret),
        region: 'eu-west-1',
      } as any);
      mockSend.mockResolvedValue({ MessageId: 'ses-message-1' });

      const result = await provider.send(testMessage);

      expect(result).toEqual({ success: true, messageId: 'ses-message-1' });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('sends via SendEmailCommand with the message mapped into SES shape', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue({
        accessKeyId: 'AKIA-real',
        encryptedKey: encryptSecret('secret'),
        region: 'eu-west-1',
      } as any);
      mockSend.mockResolvedValue({ MessageId: 'ses-message-2' });

      await provider.send(testMessage);

      expect(SendEmailCommandMock).toHaveBeenCalledWith(
        expect.objectContaining({
          FromEmailAddress: testMessage.from,
          Destination: { ToAddresses: [testMessage.to] },
          Content: {
            Simple: {
              Subject: { Data: testMessage.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: testMessage.html, Charset: 'UTF-8' },
                Text: { Data: testMessage.text, Charset: 'UTF-8' },
              },
            },
          },
        }),
      );
    });

    it('falls back to the s3 credential region when email.sesRegion is not set', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({ email: { sesRegion: null } });
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue({
        accessKeyId: 'AKIA-real',
        encryptedKey: encryptSecret('secret'),
        region: 'ap-southeast-1',
      } as any);
      mockSend.mockResolvedValue({ MessageId: 'ses-message-3' });

      const result = await provider.send(testMessage);

      expect(result).toEqual({ success: true, messageId: 'ses-message-3' });
    });

    it('never throws and returns success:false when no s3 credential is configured', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null);

      const result = await provider.send(testMessage);

      expect(result.success).toBe(false);
      expect(result.error).toContain('AWS credentials');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('never throws and returns success:false when no region can be resolved', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({ email: { sesRegion: null } });
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue({
        accessKeyId: 'AKIA-real',
        encryptedKey: encryptSecret('secret'),
        region: null,
      } as any);

      const result = await provider.send(testMessage);

      expect(result.success).toBe(false);
      expect(result.error).toContain('region');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('never throws and returns success:false when the SES client rejects', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue({
        accessKeyId: 'AKIA-real',
        encryptedKey: encryptSecret('secret'),
        region: 'eu-west-1',
      } as any);
      mockSend.mockRejectedValue(new Error('SES throttled'));

      const result = await provider.send(testMessage);

      expect(result).toEqual({ success: false, error: 'SES throttled' });
    });
  });
});
