/**
 * test/tui/node-dashboard-source.spec.ts
 *
 * Unit tests for the pure state helpers in tui/node-dashboard-source.ts:
 * initial state construction, snapshot parsing/hydration, and the shared
 * event reducer used by both the attached (daemon IPC) and embedded
 * (in-process NodeEngine) dashboard data sources.
 *
 * These are plain-function tests — no Ink, no sockets, no engine.
 */

import {
  appendLogLines,
  hydrateFromSnapshot,
  initialDashboardState,
  MAX_HISTORY,
  MAX_LOG,
  parseSnapshotFrame,
  reduceNodeEvent,
  type DaemonSnapshot,
} from '../../src/tui/node-dashboard-source.js';
import { NODE_EV } from '../../src/node/node-events.js';

describe('initialDashboardState', () => {
  it('starts empty with the given concurrency and eligible types', () => {
    const state = initialDashboardState(3, ['face_detection']);
    expect(state.concurrency).toBe(3);
    expect(state.eligibleTypes).toEqual(['face_detection']);
    expect(state.activeJobs).toEqual({});
    expect(state.history).toEqual([]);
    expect(state.counters).toEqual({ succeeded: 0, failed: 0, claimed: 0 });
    expect(state.heartbeat).toEqual({ ok: false, at: null });
    expect(state.draining).toBe(false);
    expect(state.stopped).toBe(false);
    expect(state.idle).toBe(false);
    expect(state.log).toEqual([]);
  });

  it('floors concurrency at 1 and defaults eligibleTypes to null', () => {
    const state = initialDashboardState(0);
    expect(state.concurrency).toBe(1);
    expect(state.eligibleTypes).toBeNull();
  });
});

describe('appendLogLines', () => {
  it('appends entries and trims to MAX_LOG', () => {
    let state = initialDashboardState(1);
    for (let i = 0; i < MAX_LOG + 5; i++) {
      state = appendLogLines(state, [{ level: 'info', msg: `line ${i}` }], 1000 + i);
    }
    expect(state.log).toHaveLength(MAX_LOG);
    expect(state.log[state.log.length - 1].msg).toBe(`line ${MAX_LOG + 4}`);
  });

  it('is a no-op for an empty entries array', () => {
    const state = initialDashboardState(1);
    expect(appendLogLines(state, [])).toBe(state);
  });
});

describe('parseSnapshotFrame', () => {
  it('defensively parses a well-formed snapshot frame', () => {
    const frame = {
      kind: 'snapshot',
      nodeId: 'node-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      concurrency: 4,
      eligibleTypes: ['face_detection', 'auto_tagging'],
      activeJobs: [{ jobId: 'j1', type: 'face_detection', startedAt: '2026-01-01T00:00:01.000Z' }],
      history: [
        { jobId: 'j0', type: 'auto_tagging', status: 'done', durationMs: 500, finishedAt: '2026-01-01T00:00:00.500Z' },
      ],
      counters: { succeeded: 5, failed: 1, claimed: 6 },
      lastHeartbeatAt: '2026-01-01T00:00:02.000Z',
      draining: false,
    };
    const snap = parseSnapshotFrame(frame);
    expect(snap.nodeId).toBe('node-1');
    expect(snap.concurrency).toBe(4);
    expect(snap.eligibleTypes).toEqual(['face_detection', 'auto_tagging']);
    expect(snap.activeJobs).toHaveLength(1);
    expect(snap.activeJobs[0].jobId).toBe('j1');
    expect(snap.history).toHaveLength(1);
    expect(snap.history[0].status).toBe('done');
    expect(snap.counters).toEqual({ succeeded: 5, failed: 1, claimed: 6 });
    expect(snap.lastHeartbeatAt).toBe('2026-01-01T00:00:02.000Z');
    expect(snap.draining).toBe(false);
  });

  it('tolerates a malformed/minimal frame without throwing', () => {
    const snap = parseSnapshotFrame({ kind: 'snapshot' });
    expect(snap.nodeId).toBeNull();
    expect(snap.startedAt).toBeNull();
    expect(snap.concurrency).toBe(1);
    expect(snap.eligibleTypes).toEqual([]);
    expect(snap.activeJobs).toEqual([]);
    expect(snap.history).toEqual([]);
    expect(snap.counters).toEqual({ succeeded: 0, failed: 0, claimed: 0 });
    expect(snap.lastHeartbeatAt).toBeNull();
    expect(snap.draining).toBe(false);
  });

  it('coerces an error-status history entry and drops non-object garbage', () => {
    const snap = parseSnapshotFrame({
      history: [
        { jobId: 'j1', type: 'face_detection', status: 'error', error: 'boom', finishedAt: '2026-01-01T00:00:00Z' },
        'not-an-object',
        null,
      ],
      activeJobs: ['garbage', { jobId: 'j2', type: 'auto_tagging' }],
    });
    expect(snap.history).toHaveLength(1);
    expect(snap.history[0].status).toBe('error');
    expect(snap.history[0].error).toBe('boom');
    // activeJobs: garbage string filtered out; the object entry survives with
    // a synthesized startedAt since none was given.
    expect(snap.activeJobs).toHaveLength(1);
    expect(snap.activeJobs[0].jobId).toBe('j2');
  });
});

