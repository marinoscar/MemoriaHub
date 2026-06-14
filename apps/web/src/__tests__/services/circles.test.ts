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
  getCircle,
  createCircle,
  updateCircle,
  deleteCircle,
  listMembers,
  addMember,
  updateMemberRole,
  removeMember,
  listInvites,
  createInvite,
  revokeInvite,
} from '../../services/circles';
import type { Circle, CircleMember, CircleInvite } from '../../types/circles';

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

const mockMember: CircleMember = {
  id: 'member-1',
  circleId: 'circle-1',
  userId: 'user-1',
  role: 'circle_admin',
  createdAt: '2024-01-01T00:00:00.000Z',
  user: {
    id: 'user-1',
    email: 'user@example.com',
    displayName: 'Test User',
    profileImageUrl: null,
  },
};

const mockInvite: CircleInvite = {
  id: 'invite-1',
  circleId: 'circle-1',
  email: 'invited@example.com',
  role: 'viewer',
  notes: null,
  addedById: 'user-1',
  addedAt: '2024-01-01T00:00:00.000Z',
  claimedById: null,
  claimedAt: null,
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

describe('getCircle', () => {
  it('fetches a single circle by id', async () => {
    server.use(
      http.get('/api/circles/:id', () => HttpResponse.json(mockCircle)),
    );

    const result = await getCircle('circle-1');
    expect(result.id).toBe('circle-1');
    expect(result.name).toBe('Personal Library');
  });
});

describe('createCircle', () => {
  it('POSTs to /circles and returns the new circle', async () => {
    let body: unknown;
    server.use(
      http.post('/api/circles', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(mockCircle, { status: 201 });
      }),
    );

    const result = await createCircle({ name: 'Personal Library' });
    expect(result.id).toBe('circle-1');
    expect(body).toMatchObject({ name: 'Personal Library' });
  });
});

describe('updateCircle', () => {
  it('PATCHes /circles/:id with the dto', async () => {
    let body: unknown;
    server.use(
      http.patch('/api/circles/:id', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...mockCircle, name: 'Updated Name' });
      }),
    );

    const result = await updateCircle('circle-1', { name: 'Updated Name' });
    expect(result.name).toBe('Updated Name');
    expect(body).toMatchObject({ name: 'Updated Name' });
  });
});

describe('deleteCircle', () => {
  it('DELETEs /circles/:id', async () => {
    let called = false;
    server.use(
      http.delete('/api/circles/:id', () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await deleteCircle('circle-1');
    expect(called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

describe('listMembers', () => {
  it('fetches members for a circle', async () => {
    server.use(
      http.get('/api/circles/:id/members', () =>
        HttpResponse.json({ items: [mockMember], total: 1 }),
      ),
    );

    const result = await listMembers('circle-1');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].userId).toBe('user-1');
  });
});

describe('addMember', () => {
  it('POSTs to /circles/:id/members', async () => {
    let body: unknown;
    server.use(
      http.post('/api/circles/:id/members', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(mockMember, { status: 201 });
      }),
    );

    const result = await addMember('circle-1', { userId: 'user-1', role: 'circle_admin' });
    expect(result.userId).toBe('user-1');
    expect(body).toMatchObject({ userId: 'user-1', role: 'circle_admin' });
  });
});

describe('updateMemberRole', () => {
  it('PATCHes /circles/:id/members/:userId with the new role', async () => {
    let body: unknown;
    server.use(
      http.patch('/api/circles/:id/members/:userId', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...mockMember, role: 'collaborator' });
      }),
    );

    const result = await updateMemberRole('circle-1', 'user-1', 'collaborator');
    expect(result.role).toBe('collaborator');
    expect(body).toMatchObject({ role: 'collaborator' });
  });
});

describe('removeMember', () => {
  it('DELETEs /circles/:id/members/:userId', async () => {
    let called = false;
    server.use(
      http.delete('/api/circles/:id/members/:userId', () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await removeMember('circle-1', 'user-1');
    expect(called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

describe('listInvites', () => {
  it('fetches invites for a circle', async () => {
    server.use(
      http.get('/api/circles/:id/invites', () =>
        HttpResponse.json({ items: [mockInvite], total: 1 }),
      ),
    );

    const result = await listInvites('circle-1');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].email).toBe('invited@example.com');
  });
});

describe('createInvite', () => {
  it('POSTs to /circles/:id/invites with email and role', async () => {
    let body: unknown;
    server.use(
      http.post('/api/circles/:id/invites', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(mockInvite, { status: 201 });
      }),
    );

    const result = await createInvite('circle-1', {
      email: 'invited@example.com',
      role: 'viewer',
    });
    expect(result.id).toBe('invite-1');
    expect(body).toMatchObject({ email: 'invited@example.com', role: 'viewer' });
  });

  it('includes notes when provided', async () => {
    let body: unknown;
    server.use(
      http.post('/api/circles/:id/invites', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(mockInvite, { status: 201 });
      }),
    );

    await createInvite('circle-1', {
      email: 'invited@example.com',
      role: 'collaborator',
      notes: 'Welcome!',
    });
    expect(body).toMatchObject({ notes: 'Welcome!' });
  });
});

describe('revokeInvite', () => {
  it('DELETEs /circles/:id/invites/:inviteId', async () => {
    let called = false;
    server.use(
      http.delete('/api/circles/:id/invites/:inviteId', () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await revokeInvite('circle-1', 'invite-1');
    expect(called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// beforeEach — reset captured state
// ---------------------------------------------------------------------------

beforeEach(() => {
  // server.resetHandlers() is called in afterEach by the global setup
});
