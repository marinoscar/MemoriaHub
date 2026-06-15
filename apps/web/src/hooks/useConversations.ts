import { useState, useCallback } from 'react';
import {
  listConversations,
  getConversation,
  createConversation,
  patchConversation,
  deleteConversation,
} from '../services/search';
import type { Conversation, ConversationDetail } from '../services/search';

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchConversations = useCallback(
    async (params: {
      circleId?: string;
      favorite?: boolean;
      archived?: boolean;
    }) => {
      setLoading(true);
      setError(null);
      try {
        const resp = await listConversations(params);
        setConversations(resp.items);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load conversations');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const loadConversation = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const conv = await getConversation(id);
      setActiveConversation(conv);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conversation');
    } finally {
      setLoading(false);
    }
  }, []);

  const createNew = useCallback(async (circleId: string): Promise<Conversation> => {
    const conv = await createConversation(circleId);
    setConversations((prev) => [conv, ...prev]);
    return conv;
  }, []);

  const updateConversation = useCallback(
    async (id: string, body: { title?: string; favorite?: boolean; archived?: boolean }) => {
      const updated = await patchConversation(id, body);
      setConversations((prev) => prev.map((c) => (c.id === id ? updated : c)));
      if (activeConversation?.id === id) {
        setActiveConversation((prev) => (prev ? { ...prev, ...updated } : prev));
      }
      return updated;
    },
    [activeConversation?.id],
  );

  const removeConversation = useCallback(async (id: string) => {
    await deleteConversation(id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeConversation?.id === id) {
      setActiveConversation(null);
    }
  }, [activeConversation?.id]);

  return {
    conversations,
    activeConversation,
    loading,
    error,
    fetchConversations,
    loadConversation,
    createNew,
    updateConversation,
    removeConversation,
  };
}
