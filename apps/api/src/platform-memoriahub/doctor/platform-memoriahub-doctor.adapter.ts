import { Injectable } from '@nestjs/common';
import { DoctorCheckRegistry, type DoctorCheck } from '@marinoscar/platform-api/doctor';
import type { MemoriahubDoctorCheck, MemoriahubDoctorPort } from '@marinoscar/memoriahub-api/ports';

/**
 * The web app's binding of the `MEMORIAHUB_DOCTOR` port: a check a MemoriaHub slice registers becomes a
 * check of the platform Doctor (the Admin Doctor page, the support bundle, the `dependsOn` order). A
 * duplicate id throws, as the registry does.
 *
 * The two check shapes are structurally the same (status words, outcome fields, `dependsOn`), so the check
 * is handed over as it is: nothing about it is translated, which is what keeps every check id and status
 * identical to the ones the app declared before its slices moved.
 */
@Injectable()
export class PlatformMemoriahubDoctorAdapter implements MemoriahubDoctorPort {
  constructor(private readonly registry: DoctorCheckRegistry) {}

  registerCheck(check: MemoriahubDoctorCheck): void {
    this.registry.register(check as DoctorCheck);
  }
}
