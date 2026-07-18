import { useState, useEffect } from 'react';
import { ApiError } from '../services/api';
import type { SubjectRegistryEntry } from '../types/workflows';
import { getWorkflowSubjects } from '../services/workflows';

// ---------------------------------------------------------------------------
// Feature-gate probe
//
// `GET /workflows/subjects` doubles as the client feature-gate mechanism:
//   - 200 → `features.workflows` is ON; response carries the subject registry
//   - 404 → the feature is OFF (no error surfaced)
//   - any other error → fail closed (enabled = false, error set)
//
// It requires only media:read (which every circle member holds), so it works
// for non-admins where there is no dedicated feature-flag endpoint.
// ---------------------------------------------------------------------------

interface ProbeResult {
  subjects: SubjectRegistryEntry[] | null;
  enabled: boolean;
  error: string | null;
}

// Module-level cache so multiple mounts (Sidebar + a page) share one request.
let probePromise: Promise<ProbeResult> | null = null;

function runProbe(): Promise<ProbeResult> {
  if (!probePromise) {
    probePromise = getWorkflowSubjects()
      .then((response): ProbeResult => ({
        subjects: response.subjects,
        enabled: true,
        error: null,
      }))
      .catch((err): ProbeResult => {
        if (err instanceof ApiError && err.status === 404) {
          // Feature is off — not an error condition.
          return { subjects: null, enabled: false, error: null };
        }
        const message = err instanceof Error ? err.message : 'Failed to load workflows';
        // Fail closed on any other error.
        return { subjects: null, enabled: false, error: message };
      });
  }
  return probePromise;
}

interface UseWorkflowSubjectsResult {
  subjects: SubjectRegistryEntry[] | null;
  enabled: boolean | null;
  isLoading: boolean;
  error: string | null;
}

export function useWorkflowSubjects(): UseWorkflowSubjectsResult {
  const [subjects, setSubjects] = useState<SubjectRegistryEntry[] | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    runProbe().then((result) => {
      if (!active) return;
      setSubjects(result.subjects);
      setEnabled(result.enabled);
      setError(result.error);
      setIsLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  return { subjects, enabled, isLoading, error };
}

/**
 * Lightweight feature-gate hook reusing the same cached probe.
 * Returns `null` while the probe is still loading, then `true`/`false`.
 */
export function useWorkflowsEnabled(): boolean | null {
  const { enabled, isLoading } = useWorkflowSubjects();
  return isLoading ? null : enabled;
}
