import { Controller, Get, Logger, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Public } from '../auth/decorators/public.decorator';
import { AllowDuringMaintenance } from '../common/maintenance/allow-during-maintenance.decorator';
import { AndroidAppService } from './android-app.service';

// =============================================================================
// GET /api/well-known/assetlinks.json (issue #503, epic #498)
// =============================================================================
//
// Digital Asset Links for the Android app's Trusted Web Activity. The stack
// nginx maps the well-known path `/.well-known/assetlinks.json` here
// (`location =` blocks in infra/nginx/nginx.conf and nginx.prod.conf); this
// route is the one the API owns.
//
// PUBLIC (no `@Auth()`, plus `@Public()` for intent), because Chrome and
// Google's verifier fetch it anonymously.
//
// EXEMPT FROM THE MAINTENANCE WINDOW, like the health probes: Chrome verifies
// the statement when the app launches and remembers a failure, so a 503 during
// a window would leave every installed app opening with a URL bar well after
// the window closed. It is a read of one settings row, publishes only what is
// public by design (package names and certificate fingerprints), and writes
// nothing.
//
// RAW JSON, NOT THE `{ data }` ENVELOPE: Chrome expects a bare array. `@Res()`
// takes the reply over, so the global `TransformInterceptor`'s map never runs
// on it, and the OpenAPI response declares no JSON schema, so the document's
// envelope pass (`openapi/data-envelope.ts`) leaves it alone too.
// =============================================================================

/** Short, so a newly trusted key takes effect within minutes. */
export const ASSET_LINKS_CACHE_CONTROL = 'public, max-age=300';

@ApiTags('Android app')
@Controller('well-known')
@AllowDuringMaintenance()
export class AssetLinksController {
  private readonly logger = new Logger(AssetLinksController.name);

  constructor(private readonly androidApp: AndroidAppService) {}

  @Get('assetlinks.json')
  @Public()
  @ApiOperation({
    summary: 'Digital Asset Links statement list (public)',
    description:
      'Served at `/.well-known/assetlinks.json` by the edge proxy. A bare JSON array (no `{ data }` ' +
      'envelope) with one statement per trusted Android package: ' +
      '`{ "relation": ["delegate_permission/common.handle_all_urls"], "target": { "namespace": ' +
      '"android_app", "package_name": "<package>", "sha256_cert_fingerprints": ["AA:BB:…"] } }`. ' +
      '`[]` when no app is trusted. `Cache-Control: public, max-age=300`. Reachable during a ' +
      'maintenance window.',
  })
  @ApiProduces('application/json')
  @ApiResponse({ status: 200, description: 'The statement list (a bare JSON array)' })
  async getAssetLinks(@Res() reply: FastifyReply): Promise<void> {
    const statements = await this.androidApp.getAssetLinks();
    this.logger.debug({ event: 'android_app.assetlinks.served', statements: statements.length });

    await reply
      .status(200)
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Cache-Control', ASSET_LINKS_CACHE_CONTROL)
      .send(JSON.stringify(statements));
  }
}
