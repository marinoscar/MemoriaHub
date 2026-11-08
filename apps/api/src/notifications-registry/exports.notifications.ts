// =============================================================================
// The exports slice's notifications (RETRO-H2, #596)
// =============================================================================
//
// `export.ready` and `export.failed`, raised by the platform's `export.run` job AFTER the
// file is committed (or the last attempt failed), outside any transaction, through
// `ExportsNotifierAdapter` (`platform/exports/`). Bell and Web Push only: the platform carries
// ids and labels, never a URL, a file name or a value, and both link to the "Download your
// data" page (`/settings/data-export`), where the signed download is minted on demand. No
// email: a download link must not sit in a mailbox. Not mandatory: a user may mute them.
// The event definitions and both browser renderers are the platform's.
// =============================================================================

import {
  EXPORT_FAILED_EVENT,
  EXPORT_READY_EVENT,
  exportFailedBrowserTemplate,
  exportReadyBrowserTemplate,
} from '@marinoscar/platform-api/exports';
import type { NotificationRegistration } from '@marinoscar/platform-api/notifications';

export const EXPORTS_NOTIFICATIONS: readonly NotificationRegistration[] = [
  {
    event: { ...EXPORT_READY_EVENT, channels: [...EXPORT_READY_EVENT.channels] },
    browserTemplate: (data: never) => exportReadyBrowserTemplate(data),
  },
  {
    event: { ...EXPORT_FAILED_EVENT, channels: [...EXPORT_FAILED_EVENT.channels] },
    browserTemplate: (data: never) => exportFailedBrowserTemplate(data),
  },
];
