import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { DOCTOR_CHECK_TIMEOUT_MS, checkId, fail, pass } from '../outcome';

// Ported from `DoctorService.checkJwtSecret` (key `auth.jwt`). Only the verdict
// is reported; the secret is never echoed.
// Retirement: replaced by the identity slice's `auth.*` checks (RETRO-B2).

export function decideJwtSecret(secret: string | undefined): DoctorCheckOutcome {
  if (secret && secret.length >= 32) return pass('JWT secret configured.');
  return fail(
    'JWT_SECRET is missing or shorter than 32 characters.',
    'Set JWT_SECRET to a random string of at least 32 characters.',
  );
}

@Injectable()
export class JwtDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('auth', 'jwt');
  readonly category = 'auth';
  readonly label = 'JWT secret';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(private readonly registry: DoctorCheckRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    return decideJwtSecret(process.env['JWT_SECRET']);
  }
}
