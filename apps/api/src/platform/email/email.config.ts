// =============================================================================
// The email slice's composition (RETRO-D2, #570)
// =============================================================================
//
// `EmailModule.forRoot` replaces this app's own `email/` folder: the SES and
// SMTP transports, the `email` settings row and its admin routes
// (`GET|PUT /api/email-settings`, `POST /api/email-settings/test`, all
// `system_settings:read|write`), the template registry and layout, and the
// Doctor check `email.config`. The platform templates (`test-email`,
// `broadcast`, ...) come with it; this app's own three are registered by
// `../../app-registrations/email.ts`, imported FIRST so they are in the
// registry before bootstrap freezes it.
//
// NOT GLOBAL: the transports reach the plaintext `CredentialsService` reader,
// so every consumer imports the ONE `emailModule` object (the notifications
// slice and the memory digest) and shows up in a diff. It needs `SettingsModule.forRoot()`
// (the row store), `PlatformHostModule` (`PLATFORM_PRISMA`, `AUDIT_SINK`) and the
// credential store, all mounted by `app.module.ts`. The credential purposes
// (`smtp`, `email_ses`) are registered by
// `platform/credentials/credential-purposes.manifest.ts`.
// =============================================================================

import '../../app-registrations/email';

import { EmailModule } from '@marinoscar/platform-api/email';

import { EMAIL_MODULE_OPTIONS } from './email.options';

export { EMAIL_MODULE_OPTIONS };

export const emailModule = EmailModule.forRoot(EMAIL_MODULE_OPTIONS);
