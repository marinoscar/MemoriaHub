import { renderLayout, plainText, escapeHtml } from './layout';
import { CircleInvitationEmailData, RenderedEmail } from '../types/email.types';

/**
 * "You've been invited to a circle" transactional email.
 */
export function circleInvitationEmail(
  data: CircleInvitationEmailData,
): RenderedEmail {
  const subject = `You're invited to join "${data.circleName}" on MemoriaHub`;

  const inviterLine = data.inviterName
    ? `<strong>${escapeHtml(data.inviterName)}</strong> has invited you`
    : `You've been invited`;

  const declineLink = data.declineUrl
    ? `<p style="margin:16px 0 0 0;font-size:13px;color:#6b7280;">
         Not interested? You can
         <a href="${escapeHtml(data.declineUrl)}" style="color:#6b7280;">decline this invitation</a>.
       </p>`
    : '';

  const bodyHtml = `
    <p style="margin:0 0 16px 0;">
      ${inviterLine} to join the family circle
      <strong>${escapeHtml(data.circleName)}</strong> on MemoriaHub — a shared space to
      collect, organize, and relive your photos and videos together.
    </p>
    <p style="margin:0 0 16px 0;">
      Click the button below to accept the invitation and get started. You'll sign in
      with the email address this invite was sent to
      (<strong>${escapeHtml(data.recipientEmail)}</strong>).
    </p>
    ${declineLink}
  `;

  const html = renderLayout({
    title: `Join "${data.circleName}"`,
    previewText: `You've been invited to the "${data.circleName}" circle on MemoriaHub.`,
    bodyHtml,
    ctaLabel: 'Accept Invitation',
    ctaUrl: data.acceptUrl,
  });

  const lines = [
    `${data.inviterName ? `${data.inviterName} has invited you` : "You've been invited"} to join the family circle "${data.circleName}" on MemoriaHub.`,
    '',
    `Sign in with ${data.recipientEmail} to accept.`,
  ];
  if (data.declineUrl) {
    lines.push('', `Decline: ${data.declineUrl}`);
  }

  const text = plainText({
    title: `Join "${data.circleName}"`,
    lines,
    ctaLabel: 'Accept Invitation',
    ctaUrl: data.acceptUrl,
  });

  return { subject, html, text };
}