describe('hydrateFromSnapshot', () => {
  const baseSnap: DaemonSnapshot = {
    nodeId: 'node-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    concurrency: 2,
    eligibleTypes: ['face_detection'],
    activeJobs: [{ jobId: 'j1', type: 'face_detection', startedAt: '2026-01-01T00:00:01.000Z' }],
    history: [
      { jobId: 'j0', type: 'auto_tagging', status: 'done', durationMs: 250, finishedAt: '2026-01-01T00:00:00.250Z' },
    ],
    counters: { succeeded: 3, failed: 0, claimed: 4 },
    lastHeartbeatAt: '2026-01-01T00:00:02.000Z',
    draining: false,
  };

  it('replaces active jobs, history, counters, heartbeat, concurrency from the snapshot', () => {
    const state = hydrateFromSnapshot(initialDashboardState(1), baseSnap);
    expect(Object.keys(state.activeJobs)).toEqual(['j1']);
    expect(state.activeJobs.j1.type).toBe('face_detection');
    expect(state.history).toHaveLength(1);
    expect(state.counters).toEqual({ succeeded: 3, failed: 0, claimed: 4 });
    expect(state.heartbeat).toEqual({ ok: true, at: '2026-01-01T00:00:02.000Z' });
    expect(state.concurrency).toBe(2);
    expect(state.eligibleTypes).toEqual(['face_detection']);
    expect(state.draining).toBe(false);
    expect(state.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.stopped).toBe(false);
  });

  it('marks heartbeat not-ok when lastHeartbeatAt is null', () => {
    const state = hydrateFromSnapshot(initialDashboardState(1), { ...baseSnap, lastHeartbeatAt: null });
    expect(state.heartbeat).toEqual({ ok: false, at: null });
  });

  it('keeps the previous eligibleTypes when the snapshot has none', () => {
    const prev = initialDashboardState(1, ['auto_tagging']);
    const state = hydrateFromSnapshot(prev, { ...baseSnap, eligibleTypes: [] });
    expect(state.eligibleTypes).toEqual(['auto_tagging']);
  });

  it('caps hydrated history at MAX_HISTORY', () => {
    const longHistory = Array.from({ length: MAX_HISTORY + 10 }, (_, i) => ({
      jobId: `j${i}`,
      type: 'face_detection',
      status: 'done' as const,
      finishedAt: new Date(i).toISOString(),
    }));
    const state = hydrateFromSnapshot(initialDashboardState(1), { ...baseSnap, history: longHistory });
    expect(state.history).toHaveLength(MAX_HISTORY);
    expect(state.history[state.history.length - 1].jobId).toBe(`j${MAX_HISTORY + 9}`);
  });
});

