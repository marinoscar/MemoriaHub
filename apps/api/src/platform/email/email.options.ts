// =============================================================================
// The email slice's options (RETRO-D2, #570)
// =============================================================================
//
// ONE object, read by `EmailModule.forRoot(EMAIL_MODULE_OPTIONS)` in
// `email.config.ts` and by the template specs (`configureEmailRendering`).
//
// THE LAYOUT. The product name and the brand colour come from
// `packages/shared/identity.json` through `@app/shared` (`PRODUCT_NAME`,
// `THEME_COLOR`, #1976d2), so a rebrand reaches the mail with the web manifest
// and the icons. No brand mark: MemoriaHub's mails never carried a logo image,
// and the platform layout's text wordmark is kept.
//
// THE SES REGION. An admin-entered region (`transports.ses.region`) wins; this
// is the deployment default MemoriaHub has always read, `AWS_SES_REGION` (no
// built-in default: a guessed region is reported by SES as an unverified
// identity, a worse error than "no region configured"). The SES key pair is
// NOT read from the environment nor from the S3 storage credential any more:
// it is the SES transport's own (`transports.ses.accessKeyId` and the
// `email_ses/default` credential), copied once from the S3 key by
// `scripts/migrate-email-settings.ts`.
//
// THE RATE-LIMIT CLASSIFIER is the job queue's, so a provider throttle reads
// the same way in a send as in a job.
// =============================================================================

import { PRODUCT_NAME, THEME_COLOR } from '@app/shared';
import type { EmailModuleOptions } from '@marinoscar/platform-api/email';
import { classifyRateLimit } from '@marinoscar/platform-api/jobs';

/** The deployment's base URL when `APP_URL` is unset (the dev default). */
export const DEFAULT_APP_URL = 'http://localhost:3535';

export const EMAIL_MODULE_OPTIONS: EmailModuleOptions = {
  appName: PRODUCT_NAME,
  appUrl: () => process.env['APP_URL'] || DEFAULT_APP_URL,
  layout: { theme: { colors: { brand: THEME_COLOR } } },
  classifyRateLimit,
  sesRegionFallback: () => process.env['AWS_SES_REGION'] || undefined,
};
