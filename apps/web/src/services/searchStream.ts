import { api } from './api';
import type { MediaItem, MediaListMeta } from '../types/media';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export interface StreamHandlers {
  onToolCall?: (data: { name: string; args: Record<string, unknown> }) => void;
  onToken?: (text: string) => void;
  onResults?: (data: { items: MediaItem[]; meta: MediaListMeta }) => void;
  onDone?: (data: { messageId: string }) => void;
  onError?: (data: { message: string }) => void;
}

export async function streamMessage(
  conversationId: string,
  content: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const token = api.getAccessToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };
  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(
    `${API_BASE_URL}/search/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ content }),
      signal,
    },
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as { message?: string }).message ?? 'Stream failed');
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double newline (SSE frame boundary)
      const frames = buffer.split('\n\n');
      // Keep the last (potentially incomplete) frame in the buffer
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        if (!frame.trim()) continue;
        const lines = frame.split('\n');
        let eventType = 'message';
        let dataLine = '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLine = line.slice(5).trim();
          }
        }

        if (!dataLine) continue;

        try {
          const parsed = JSON.parse(dataLine);
          switch (eventType) {
            case 'tool_call':
              handlers.onToolCall?.(parsed as { name: string; args: Record<string, unknown> });
              break;
            case 'token':
              handlers.onToken?.((parsed as { text: string }).text);
              break;
            case 'results':
              handlers.onResults?.(parsed as { items: MediaItem[]; meta: MediaListMeta });
              break;
            case 'done':
              handlers.onDone?.(parsed as { messageId: string });
              break;
            case 'error':
              handlers.onError?.(parsed as { message: string });
              break;
          }
        } catch {
          // ignore malformed JSON frames
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