describe('reduceNodeEvent', () => {
  const now = 1_700_000_000_000;

  it('CLAIMED increments the claimed counter and clears idle', () => {
    const start = { ...initialDashboardState(1), idle: true };
    const next = reduceNodeEvent(start, NODE_EV.CLAIMED, { count: 2 }, now);
    expect(next.counters.claimed).toBe(2);
    expect(next.idle).toBe(false);
  });

  it('JOB_START adds an active job entry', () => {
    const state = initialDashboardState(1);
    const next = reduceNodeEvent(
      state,
      NODE_EV.JOB_START,
      { jobId: 'j1', type: 'face_detection', mediaItemId: 'm1' },
      now,
    );
    expect(next.activeJobs.j1).toEqual({
      jobId: 'j1',
      type: 'face_detection',
      mediaItemId: 'm1',
      startMs: now,
      fraction: 0,
    });
    expect(next.idle).toBe(false);
  });

  it('JOB_PROGRESS updates fraction on an existing job, ignores unknown jobs', () => {
    let state = reduceNodeEvent(initialDashboardState(1), NODE_EV.JOB_START, { jobId: 'j1', type: 't' }, now);
    state = reduceNodeEvent(state, NODE_EV.JOB_PROGRESS, { jobId: 'j1', fraction: 0.5 }, now);
    expect(state.activeJobs.j1.fraction).toBe(0.5);

    const unaffected = reduceNodeEvent(state, NODE_EV.JOB_PROGRESS, { jobId: 'unknown', fraction: 0.9 }, now);
    expect(unaffected).toBe(state);
  });

  it('JOB_DONE moves the job to history, increments succeeded, and records a completion', () => {
    let state = reduceNodeEvent(initialDashboardState(1), NODE_EV.JOB_START, { jobId: 'j1', type: 'auto_tagging' }, now);
    state = reduceNodeEvent(
      state,
      NODE_EV.JOB_DONE,
      { jobId: 'j1', type: 'auto_tagging', durationMs: 1234, submitted: true },
      now + 1000,
    );
    expect(state.activeJobs.j1).toBeUndefined();
    expect(state.counters.succeeded).toBe(1);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ jobId: 'j1', type: 'auto_tagging', status: 'done', durationMs: 1234 });
    expect(state.completions).toEqual([now + 1000]);
    expect(state.log).toHaveLength(0);
  });

  it('JOB_DONE with submitted:false logs a warning', () => {
    let state = reduceNodeEvent(initialDashboardState(1), NODE_EV.JOB_START, { jobId: 'j1', type: 't' }, now);
    state = reduceNodeEvent(state, NODE_EV.JOB_DONE, { jobId: 'j1', type: 't', submitted: false }, now);
    expect(state.log).toHaveLength(1);
    expect(state.log[0].level).toBe('warn');
    expect(state.log[0].msg).toMatch(/result endpoint unavailable/);
  });

  it('JOB_ERROR moves the job to history as an error, increments failed, and logs', () => {
    let state = reduceNodeEvent(initialDashboardState(1), NODE_EV.JOB_START, { jobId: 'j1', type: 't' }, now);
    state = reduceNodeEvent(state, NODE_EV.JOB_ERROR, { jobId: 'j1', type: 't', error: 'boom', willRetry: false }, now);
    expect(state.activeJobs.j1).toBeUndefined();
    expect(state.counters.failed).toBe(1);
    expect(state.history[0]).toMatchObject({ jobId: 'j1', status: 'error', error: 'boom' });
    expect(state.log).toHaveLength(1);
    expect(state.log[0].level).toBe('error');
    expect(state.log[0].msg).toMatch(/boom/);
  });

  it('history ring is capped at MAX_HISTORY', () => {
    let state = initialDashboardState(1);
    for (let i = 0; i < MAX_HISTORY + 5; i++) {
      state = reduceNodeEvent(state, NODE_EV.JOB_START, { jobId: `j${i}`, type: 't' }, now);
      state = reduceNodeEvent(state, NODE_EV.JOB_DONE, { jobId: `j${i}`, type: 't', submitted: true }, now);
    }
    expect(state.history).toHaveLength(MAX_HISTORY);
    expect(state.history[state.history.length - 1].jobId).toBe(`j${MAX_HISTORY + 4}`);
  });

  it('IDLE sets idle to true', () => {
    const next = reduceNodeEvent(initialDashboardState(1), NODE_EV.IDLE, { pollIntervalMs: 5000 }, now);
    expect(next.idle).toBe(true);
  });

  it('HEARTBEAT_OK sets heartbeat ok with the given timestamp', () => {
    const next = reduceNodeEvent(initialDashboardState(1), NODE_EV.HEARTBEAT_OK, { at: '2026-01-01T00:00:00Z' }, now);
    expect(next.heartbeat).toEqual({ ok: true, at: '2026-01-01T00:00:00Z' });
  });

  it('HEARTBEAT_FAIL sets heartbeat not-ok, preserves last-ok timestamp, and logs', () => {
    let state = reduceNodeEvent(initialDashboardState(1), NODE_EV.HEARTBEAT_OK, { at: 'T1' }, now);
    state = reduceNodeEvent(state, NODE_EV.HEARTBEAT_FAIL, { error: 'timeout' }, now);
    expect(state.heartbeat).toEqual({ ok: false, at: 'T1' });
    expect(state.log[0].msg).toMatch(/timeout/);
  });

  it('MODEL_LOADED sets a human-readable modelStatus string', () => {
    const next = reduceNodeEvent(
      initialDashboardState(1),
      NODE_EV.MODEL_LOADED,
      { targetDir: '/models', downloaded: 2, present: 1, failed: 0 },
      now,
    );
    expect(next.modelStatus).toBe('Models loaded from /models (2 downloaded, 1 present)');
  });

  it('MODEL_LOADED includes the failed count when non-zero', () => {
    const next = reduceNodeEvent(
      initialDashboardState(1),
      NODE_EV.MODEL_LOADED,
      { targetDir: '/models', downloaded: 1, present: 0, failed: 1 },
      now,
    );
    expect(next.modelStatus).toContain('1 failed');
  });

  it('STOPPED clears active jobs, idle, and draining, and sets stopped', () => {
    let state = reduceNodeEvent(initialDashboardState(1), NODE_EV.JOB_START, { jobId: 'j1', type: 't' }, now);
    state = { ...state, draining: true, idle: true };
    state = reduceNodeEvent(state, NODE_EV.STOPPED, { reason: 'unmount' }, now);
    expect(state.activeJobs).toEqual({});
    expect(state.idle).toBe(false);
    expect(state.draining).toBe(false);
    expect(state.stopped).toBe(true);
  });

  it('an unknown event kind is a no-op', () => {
    const state = initialDashboardState(1);
    expect(reduceNodeEvent(state, 'not-a-real-event', {}, now)).toBe(state);
  });

  it('LEASE_RENEW is a no-op (no visible state change)', () => {
    const state = initialDashboardState(1);
    expect(reduceNodeEvent(state, NODE_EV.LEASE_RENEW, { jobId: 'j1' }, now)).toBe(state);
  });
});
