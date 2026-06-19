// Stateless SSE client for the /api/search/agent endpoint.
// Sends the FULL message history each call; backend is stateless.
import { api } from './api';
import type { MediaItem, MediaListMeta } from '../types/media';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentStreamHandlers {
  onToken?: (text: string) => void;
  onToolCall?: (data: { name: string; args: Record<string, unknown> }) => void;
  onResults?: (data: { items: MediaItem[]; meta: MediaListMeta }) => void;
  onDone?: () => void;
  onError?: (data: { message: string }) => void;
}

export async function streamAgent(
  body: { circleId: string; messages: ChatMsg[] },
  handlers: AgentStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  // Build auth headers same as searchStream.ts did
  const token = api.getAccessToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };
  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}/search/agent`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as { message?: string }).message ?? 'Agent stream failed');
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

      // SSE frames are delimited by double newline
      const frames = buffer.split('\n\n');
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
            case 'token':
              handlers.onToken?.((parsed as { text: string }).text);
              break;
            case 'tool_call':
              handlers.onToolCall?.(parsed as { name: string; args: Record<string, unknown> });
              break;
            case 'results':
              handlers.onResults?.(parsed as { items: MediaItem[]; meta: MediaListMeta });
              break;
            case 'done':
              handlers.onDone?.();
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
