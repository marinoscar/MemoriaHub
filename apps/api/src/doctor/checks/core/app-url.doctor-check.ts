import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { DOCTOR_CHECK_TIMEOUT_MS, checkId, pass, warn } from '../outcome';

// Ported from `DoctorService.checkAppUrl` (key `core.appUrl`). Reads one
// environment variable. Note: the detail echoes `APP_URL`, which is a public
// base URL, not a secret.

export function decideAppUrl(appUrl: string | undefined, nodeEnv: string | undefined): DoctorCheckOutcome {
  if (!appUrl) {
    return warn('APP_URL not set.', 'Set APP_URL to the public base URL (infra/compose/.env).');
  }
  if (appUrl.includes('localhost') && nodeEnv === 'production') {
    return warn('APP_URL is still localhost in production.', 'Set APP_URL to the public base URL.');
  }
  return pass(`APP_URL: ${appUrl}`);
}

@Injectable()
export class AppUrlDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('core', 'app-url');
  readonly category = 'core';
  readonly label = 'App URL';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(private readonly registry: DoctorCheckRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    return decideAppUrl(process.env['APP_URL'], process.env['NODE_ENV']);
  }
}
