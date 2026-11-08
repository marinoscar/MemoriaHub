import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Resolves the id of the default organization (`organizations.is_default`).
 *
 * PLATFORM-ADOPTION-SHIM(RETRO-D1): platform migration 0025 made
 * `storage_objects.org_id` and `storage_object_chunks.org_id` NOT NULL (and
 * forced row-level security on both). MemoriaHub's legacy storage code does
 * not know about organizations yet, so every row it creates is stamped with
 * the default organization. RETRO-D1 replaces the legacy storage models with
 * the platform's and deletes this provider.
 *
 * The id never changes once the organization exists (the default
 * organization is created by migration 0023 and there is exactly one), so it
 * is read once and cached. A failed lookup is not cached.
 */
@Injectable()
export class DefaultOrgId {
  private readonly logger = new Logger(DefaultOrgId.name);
  private cached: string | null = null;
  private inflight: Promise<string> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** The default organization's id. Throws when migration 0023 has not run. */
  async get(): Promise<string> {
    if (this.cached) return this.cached;
    if (!this.inflight) {
      this.inflight = this.load().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async load(): Promise<string> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id FROM organizations WHERE is_default LIMIT 1
    `;
    const id = rows[0]?.id;
    if (!id) {
      this.logger.error('No default organization found; run `npm run prisma:migrate` (platform 0023_add_organizations)');
      throw new Error('Default organization is missing; platform migrations have not been applied');
    }
    this.cached = id;
    return id;
  }
}
