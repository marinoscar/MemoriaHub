/**
 * services/circles — covers the HTTP calls for circle CRUD, members, and invites.
 *
 * Uses MSW to intercept fetch calls made by the api singleton, keeping tests
 * independent of any implementation detail in the HTTP layer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  listCircles,
} from '../../services/circles';
import type { Circle } from '../../types/circles';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const mockCircle: Circle = {
  id: 'circle-1',
  name: 'Personal Library',
  description: null,
  ownerId: 'user-1',
  isPersonal: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Circle CRUD
// ---------------------------------------------------------------------------

describe('listCircles', () => {
  it('fetches circles without query string by default', async () => {
    let capturedUrl = '';
    server.use(
      http.get('/api/circles', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({
          items: [mockCircle],
          total: 1,
          page: 1,
          pageSize: 20,
          totalPages: 1,
        });
      }),
    );

    const result = await listCircles();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('circle-1');
    expect(capturedUrl).not.toContain('all=true');
  });

  it('appends ?all=true when all flag is passed', async () => {
    let capturedUrl = '';
    server.use(
      http.get('/api/circles', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({
          items: [mockCircle],
          total: 1,
          page: 1,
          pageSize: 20,
          totalPages: 1,
        });
      }),
    );

    await listCircles(true);
    expect(capturedUrl).toContain('all=true');
  });
});
