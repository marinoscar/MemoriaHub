/**
 * executors/index.ts - MemoriaHub's worker-node executors and their registrations (RETRO-C10, #616).
 *
 * `APP_NODE_EXECUTORS` is passed to `createCli({ nodeExecutors })`; importing this module registers
 * everything else the platform engine needs to know about a MemoriaHub worker, before `createCli`
 * freezes the registries:
 *
 *   type                     input     required capabilities                              degradable
 *   face_detection           download  sharp, CompreFace service                          -
 *   video_face_detection     download  sharp, CompreFace, ffmpeg, ffprobe                 -
 *   duplicate_detection      download  sharp, onnxruntime-node, CLIP model (withheld)     -
 *   metadata_extraction      download  sharp, ffprobe                                     -
 *   social_media_detection   download  ffprobe, ffmpeg                                    tesseract.js (Tier 2 OCR)
 *   thumbnail_regen          download  sharp, ffmpeg                                      -
 *   geocode                  none      -                                                  -
 *   workflow_execute_batch   none      -                                                  -
 *
 * `auto_tagging` and `video_auto_tagging` are server-only (the API resolves the provider key; a
 * node never receives one), so no executor exists for them and a node never advertises them.
 */

import {
  binaryCapability,
  httpServiceCapability,
  moduleCapability,
  registerCapabilityProbe,
  registerJobRequirement,
  registerModelArtifact,
  registerProbedBinary,
  registerWorkerRuntimeHook,
  setMemoryValveExitCode,
  type JobExecutor,
} from '@marinoscar/platform-cli/node';

import { MEMORY_VALVE_EXIT_CODE, appWorkerEnv } from '../worker-env.js';
import { duplicateDetectionExecutor } from './duplicate-detection.executor.js';
import { faceDetectionExecutor } from './face-detection.executor.js';
import { geocodeExecutor } from './geocode.executor.js';
import { metadataExtractionExecutor } from './metadata.executor.js';
import { socialMediaDetectionExecutor } from './social-media-detection.executor.js';
import { thumbnailRegenExecutor } from './thumbnail.executor.js';
import { videoFaceDetectionExecutor } from './video-face-detection.executor.js';
import { workflowExecuteBatchExecutor } from './workflow-execute-batch.executor.js';
import { CLIP_MODEL_ARTIFACT } from './models.js';
import { registerInstallSteps } from './install-steps.js';
import { NATIVE_MODULES } from './support.js';

export const APP_NODE_EXECUTORS: readonly JobExecutor[] = [
  faceDetectionExecutor,
  videoFaceDetectionExecutor,
  duplicateDetectionExecutor,
  metadataExtractionExecutor,
  socialMediaDetectionExecutor,
  thumbnailRegenExecutor,
  geocodeExecutor,
  workflowExecuteBatchExecutor,
];

/** The job types MemoriaHub's nodes run (the server's node-eligible set). */
export const NODE_JOB_TYPES: readonly string[] = APP_NODE_EXECUTORS.map((e) => e.type);

const SHARP = `module:${NATIVE_MODULES['sharp']}`;
const ONNX = `module:${NATIVE_MODULES['onnxruntime']}`;
const TESSERACT = `module:${NATIVE_MODULES['tesseract']}`;
const COMPREFACE = 'service:compreface';

let registered = false;

/** Registers capabilities, requirements, the model, the install steps and the runtime hooks. Idempotent. */
export function registerNodeExtensions(): void {
  if (registered) return;
  registered = true;

  registerProbedBinary('ffmpeg', { versionArgs: ['-version'] });
  registerProbedBinary('ffprobe', { versionArgs: ['-version'] });

  registerCapabilityProbe(moduleCapability(NATIVE_MODULES['sharp'] as string));
  registerCapabilityProbe(moduleCapability(NATIVE_MODULES['onnxruntime'] as string));
  registerCapabilityProbe(moduleCapability(NATIVE_MODULES['tesseract'] as string, { label: 'tesseract.js (OCR)' }));
  registerCapabilityProbe(
    httpServiceCapability({
      id: 'compreface',
      label: 'CompreFace core sidecar',
      env: appWorkerEnv.comprefaceUrl,
      path: '/status',
      timeoutMs: 3000,
    }),
  );

  registerModelArtifact(CLIP_MODEL_ARTIFACT);

  const ffmpeg = binaryCapability('ffmpeg');
  const ffprobe = binaryCapability('ffprobe');
  registerJobRequirement('face_detection', { required: [SHARP, COMPREFACE] });
  registerJobRequirement('video_face_detection', { required: [SHARP, COMPREFACE, ffmpeg, ffprobe] });
  registerJobRequirement('duplicate_detection', { required: [SHARP, ONNX] });
  registerJobRequirement('metadata_extraction', { required: [SHARP, ffprobe] });
  registerJobRequirement('social_media_detection', { required: [ffprobe, ffmpeg], degradable: [TESSERACT] });
  registerJobRequirement('thumbnail_regen', { required: [SHARP, ffmpeg] });

  registerInstallSteps();
  setMemoryValveExitCode(MEMORY_VALVE_EXIT_CODE);

  // libvips: no operation cache (a bulk import never repeats an operation), and the native thread
  // cap the platform resolved (MEMORIAHUB_NATIVE_THREADS, else half the cores between 1 and 4).
  registerWorkerRuntimeHook({
    id: 'sharp',
    beforeFirstJob: async ({ nativeThreads }) => {
      try {
        const sharp = (await import('sharp')).default;
        sharp.cache(false);
        sharp.concurrency(nativeThreads);
      } catch {
        /* sharp is optional: types that need it are withheld by the capability check */
      }
    },
  });

  // Local Media Backup (epic #308): hosted in the worker process while a backup root is bound. The
  // events are the daemon channel `backup`, the commands the backup control socket.
  registerWorkerRuntimeHook({
    id: 'backup-host',
    beforeFirstJob: async () => {
      const { startBackupInWorker } = await import('../backup/daemon-part.js');
      await startBackupInWorker();
    },
  });
}
