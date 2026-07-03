import { useState, useCallback, useEffect } from 'react';
import { runDoctor } from '../services/doctor';
import type { DoctorReport } from '../services/doctor';

export interface UseDoctorResult {
  report: DoctorReport | null;
  loading: boolean;
  error: string | null;
  run: () => Promise<void>;
}

export function useDoctor(): UseDoctorResult {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await runDoctor();
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run diagnostics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  return { report, loading, error, run };
}
