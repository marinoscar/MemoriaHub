/** A throwaway HTTP server standing in for the MemoriaHub API (issue #517 specs). */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

export type Handler = (request: Recorded) => { status: number; body?: unknown };

export interface MockServer {
  url: string;
  requests: Recorded[];
  close(): Promise<void>;
}

export async function startMockServer(handler: Handler): Promise<MockServer> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(recorded);
      const { status, body } = handler(recorded);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The `name="…"` of every multipart part, in wire order. */
export function multipartFieldOrder(body: Buffer): string[] {
  return [...body.toString('latin1').matchAll(/Content-Disposition: form-data; name="([^"]+)"/g)].map((match) => match[1] as string);
}

export function multipartField(body: Buffer, name: string): string | undefined {
  const match = new RegExp(`name="${name}"(?:; filename="[^"]*")?\\r\\n(?:Content-Type: [^\\r]+\\r\\n)?\\r\\n([\\s\\S]*?)\\r\\n--`).exec(
    body.toString('latin1'),
  );
  return match?.[1];
}

export const release = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  packageName: 'memoriahub.marin.cr',
  versionName: '2.0.0',
  versionCode: 100,
  signingSha256: 'AA:BB',
  fileSha256: 'c'.repeat(64),
  sizeBytes: '2036135',
  notes: null,
  isCurrent: true,
  createdAt: '2026-10-02T01:00:00.000Z',
  uploadedBy: null,
  ...overrides,
});

export const reasonError = (status: number, reason: string, message = 'Refused') => ({
  status,
  body: { statusCode: status, code: status === 409 ? 'CONFLICT' : status === 404 ? 'NOT_FOUND' : 'ERROR', message, details: { reason } },
});
