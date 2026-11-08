/**
 * RETRO-D3 (#576): MemoriaHub's emails are notification events now
 * (`notifyAddress('circles.invitation', address, data)`). For specs written
 * against the old `sendEmailAsync(address, template, data)`, this builds a
 * `NotificationsService` stand-in whose `notifyAddress` forwards to such a mock
 * under the event's bound template name. Synchronous like the old call, so a
 * throwing mock throws at the call site.
 */
export const EMAIL_EVENT_TEMPLATES: Readonly<Record<string, string>> = {
  'circles.invitation': 'circle-invitation',
  'circles.membership_confirmed': 'membership-confirmation',
  'memories.digest': 'memory-digest',
};

export function notificationsForwardingTo(email: { sendEmailAsync: (...args: any[]) => unknown }) {
  return {
    notifyAddress: jest.fn((eventKey: string, address: string, data: unknown) => {
      email.sendEmailAsync(address, EMAIL_EVENT_TEMPLATES[eventKey] ?? eventKey, data);
      return Promise.resolve();
    }),
  };
}
