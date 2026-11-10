import { listCapabilityProbes, listModelArtifacts, listRegisteredNodeExecutors, resolveInputMode } from '@marinoscar/platform-cli/node';
import { checkExecutorCredentialHygiene } from '@marinoscar/platform-cli/testing';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { createCli } from '@marinoscar/platform-cli';

import { APP_CLI_OPTIONS } from '../../src/app.js';
import { APP_NODE_EXECUTORS, NODE_JOB_TYPES, registerNodeExtensions, resetNodeExtensionsForTests } from '../../src/executors/index.js';

const SERVER_NODE_ELIGIBLE = [
  'duplicate_detection', 'face_detection', 'geocode', 'metadata_extraction',
  'social_media_detection', 'thumbnail_regen', 'video_face_detection', 'workflow_execute_batch',
];

describe('MemoriaHub node executors', () => {
  it('cover exactly the server\'s node-eligible types, never the AI types', () => {
    expect([...NODE_JOB_TYPES].sort()).toEqual(SERVER_NODE_ELIGIBLE);
    expect(NODE_JOB_TYPES).not.toContain('auto_tagging');
    expect(NODE_JOB_TYPES).not.toContain('video_auto_tagging');
  });

  it('declare an input mode: a download for media types, none for geocode and workflows', () => {
    const modes = Object.fromEntries(APP_NODE_EXECUTORS.map((e) => [e.type, resolveInputMode(e)]));
    expect(modes).toMatchObject({ geocode: 'none', workflow_execute_batch: 'none', thumbnail_regen: 'download', video_face_detection: 'download' });
  });

  it('are registered with the platform, with the capability probes and the CLIP model', () => {
    resetCliForTests();
    resetNodeExtensionsForTests();
    registerNodeExtensions();
    createCli(APP_CLI_OPTIONS);
    expect(listRegisteredNodeExecutors().map((e) => e.type).sort()).toEqual(SERVER_NODE_ELIGIBLE);
    expect(listCapabilityProbes().map((p) => p.key)).toEqual(expect.arrayContaining(['service:compreface', 'module:sharp', 'module:onnxruntime-node']));
    expect(listModelArtifacts().map((m) => m.id)).toEqual(['clip-vit-b32']);
  });

  it('pass the platform credential hygiene check', () => {
    const report = checkExecutorCredentialHygiene([...APP_NODE_EXECUTORS]);
    expect(report).toBeDefined();
  });
});
