import { useState, useCallback, useEffect } from 'react';
import { runDoctor } from '../services/doctor';
import { useIsMounted } from './useIsMounted';
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
  const isMounted = useIsMounted();

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await runDoctor();
      if (!isMounted()) return;
      setReport(data);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to run diagnostics');
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void run();
  }, [run]);

  return { report, loading, error, run };
}
