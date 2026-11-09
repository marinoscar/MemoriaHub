import { DefaultOrgId } from '../../src/common/tenancy/default-org-id';

/** Provider override so unit tests need no organizations table (the single-organization default). */
export const defaultOrgIdProvider = {
  provide: DefaultOrgId,
  useValue: { get: async () => '00000000-0000-4000-8000-0000000000d0' },
};
