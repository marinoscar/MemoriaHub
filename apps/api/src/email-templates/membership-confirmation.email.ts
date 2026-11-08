// =============================================================================
// "You've been added to a circle" (template `membership-confirmation`, RETRO-D2 #570)
// =============================================================================
//
// Sent fire-and-forget on member add and on invite claim. Ported to the
// platform layout; the copy is unchanged. Every interpolation is escaped by
// the `html` tag.
// =============================================================================

import {
  SafeHtml,
  TRANSACTIONAL_EMAIL_HEADERS,
  html,
  plainText,
  renderLayout,
  resolveEmailRenderContext,
  type EmailRenderContext,
  type RenderedEmail,
} from '@marinoscar/platform-api/email';

import type { MembershipConfirmationEmailData } from './types';

/** Human-readable summary of what each per-circle role can do. */
const ROLE_SUMMARY: Record<string, string> = {
  viewer: 'You can browse and download media in this circle.',
  collaborator: 'You can upload, tag, and organize media, and invite others at viewer level.',
  circle_admin: 'You have full control: manage members, settings, and everything collaborators can do.',
};

/** Friendly label for a role key. */
const ROLE_LABEL: Record<string, string> = {
  viewer: 'Viewer',
  collaborator: 'Collaborator',
  circle_admin: 'Circle Admin',
};

export const MEMBERSHIP_CONFIRMATION_CTA_LABEL = 'View Circle';

export function membershipConfirmationEmail(
  data: MembershipConfirmationEmailData,
  ctx?: EmailRenderContext,
): RenderedEmail {
  const context = resolveEmailRenderContext(ctx);
  const appName = context.appName;
  const roleLabel = ROLE_LABEL[data.role] ?? data.role;
  const roleSummary = ROLE_SUMMARY[data.role] ?? 'You now have access to this circle.';
  const subject = `You've been added to "${data.circleName}" on ${appName}`;
  const title = `Welcome to "${data.circleName}"`;

  const descriptionBlock = data.circleDescription
    ? html`<p style="margin:0 0 16px 0;color:#6b7280;">${data.circleDescription}</p>`
    : SafeHtml.EMPTY;

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      Good news: you've been added to the family circle
      <strong>${data.circleName}</strong> on ${appName} as a
      <strong>${roleLabel}</strong>.
    </p>
    ${descriptionBlock}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="margin:0 0 16px 0;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
      <tr>
        <td style="padding:14px 16px;font-size:14px;line-height:22px;color:#374151;">
          <strong>Your role: ${roleLabel}</strong><br>
          ${roleSummary}
        </td>
      </tr>
    </table>
    <p style="margin:0;">
      Open the circle to start exploring shared memories.
    </p>
  `;

  const htmlDocument = renderLayout(
    {
      title,
      previewText: `You've been added to "${data.circleName}" as ${roleLabel}.`,
      bodyHtml,
      ctaLabel: MEMBERSHIP_CONFIRMATION_CTA_LABEL,
      ctaUrl: data.viewUrl,
    },
    context,
  );

  const lines: [string, ...string[]] = [
    `You've been added to the family circle "${data.circleName}" on ${appName} as a ${roleLabel}.`,
  ];
  if (data.circleDescription) lines.push('', data.circleDescription);
  lines.push('', `Your role: ${roleLabel}. ${roleSummary}`);

  const text = plainText(
    { title, lines, ctaLabel: MEMBERSHIP_CONFIRMATION_CTA_LABEL, ctaUrl: data.viewUrl },
    context,
  );

  return { subject, html: htmlDocument, text, headers: { ...TRANSACTIONAL_EMAIL_HEADERS } };
}
