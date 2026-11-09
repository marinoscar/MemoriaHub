/**
 * ALL server-side image processing must obtain pixels via prepareImageForProcessing
 * so EXIF orientation is applied consistently. Do not call sharp directly in new
 * image handlers.
 *
 * The implementation lives in the shared parity package
 * @memoriahub/enrichment-compute (see docs/specs/distributed-nodes.md §7) so
 * distributed worker nodes run the EXACT same preprocessing as the server.
 * This module re-exports it under the historical path and wires the package's
 * pluggable logger into NestJS logging once, so the ~15 existing import sites
 * keep working unchanged.
 */

import { Logger } from '@nestjs/common';
import { setComputeLogger } from '@memoriahub/enrichment-compute/image';

const logger = new Logger('EnrichmentCompute');

setComputeLogger({
  warn: (message: string) => logger.warn(message),
  error: (message: string) => logger.error(message),
});

export {
  prepareImageForProcessing,
  applyOrientationTransform,
  getOrientedDimensions,
  transcodeToDecodableJpeg,
} from '@memoriahub/enrichment-compute/image';
export type { OrientationOp } from '@memoriahub/enrichment-compute/image';
