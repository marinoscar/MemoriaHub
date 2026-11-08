// =============================================================================
// What MemoriaHub adds to the platform email slice (RETRO-D2, #570)
// =============================================================================
//
// Imported by `platform/email/email.config.ts` BEFORE `EmailModule.forRoot`,
// so every registration lands before bootstrap freezes the registries.
//
//   templates   circle-invitation, membership-confirmation, memory-digest
//               (`email-templates/`, names permanent)
//   transports  none: the built-in `ses` and `smtp` cover this app. SES no
//               longer reads the S3 storage credential at send time; the
//               settings migration (`scripts/migrate-email-settings.ts`) copies
//               that key pair into the SES transport once (Open decision 1 of
//               #570), and the runbook says to rotate both together.
// =============================================================================

import { registerMemoriaHubEmailTemplates } from '../email-templates';

registerMemoriaHubEmailTemplates();
