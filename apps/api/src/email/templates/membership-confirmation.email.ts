import { renderLayout, plainText, escapeHtml } from './layout';
import { MembershipConfirmationEmailData, RenderedEmail } from '../types/email.types';

/** Human-readable summary of what each per-circle role can do. */
const ROLE_SUMMARY: Record<string, string> = {
  viewer: 'You can browse and download media in this circle.',
  collaborator:
    'You can upload, tag, and organize media, and invite others at viewer level.',
  circle_admin:
    'You have full control: manage members, settings, and everything collaborators can do.',
};

/** Friendly label for a role key. */
const ROLE_LABEL: Record<string, string> = {
  viewer: 'Viewer',
  collaborator: 'Collaborator',
  circle_admin: 'Circle Admin',
};

/**
 * "You've been added to a circle" confirmation email.
 */
export function membershipConfirmationEmail(
  data: MembershipConfirmationEmailData,
): RenderedEmail {
  const roleLabel = ROLE_LABEL[data.role] ?? data.role;
  const roleSummary =
    ROLE_SUMMARY[data.role] ?? 'You now have access to this circle.';

  const subject = `You've been added to "${data.circleName}" on MemoriaHub`;

  const descriptionBlock = data.circleDescription
    ? `<p style="margin:0 0 16px 0;color:#6b7280;">${escapeHtml(
        data.circleDescription,
      )}</p>`
    : '';

  const bodyHtml = `
    <p style="margin:0 0 16px 0;">
      Good news — you've been added to the family circle
      <strong>${escapeHtml(data.circleName)}</strong> on MemoriaHub as a
      <strong>${escapeHtml(roleLabel)}</strong>.
    </p>
    ${descriptionBlock}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="margin:0 0 16px 0;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
      <tr>
        <td style="padding:14px 16px;font-size:14px;line-height:22px;color:#374151;">
          <strong>Your role: ${escapeHtml(roleLabel)}</strong><br>
          ${escapeHtml(roleSummary)}
        </td>
      </tr>
    </table>
    <p style="margin:0;">
      Open the circle to start exploring shared memories.
    </p>
  `;

  const html = renderLayout({
    title: `Welcome to "${data.circleName}"`,
    previewText: `You've been added to "${data.circleName}" as ${roleLabel}.`,
    bodyHtml,
    ctaLabel: 'View Circle',
    ctaUrl: data.viewUrl,
  });

  const lines = [
    `You've been added to the family circle "${data.circleName}" on MemoriaHub as a ${roleLabel}.`,
  ];
  if (data.circleDescription) {
    lines.push('', data.circleDescription);
  }
  lines.push('', `Your role: ${roleLabel} — ${roleSummary}`);

  const text = plainText({
    title: `Welcome to "${data.circleName}"`,
    lines,
    ctaLabel: 'View Circle',
    ctaUrl: data.viewUrl,
  });

  return { subject, html, text };
}
