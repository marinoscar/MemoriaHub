/**
 * The notifications web slice's binding (RETRO-D3, #576): the packaged inbox,
 * stream, Web Push sync and pages (`@marinoscar/platform-web/notifications`)
 * reach the API through the app's client and SSE connector. Imported once by
 * `App.tsx` before the first render.
 */
import { connectSse } from '@marinoscar/platform-web/core';
import { configureNotificationsWeb } from '@marinoscar/platform-web/notifications/headless';

import { API_BASE_URL, api } from '../services/api';

configureNotificationsWeb({ api, apiBaseUrl: API_BASE_URL, connectSse });
