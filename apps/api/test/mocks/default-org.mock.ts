import { DefaultOrgId } from '../../src/common/tenancy/default-org-id';

/** PLATFORM-ADOPTION-SHIM(RETRO-D1): provider override so unit tests need no organizations table. */
export const defaultOrgIdProvider = {
  provide: DefaultOrgId,
  useValue: { get: async () => '00000000-0000-4000-8000-0000000000d0' },
};
