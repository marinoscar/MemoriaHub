// Pure helpers for `nodes.capability-health`: best-effort extraction of the
// degraded capability names from a node's arbitrary-shaped `capabilities` JSON
// (untrusted, node-reported). Moved unchanged from `DoctorService`.

/** Flatten a capability summary into { name, status } pairs, tolerating several shapes. */
export function collectCapabilityEntries(capabilities: unknown): Array<{ name: string; status: string }> {
  const out: Array<{ name: string; status: string }> = [];
  if (capabilities == null || typeof capabilities !== 'object') return out;

  const consider = (name: unknown, status: unknown): void => {
    if (typeof name !== 'string') return;
    if (typeof status === 'string') out.push({ name, status });
  };

  // Array of checks: [{ key|name, status }, ...]
  if (Array.isArray(capabilities)) {
    for (const item of capabilities) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        consider(rec['key'] ?? rec['name'], rec['status']);
      }
    }
    return out;
  }

  const record = capabilities as Record<string, unknown>;

  // Nested report shapes: { checks: [...] } or { capabilities: {...}/[...] }
  if (Array.isArray(record['checks'])) {
    out.push(...collectCapabilityEntries(record['checks']));
  }
  if (record['capabilities'] != null && typeof record['capabilities'] === 'object') {
    out.push(...collectCapabilityEntries(record['capabilities']));
  }

  // Flat map: { face: 'ok' } or { face: { status: 'error' } }
  for (const [name, value] of Object.entries(record)) {
    if (name === 'checks' || name === 'capabilities') continue;
    if (typeof value === 'string') {
      consider(name, value);
    } else if (value && typeof value === 'object') {
      const rec = value as Record<string, unknown>;
      if (typeof rec['status'] === 'string') {
        consider(name, rec['status']);
      } else if (rec['operational'] === false) {
        // #148: enriched worker-node capability payload — a startup operational
        // self-test that FAILED is a degrade distinct from a merely-absent
        // package (available:false with no operational field).
        consider(name, 'error');
      }
    }
  }

  return out;
}

export function isDegradedStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'error' || s === 'warning' || s === 'warn' || s === 'degraded' || s === 'fail' || s === 'failed';
}

/**
 * Whether a capability name backs at least one of the node's eligible job types.
 * Conservative: when the capability cannot be mapped or the node advertises no
 * eligible types, treat it as relevant so a genuine degradation is not hidden.
 */
export function capabilityBacksEligibleType(name: string, eligibleTypes: string[]): boolean {
  if (eligibleTypes.length === 0) return true;

  const capToJobTypes: Record<string, string[]> = {
    face: ['face_detection', 'video_face_detection'],
    compreface: ['face_detection', 'video_face_detection'],
    clip: ['duplicate_detection', 'duplicate_detection_batch'],
    onnxruntime: ['duplicate_detection', 'duplicate_detection_batch'],
    ocr: ['social_media_detection'],
    tesseract: ['social_media_detection'],
    ffprobe: ['video_face_detection', 'social_media_detection', 'video_auto_tagging'],
    ffmpeg: ['video_face_detection', 'social_media_detection', 'video_auto_tagging'],
    sharp: [
      'face_detection',
      'auto_tagging',
      'video_auto_tagging',
      'duplicate_detection',
      'duplicate_detection_batch',
      'thumbnail_regen',
    ],
  };

  const key = Object.keys(capToJobTypes).find((k) => name.toLowerCase().includes(k));
  if (!key) return true; // unknown capability — surface it rather than silently drop

  return capToJobTypes[key].some((t) => eligibleTypes.includes(t));
}

/** Degraded capability names backing one of the node's advertised `eligibleTypes`. */
export function extractDegradedCapabilities(capabilities: unknown, eligibleTypes: string[]): string[] {
  const degraded = new Set<string>();
  for (const { name, status } of collectCapabilityEntries(capabilities)) {
    if (!isDegradedStatus(status)) continue;
    if (capabilityBacksEligibleType(name, eligibleTypes)) degraded.add(name);
  }
  return [...degraded];
}
