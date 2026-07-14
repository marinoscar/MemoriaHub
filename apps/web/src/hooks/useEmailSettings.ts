import { useState, useCallback } from 'react';
import {
  getEmailSettings,
  updateEmailSettings,
  testEmail,
} from '../services/email';
import type {
  EmailSettings,
  UpdateEmailSettingsBody,
  TestEmailResult,
} from '../services/email';

export function useEmailSettings() {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getEmailSettings();
      setSettings(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load email settings');
    } finally {
      setLoading(false);
    }
  }, []);

  const saveSettings = useCallback(
    async (body: UpdateEmailSettingsBody): Promise<EmailSettings> => {
      const updated = await updateEmailSettings(body);
      setSettings(updated);
      return updated;
    },
    [],
  );

  const sendTest = useCallback(
    async (recipient: string): Promise<TestEmailResult> => {
      return testEmail(recipient);
    },
    [],
  );

  return {
    settings,
    loading,
    error,
    fetchSettings,
    saveSettings,
    sendTest,
  };
}
