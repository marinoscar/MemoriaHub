// PLATFORM-ADOPTION-SHIM(RETRO-D1): storage_objects.org_id is NOT NULL since platform 0025.
// Real-database fixtures stamp the default organization, like DefaultOrgId does in src/.
export async function defaultOrgId(prisma: {
  $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
}): Promise<string> {
  const rows = (await prisma.$queryRaw`SELECT id::text AS id FROM organizations WHERE is_default LIMIT 1`) as Array<{ id: string }>;
  if (!rows[0]) throw new Error('default organization missing: run prisma:migrate');
  return rows[0].id;
}
