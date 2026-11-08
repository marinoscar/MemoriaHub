/**
 * AppEmailSender (RETRO-D2, #570): never throws, no-ops when unconfigured,
 * passes the digest's per-recipient headers to the transport, and builds the
 * From header from the platform settings.
 */

import { configureEmailRendering } from '@marinoscar/platform-api/email';

import { registerMemoriaHubEmailTemplates } from '../../email-templates';
import { AppEmailSender, EMAIL_DISABLED, isEmailConfigured } from './app-email.sender';
import { EMAIL_MODULE_OPTIONS } from './email.options';

configureEmailRendering(EMAIL_MODULE_OPTIONS);
registerMemoriaHubEmailTemplates();

const CONFIGURED = { provider: 'smtp', enabled: true, fromAddress: 'family@example.test', fromName: 'Family Photos' };

function build(settings: unknown = CONFIGURED, send = jest.fn().mockResolvedValue({ success: true, messageId: 'm-1' })) {
  const emailSettings = {
    get: typeof settings === 'function' ? (settings as jest.Mock) : jest.fn().mockResolvedValue(settings),
  };
  const transports = { send };
  return { sender: new AppEmailSender(emailSettings as never, transports as never), send };
}

const DIGEST = {
  circleName: 'Circle Alpha',
  memories: [
    { id: 'm1', type: 'trip', typeLabel: 'Trip', title: 'A trip', itemCount: 3, url: 'https://app.example.test/memories/m1' },
  ],
  memoriesUrl: 'https://app.example.test/memories',
  unsubscribeUrl: 'https://app.example.test/api/public/memories/digest-unsubscribe/tok',
};

describe('isEmailConfigured', () => {
  it('needs the switch, a transport and a sender', () => {
    expect(isEmailConfigured(CONFIGURED as never)).toBe(true);
    expect(isEmailConfigured({ ...CONFIGURED, enabled: false } as never)).toBe(false);
    expect(isEmailConfigured({ ...CONFIGURED, provider: null } as never)).toBe(false);
    expect(isEmailConfigured({ ...CONFIGURED, fromAddress: undefined } as never)).toBe(false);
  });
});

describe('AppEmailSender', () => {
  it('sends through the transport with the From header and the rendered parts', async () => {
    const { sender, send } = build();
    const result = await sender.sendEmail('person-b@example.test', 'membership-confirmation', {
      circleName: 'Circle Alpha',
      role: 'viewer',
      viewUrl: 'https://app.example.test/circles/c1',
    });
    expect(result).toEqual({ success: true, messageId: 'm-1' });
    const [settings, message] = send.mock.calls[0]!;
    expect(settings).toBe(CONFIGURED);
    expect(message).toMatchObject({ to: 'person-b@example.test', from: '"Family Photos" <family@example.test>' });
    expect(message.subject).toContain('Circle Alpha');
    expect(message.text.length).toBeGreaterThan(0);
  });

  it('passes the digest List-Unsubscribe pair to the transport (RFC 8058)', async () => {
    const { sender, send } = build();
    await sender.sendEmail('person-b@example.test', 'memory-digest', DIGEST);
    expect(send.mock.calls[0]![1].headers).toMatchObject({
      'List-Unsubscribe': `<${DIGEST.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('is a graceful no-op when email is not configured', async () => {
    const { sender, send } = build({ provider: null, enabled: false });
    await expect(sender.sendEmail('x@example.test', 'memory-digest', DIGEST)).resolves.toEqual({
      success: false,
      error: EMAIL_DISABLED,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws: an unreadable settings row or a throwing transport is a failed result', async () => {
    const unreadable = build(jest.fn().mockRejectedValue(new Error('Invalid email settings')));
    await expect(unreadable.sender.sendEmail('x@example.test', 'memory-digest', DIGEST)).resolves.toMatchObject({
      success: false,
      error: 'Invalid email settings',
    });
    const throwing = build(CONFIGURED, jest.fn().mockRejectedValue(new Error('socket hang up')));
    await expect(throwing.sender.sendEmail('x@example.test', 'memory-digest', DIGEST)).resolves.toMatchObject({
      success: false,
    });
  });

  it('sendEmailAsync is fire-and-forget: it returns synchronously and swallows failures', async () => {
    const { sender } = build(CONFIGURED, jest.fn().mockRejectedValue(new Error('down')));
    expect(sender.sendEmailAsync('x@example.test', 'memory-digest', DIGEST)).toBeUndefined();
    await new Promise((r) => setImmediate(r));
  });

  it('isConfigured is false, not a throw, for an unreadable row', async () => {
    const { sender } = build(jest.fn().mockRejectedValue(new Error('bad row')));
    await expect(sender.isConfigured()).resolves.toBe(false);
  });
});
