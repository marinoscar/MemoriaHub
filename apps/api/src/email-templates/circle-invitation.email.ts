// =============================================================================
// "You've been invited to a circle" (template `circle-invitation`, RETRO-D2 #570)
// =============================================================================
//
// Sent fire-and-forget by `CirclesService.createInvite`. Ported from the
// app's own layout to the platform's (`renderLayout` / `plainText`): the copy
// and the links are unchanged, the shell is the platform's. Every interpolation
// goes through the `html` tag (escaped), and the decline link is admitted only
// through `safeUrl` (absolute http(s) or nothing).
// =============================================================================

import {
  SafeHtml,
  TRANSACTIONAL_EMAIL_HEADERS,
  html,
  plainText,
  renderLayout,
  resolveEmailRenderContext,
  safeUrl,
  type EmailRenderContext,
  type RenderedEmail,
} from '@marinoscar/platform-api/email';

import type { CircleInvitationEmailData } from './types';

export const CIRCLE_INVITATION_CTA_LABEL = 'Accept Invitation';

export function circleInvitationEmail(data: CircleInvitationEmailData, ctx?: EmailRenderContext): RenderedEmail {
  const context = resolveEmailRenderContext(ctx);
  const appName = context.appName;
  const subject = `You're invited to join "${data.circleName}" on ${appName}`;
  const title = `Join "${data.circleName}"`;
  const declineUrl = data.declineUrl ? safeUrl(data.declineUrl) : null;

  const inviterLine = data.inviterName
    ? html`<strong>${data.inviterName}</strong> has invited you`
    : html`You've been invited`;

  const declineLink = declineUrl
    ? html`<p style="margin:16px 0 0 0;font-size:13px;color:#6b7280;">
        Not interested? You can
        <a href="${declineUrl}" style="color:#6b7280;">decline this invitation</a>.
      </p>`
    : SafeHtml.EMPTY;

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      ${inviterLine} to join the family circle
      <strong>${data.circleName}</strong> on ${appName}, a shared space to
      collect, organize, and relive your photos and videos together.
    </p>
    <p style="margin:0 0 16px 0;">
      Click the button below to accept the invitation and get started. You'll sign in
      with the email address this invite was sent to
      (<strong>${data.recipientEmail}</strong>).
    </p>
    ${declineLink}
  `;

  const htmlDocument = renderLayout(
    {
      title,
      previewText: `You've been invited to the "${data.circleName}" circle on ${appName}.`,
      bodyHtml,
      ctaLabel: CIRCLE_INVITATION_CTA_LABEL,
      ctaUrl: data.acceptUrl,
    },
    context,
  );

  const lines: [string, ...string[]] = [
    `${data.inviterName ? `${data.inviterName} has invited you` : "You've been invited"} to join the family circle "${data.circleName}" on ${appName}.`,
    '',
    `Sign in with ${data.recipientEmail} to accept.`,
  ];
  if (declineUrl) lines.push('', `Decline: ${declineUrl}`);

  const text = plainText(
    { title, lines, ctaLabel: CIRCLE_INVITATION_CTA_LABEL, ctaUrl: data.acceptUrl },
    context,
  );

  return { subject, html: htmlDocument, text, headers: { ...TRANSACTIONAL_EMAIL_HEADERS } };
}
