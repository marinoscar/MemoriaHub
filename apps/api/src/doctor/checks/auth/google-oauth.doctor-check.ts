import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { DOCTOR_CHECK_TIMEOUT_MS, checkId, fail, pass, warn } from '../outcome';

// Ported from `DoctorService.checkGoogleOauth` (key `auth.googleOauth`).
// Retirement: replaced by the identity slice's `auth.*` checks (RETRO-B2).

export function decideGoogleOauth(configured: boolean, nodeEnv: string | undefined): DoctorCheckOutcome {
  if (configured) return pass('Google OAuth configured.');
  if (nodeEnv === 'production') {
    return fail(
      'Google OAuth is not configured.',
      'Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
    );
  }
  return warn(
    'Google OAuth not configured (dev fallback only).',
    'Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before going to production.',
  );
}

@Injectable()
export class GoogleOauthDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('auth', 'google-oauth');
  readonly category = 'auth';
  readonly label = 'Google OAuth';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(private readonly registry: DoctorCheckRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const configured = !!process.env['GOOGLE_CLIENT_ID'] && !!process.env['GOOGLE_CLIENT_SECRET'];
    return decideGoogleOauth(configured, process.env['NODE_ENV']);
  }
}
