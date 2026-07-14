import {
  EmailTemplateName,
  EmailTemplateDataMap,
  RenderedEmail,
} from '../types/email.types';
import { circleInvitationEmail } from './circle-invitation.email';
import { membershipConfirmationEmail } from './membership-confirmation.email';

/**
 * Typed registry mapping each template name to its builder function.
 * Each builder takes the template's typed data payload and returns the
 * rendered { subject, html, text }.
 */
export const TEMPLATES: {
  [K in EmailTemplateName]: (data: EmailTemplateDataMap[K]) => RenderedEmail;
} = {
  'circle-invitation': circleInvitationEmail,
  'membership-confirmation': membershipConfirmationEmail,
};
