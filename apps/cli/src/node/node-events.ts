/**
 * node/node-events.ts — Typed event contract for the NodeEngine.
 *
 * Mirrors sync/events.ts: the engine emits typed events, and renderers (headless
 * printer or a future TUI dashboard) consume them. The engine never touches the
 * terminal.
 */

import { EventEmitter } from 'node:events';

export const NODE_EV = {
  CLAIMED: 'claimed',
  JOB_START: 'job:start',
  JOB_PROGRESS: 'job:progress',
  JOB_DONE: 'job:done',
  JOB_ERROR: 'job:error',
  IDLE: 'idle',
  HEARTBEAT_OK: 'heartbeat:ok',
  HEARTBEAT_FAIL: 'heartbeat:fail',
  LEASE_RENEW: 'lease:renew',
  MODEL_LOADED: 'model:loaded',
  STOPPED: 'stopped',
} as const;

export type NodeEventName = (typeof NODE_EV)[keyof typeof NODE_EV];

export interface ClaimedPayload {
  count: number;
}

export interface JobStartPayload {
  jobId: string;
  type: string;
  mediaItemId?: string | null;
}

export interface JobProgressPayload {
  jobId: string;
  fraction: number;
}

export interface JobDonePayload {
  jobId: string;
  type: string;
  durationMs: number;
  /** True when the result was submitted; false when the result endpoint was unavailable. */
  submitted: boolean;
}

export interface JobErrorPayload {
  jobId: string;
  type: string;
  error: string;
  willRetry: boolean;
}

export interface IdlePayload {
  pollIntervalMs: number;
}

export interface HeartbeatOkPayload {
  at: string;
}

export interface HeartbeatFailPayload {
  error: string;
}

export interface LeaseRenewPayload {
  jobId: string;
}

export interface ModelLoadedPayload {
  targetDir: string;
  downloaded: number;
  present: number;
  failed: number;
}

export interface StoppedPayload {
  reason: string;
}

export interface NodeEngineEvents {
  [NODE_EV.CLAIMED]: (payload: ClaimedPayload) => void;
  [NODE_EV.JOB_START]: (payload: JobStartPayload) => void;
  [NODE_EV.JOB_PROGRESS]: (payload: JobProgressPayload) => void;
  [NODE_EV.JOB_DONE]: (payload: JobDonePayload) => void;
  [NODE_EV.JOB_ERROR]: (payload: JobErrorPayload) => void;
  [NODE_EV.IDLE]: (payload: IdlePayload) => void;
  [NODE_EV.HEARTBEAT_OK]: (payload: HeartbeatOkPayload) => void;
  [NODE_EV.HEARTBEAT_FAIL]: (payload: HeartbeatFailPayload) => void;
  [NODE_EV.LEASE_RENEW]: (payload: LeaseRenewPayload) => void;
  [NODE_EV.MODEL_LOADED]: (payload: ModelLoadedPayload) => void;
  [NODE_EV.STOPPED]: (payload: StoppedPayload) => void;
}

/** A thin typed wrapper over Node's EventEmitter for NodeEngine events. */
export class NodeTypedEmitter extends EventEmitter {
  on<K extends NodeEventName>(event: K, listener: NodeEngineEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends NodeEventName>(event: K, listener: NodeEngineEvents[K]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  once<K extends NodeEventName>(event: K, listener: NodeEngineEvents[K]): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends NodeEventName>(
    event: K,
    payload: Parameters<NodeEngineEvents[K]>[0],
  ): boolean {
    return super.emit(event, payload);
  }
}
