/**
 * The two transactional templates and the registration (RETRO-D2, #570):
 * names permanent and registered, every interpolation escaped, links admitted
 * only through `safeUrl`, a text part that carries the same links.
 */

import {
  configureEmailRendering,
  findEmailTemplate,
  isEmailTemplateName,
  renderEmailTemplate,
} from '@marinoscar/platform-api/email';

import { EMAIL_MODULE_OPTIONS } from '../platform/email/email.options';
import { MEMORIAHUB_EMAIL_TEMPLATE_NAMES, registerMemoriaHubEmailTemplates } from './index';
import { circleInvitationEmail } from './circle-invitation.email';
import { membershipConfirmationEmail } from './membership-confirmation.email';

configureEmailRendering(EMAIL_MODULE_OPTIONS);
registerMemoriaHubEmailTemplates();

const HOSTILE = '<script>alert(1)</script>"&';

describe('registration', () => {
  it('registers the three permanent names', () => {
    expect([...MEMORIAHUB_EMAIL_TEMPLATE_NAMES]).toEqual(['circle-invitation', 'membership-confirmation', 'memory-digest']);
    for (const name of MEMORIAHUB_EMAIL_TEMPLATE_NAMES) {
      expect(isEmailTemplateName(name)).toBe(true);
      expect(findEmailTemplate(name)).toBeDefined();
    }
  });

  it('registering twice in-process is a no-op', () => {
    expect(() => registerMemoriaHubEmailTemplates()).not.toThrow();
  });

  it('renders by name with the MemoriaHub brand', () => {
    const rendered = renderEmailTemplate('membership-confirmation', {
      circleName: 'Circle Alpha',
      role: 'viewer',
      viewUrl: 'https://app.example.test/circles/c1',
    });
    expect(rendered.subject).toBe('You\'ve been added to "Circle Alpha" on MemoriaHub');
    expect(rendered.html.toLowerCase()).toContain('#1976d2');
  });
});

describe('circle-invitation', () => {
  const base = {
    circleName: 'Circle Alpha',
    inviterName: 'Person A',
    acceptUrl: 'https://app.example.test/activate?returnTo=%2Fcircles%2Fc1',
    recipientEmail: 'person-b@example.test',
  };

  it('renders subject, html and a text part with the accept link', () => {
    const r = circleInvitationEmail(base);
    expect(r.subject).toBe('You\'re invited to join "Circle Alpha" on MemoriaHub');
    expect(r.html).toContain('Accept Invitation');
    expect(r.html).toContain('https://app.example.test/activate?returnTo=%2Fcircles%2Fc1');
    expect(r.text).toContain('Sign in with person-b@example.test to accept.');
    expect(r.text).toContain(base.acceptUrl);
  });

  it('escapes the circle name, the inviter and the address', () => {
    const r = circleInvitationEmail({ ...base, circleName: HOSTILE, inviterName: HOSTILE, recipientEmail: HOSTILE });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
  });

  it('admits the decline link only through safeUrl', () => {
    expect(circleInvitationEmail({ ...base, declineUrl: 'https://app.example.test/decline' }).html).toContain(
      'https://app.example.test/decline',
    );
    const unsafe = circleInvitationEmail({ ...base, declineUrl: 'javascript:alert(1)' });
    expect(unsafe.html).not.toContain('javascript:');
    expect(unsafe.text).not.toContain('javascript:');
  });
});

describe('membership-confirmation', () => {
  it('names the role in words and escapes the description', () => {
    const r = membershipConfirmationEmail({
      circleName: 'Circle Alpha',
      circleDescription: HOSTILE,
      role: 'collaborator',
      viewUrl: 'https://app.example.test/circles/c1',
    });
    expect(r.html).toContain('Collaborator');
    expect(r.html).not.toContain('<script>');
    expect(r.text).toContain('Your role: Collaborator.');
    expect(r.text).toContain('https://app.example.test/circles/c1');
  });

  it('falls back to the raw role key and a generic summary for an unknown role', () => {
    const r = membershipConfirmationEmail({ circleName: 'C', role: 'guest', viewUrl: 'https://app.example.test/c' });
    expect(r.text).toContain('You now have access to this circle.');
  });
});
