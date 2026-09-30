/** BroadcastDeliveryService (issue #488): one recipient, the selected channels only. */
import { BroadcastDeliveryService } from './broadcast-delivery.service';

function build() {
  const notifications = { emit: jest.fn().mockResolvedValue(undefined) };
  const email = { sendEmail: jest.fn().mockResolvedValue({ success: true, messageId: 'm' }) };
  const config = { get: jest.fn().mockReturnValue('https://app.test/') };
  const svc = new BroadcastDeliveryService(notifications as never, email as never, config as never);
  return { svc, notifications, email };
}

const content = {
  id: 'b-1',
  title: 'T',
  body: 'B',
  link: '/memories',
  ctaLabel: 'Open',
  critical: false,
  channels: ['inbox', 'push', 'email'],
};
const me = { id: 'u-1', email: 'u@x.test' };

describe('BroadcastDeliveryService', () => {
  it('writes the inbox row (push allowed) and sends the email with an absolute CTA', async () => {
    const t = build();
    const res = await t.svc.deliver(content, me);
    expect(t.notifications.emit).toHaveBeenCalledWith({
      userId: 'u-1',
      circleId: null,
      type: 'admin_broadcast',
      title: 'T',
      body: 'B',
      link: '/memories',
      data: { broadcastId: 'b-1', ctaLabel: 'Open', critical: false },
      skipPush: false,
    });
    expect(t.email.sendEmail).toHaveBeenCalledWith('u@x.test', 'broadcast', {
      title: 'T',
      body: 'B',
      critical: false,
      ctaUrl: 'https://app.test/memories',
      ctaLabel: 'Open',
    });
    expect(res.email).toEqual({ success: true, messageId: 'm' });
  });

  it('uses the critical type and skips push when push is not selected', async () => {
    const t = build();
    await t.svc.deliver({ ...content, critical: true, channels: ['inbox'] }, me);
    expect(t.notifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin_broadcast_critical', skipPush: true }),
    );
    expect(t.email.sendEmail).not.toHaveBeenCalled();
  });

  it('email-only writes no inbox row', async () => {
    const t = build();
    const res = await t.svc.deliver({ ...content, channels: ['email'], link: null }, me);
    expect(t.notifications.emit).not.toHaveBeenCalled();
    expect(t.email.sendEmail.mock.calls[0][2]).not.toHaveProperty('ctaUrl');
    expect(res.email?.success).toBe(true);
  });
});
