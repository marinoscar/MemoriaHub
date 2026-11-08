import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { PrismaService } from '../../../prisma/prisma.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, pass, warn } from '../outcome';

// Ported from `DoctorService.checkAdminBootstrap` (key `auth.adminBootstrap`).
// READ-ONLY: one `count`. Reports the NUMBER of admins, never an address.
// Retirement: replaced by the identity slice's `auth.*` checks (RETRO-B2).

export function decideAdminBootstrap(adminCount: number, initialAdminSet: boolean): DoctorCheckOutcome {
  if (adminCount === 0) {
    return warn(
      initialAdminSet
        ? 'No admin users found.'
        : 'No admin users found. INITIAL_ADMIN_EMAIL is also not set.',
      'Set INITIAL_ADMIN_EMAIL and have that user sign in.',
      { adminCount },
    );
  }
  return pass(`${adminCount} admin user(s).`, { adminCount });
}

@Injectable()
export class AdminBootstrapDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('auth', 'admin-bootstrap');
  readonly category = 'auth';
  readonly label = 'Admin bootstrap';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;
  readonly dependsOn = ['db.connection'] as const;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const adminCount = await this.prisma.user.count({
      where: { userRoles: { some: { role: { name: 'admin' } } } },
    });
    return decideAdminBootstrap(adminCount, !!process.env['INITIAL_ADMIN_EMAIL']);
  }
}
