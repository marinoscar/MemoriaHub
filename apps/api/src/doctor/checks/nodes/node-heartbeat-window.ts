/** Heartbeat freshness window (ms); mirrors NodesService's NODE_HEARTBEAT_STALE_SECONDS convention. */
export function nodeStaleWindowMs(): number {
  return (Number(process.env['NODE_HEARTBEAT_STALE_SECONDS']) || 60) * 1000;
}
