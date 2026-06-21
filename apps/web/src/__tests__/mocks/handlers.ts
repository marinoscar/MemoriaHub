import { http, HttpResponse } from 'msw';

// Use wildcard pattern to match relative URLs
const API_BASE = '*/api';

// Mock data
const mockUser = {
  id: 'test-user-id',
  email: 'test@example.com',
  displayName: 'Test User',
  profileImageUrl: null,
  roles: [{ name: 'viewer' }],
  permissions: ['user_settings:read', 'user_settings:write'],
  isActive: true,
  createdAt: new Date().toISOString(),
};

const mockUserSettings = {
  theme: 'system',
  profile: {
    displayName: null,
    useProviderImage: true,
    customImageUrl: null,
  },
  activeCircleId: 'circle-1',
  updatedAt: new Date().toISOString(),
  version: 1,
};

const mockSystemSettings = {
  ui: {
    allowUserThemeOverride: true,
  },
  features: {},
  updatedAt: new Date().toISOString(),
  updatedBy: null,
  version: 1,
};

const mockProviders = [
  { name: 'google', authUrl: '/api/auth/google' },
];

export const handlers = [
  // Auth endpoints
  http.get(`${API_BASE}/auth/providers`, () => {
    // Real API returns { providers: [...] } which gets unwrapped by api.ts
    return HttpResponse.json({ providers: mockProviders });
  }),

  http.get(`${API_BASE}/auth/me`, () => {
    return HttpResponse.json({ data: mockUser });
  }),

  http.post(`${API_BASE}/auth/logout`, () => {
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${API_BASE}/auth/refresh`, () => {
    return HttpResponse.json({
      accessToken: 'new-mock-token',
      expiresIn: 900,
    });
  }),

  // User settings endpoints
  http.get(`${API_BASE}/user-settings`, () => {
    return HttpResponse.json({ data: mockUserSettings });
  }),

  http.put(`${API_BASE}/user-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...mockUserSettings,
        ...body,
        version: mockUserSettings.version + 1,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...mockUserSettings,
        ...body,
        version: mockUserSettings.version + 1,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  // System settings endpoints
  http.get(`${API_BASE}/system-settings`, () => {
    return HttpResponse.json({ data: mockSystemSettings });
  }),

  http.patch(`${API_BASE}/system-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...mockSystemSettings,
        ...body,
        version: mockSystemSettings.version + 1,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  http.put(`${API_BASE}/system-settings`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        ...body,
        updatedAt: new Date().toISOString(),
        updatedBy: null,
        version: 1,
      },
    });
  }),

  // Users endpoints
  http.get(`${API_BASE}/users`, () => {
    return HttpResponse.json({
      items: [
        {
          id: mockUser.id,
          email: mockUser.email,
          displayName: mockUser.displayName,
          providerDisplayName: 'Test User (Provider)',
          profileImageUrl: mockUser.profileImageUrl,
          providerProfileImageUrl: null,
          isActive: mockUser.isActive,
          roles: mockUser.roles.map((r) => r.name),
          createdAt: mockUser.createdAt,
          updatedAt: mockUser.createdAt,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
    });
  }),

  http.get(`${API_BASE}/users/:id`, ({ params }) => {
    if (params.id === mockUser.id) {
      return HttpResponse.json({ data: mockUser });
    }
    return new HttpResponse(null, { status: 404 });
  }),

  http.patch(`${API_BASE}/users/:id`, async ({ params, request }) => {
    if (params.id === mockUser.id) {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        id: mockUser.id,
        email: mockUser.email,
        displayName: (body.displayName as string | null) ?? mockUser.displayName,
        providerDisplayName: 'Test User (Provider)',
        profileImageUrl: mockUser.profileImageUrl,
        providerProfileImageUrl: null,
        isActive: body.isActive !== undefined ? (body.isActive as boolean) : mockUser.isActive,
        roles: mockUser.roles.map((r) => r.name),
        createdAt: mockUser.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }
    return HttpResponse.json({ message: 'Not found' }, { status: 404 });
  }),

  http.put(`${API_BASE}/users/:id/roles`, async ({ params, request }) => {
    if (params.id === mockUser.id) {
      const body = (await request.json()) as { roles: string[] };
      return HttpResponse.json({
        id: mockUser.id,
        email: mockUser.email,
        displayName: mockUser.displayName,
        providerDisplayName: 'Test User (Provider)',
        profileImageUrl: mockUser.profileImageUrl,
        providerProfileImageUrl: null,
        isActive: mockUser.isActive,
        roles: body.roles,
        createdAt: mockUser.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }
    return HttpResponse.json({ message: 'Not found' }, { status: 404 });
  }),

  // Health endpoints
  http.get(`${API_BASE}/health/live`, () => {
    return HttpResponse.json({
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
      },
    });
  }),

  http.get(`${API_BASE}/health/ready`, () => {
    return HttpResponse.json({
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
        checks: {
          database: 'ok',
        },
      },
    });
  }),

  // Device Authorization endpoints
  http.get(`${API_BASE}/auth/device/activate`, ({ request }) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');

    // Default success response
    return HttpResponse.json({
      data: {
        userCode: code || 'ABCD-1234',
        clientInfo: {
          deviceName: 'My Smart TV',
          userAgent: 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
          ipAddress: '192.168.1.100',
        },
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    });
  }),

  http.post(`${API_BASE}/auth/device/authorize`, async ({ request }) => {
    const body = (await request.json()) as { userCode: string; approve: boolean };

    return HttpResponse.json({
      data: {
        success: body.approve,
        message: body.approve
          ? 'Device authorized successfully!'
          : 'Device access denied.',
      },
    });
  }),

  // Media endpoints
  http.get(`${API_BASE}/media`, () => {
    return HttpResponse.json({ items: [], meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } });
  }),

  http.get(`${API_BASE}/media/tags`, () => {
    return HttpResponse.json([]);
  }),

  http.get(`${API_BASE}/media/albums`, () => {
    return HttpResponse.json({ items: [], meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } });
  }),

  http.get(`${API_BASE}/media/dashboard`, () => {
    return HttpResponse.json({
      onThisDay: [],
      recent: [],
      favorites: [],
      counts: { total: 0, unreviewed: 0, lowValue: 0, missingGeo: 0 },
    });
  }),

  http.get(`${API_BASE}/media/geo/reverse`, () => {
    return HttpResponse.json(null);
  }),

  http.get(`${API_BASE}/media/geo/search`, () => {
    return new HttpResponse(null, { status: 503 });
  }),

  http.patch(`${API_BASE}/media/bulk`, () => {
    return HttpResponse.json({ updated: 0 });
  }),

  http.post(`${API_BASE}/media/bulk/tags`, () => {
    return HttpResponse.json({ added: 0, removed: 0 });
  }),

  http.post(`${API_BASE}/media/bulk/delete`, () => {
    return HttpResponse.json({ deleted: 0 });
  }),

  http.get(`${API_BASE}/media/locations`, () => {
    return HttpResponse.json([]);
  }),

  http.get(`${API_BASE}/media/:id`, ({ params }) => {
    return HttpResponse.json({
      id: params.id,
      storageObjectId: 'obj-1',
      addedById: 'test-user-id',
      circleId: 'circle-1',
      type: 'photo',
      capturedAt: null,
      capturedAtOffset: null,
      importedAt: new Date().toISOString(),
      source: 'web',
      contentHash: null,
      width: null,
      height: null,
      durationMs: null,
      orientation: null,
      takenLat: null,
      takenLng: null,
      takenAltitude: null,
      cameraMake: null,
      cameraModel: null,
      originalFilename: 'test.jpg',
      caption: null,
      description: null,
      favorite: false,
      geoCountry: null,
      geoCountryCode: null,
      geoAdmin1: null,
      geoAdmin2: null,
      geoLocality: null,
      geoPlaceName: null,
      geoSource: null,
      geocodedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      metadata: null,
      thumbnailUrl: null,
      downloadUrl: null,
      tags: [],
    });
  }),

  http.patch(`${API_BASE}/media/:id`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({ ...body, id: 'test-id', updatedAt: new Date().toISOString() });
  }),

  // Circles endpoints
  http.get(`${API_BASE}/circles`, () => {
    return HttpResponse.json({
      items: [
        {
          id: 'circle-1',
          name: "Test User's Library",
          description: null,
          ownerId: 'test-user-id',
          isPersonal: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
    });
  }),

  http.get(`${API_BASE}/circles/:id`, ({ params }) => {
    return HttpResponse.json({
      id: params.id,
      name: "Test User's Library",
      description: null,
      ownerId: 'test-user-id',
      isPersonal: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }),

  http.get(`${API_BASE}/circles/:id/members`, () => {
    return HttpResponse.json({ items: [], total: 0 });
  }),

  http.get(`${API_BASE}/circles/:id/invites`, () => {
    return HttpResponse.json({ items: [], total: 0 });
  }),

  http.post(`${API_BASE}/circles`, async ({ request }) => {
    const body = (await request.json()) as { name: string; description?: string };
    return HttpResponse.json(
      {
        id: 'new-circle-id',
        ...body,
        ownerId: 'test-user-id',
        isPersonal: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { status: 201 },
    );
  }),
];

// Named handler variants for use with server.use(...) in individual tests
export const geoSearchSuccessHandler = http.get(`${API_BASE}/media/geo/search`, ({ request }) => {
  const url = new URL(request.url);
  const q = url.searchParams.get('q') ?? '';
  return HttpResponse.json([{ lat: 10, lng: 20, label: `Result for ${q}` }]);
});
