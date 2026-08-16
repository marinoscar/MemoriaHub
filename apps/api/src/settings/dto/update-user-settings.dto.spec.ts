import {
  updateUserSettingsSchema,
  patchUserSettingsSchema,
  UpdateUserSettingsDto,
  PatchUserSettingsDto,
} from './update-user-settings.dto';
import {
  DATA_TABLE_MAX_TABLES,
  DATA_TABLE_MAX_VISIBLE_COLUMNS,
  DATA_TABLE_MAX_ID_LENGTH,
  DATA_TABLE_MAX_PAGE_SIZE,
  NAVIGATION_MAX_PINNED,
  NAVIGATION_PINNABLE_KEYS,
} from '../../common/schemas/settings.schema';

/** Minimal valid PUT body; spread a `dataTables` onto it per case. */
const basePut = {
  theme: 'light' as const,
  profile: { useProviderImage: true },
};

describe('UpdateUserSettingsDto (PUT)', () => {
  describe('theme field', () => {
    it('should accept "light" theme value', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          useProviderImage: true,
        },
      });

      expect(result.theme).toBe('light');
    });

    it('should accept "dark" theme value', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'dark',
        profile: {
          useProviderImage: true,
        },
      });

      expect(result.theme).toBe('dark');
    });

    it('should accept "system" theme value', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'system',
        profile: {
          useProviderImage: true,
        },
      });

      expect(result.theme).toBe('system');
    });

    it('should reject invalid theme value', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'blue',
          profile: {
            useProviderImage: true,
          },
        }),
      ).toThrow();
    });

    it('should reject empty string as theme', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: '',
          profile: {
            useProviderImage: true,
          },
        }),
      ).toThrow();
    });

    it('should require theme field', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          profile: {
            useProviderImage: true,
          },
        }),
      ).toThrow();
    });
  });

  describe('profile field', () => {
    it('should accept valid profile object', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          displayName: 'John Doe',
          useProviderImage: false,
          customImageUrl: 'https://example.com/image.jpg',
        },
      });

      expect(result.profile.displayName).toBe('John Doe');
      expect(result.profile.useProviderImage).toBe(false);
      expect(result.profile.customImageUrl).toBe('https://example.com/image.jpg');
    });

    it('should accept profile with null customImageUrl', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          useProviderImage: true,
          customImageUrl: null,
        },
      });

      expect(result.profile.customImageUrl).toBeNull();
    });

    it('should make displayName optional', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          useProviderImage: true,
        },
      });

      expect(result.profile.displayName).toBeUndefined();
    });

    it('should accept empty displayName string', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          displayName: '',
          useProviderImage: true,
        },
      });

      expect(result.profile.displayName).toBe('');
    });

    it('should accept displayName at maximum length (100 chars)', () => {
      const longName = 'a'.repeat(100);
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          displayName: longName,
          useProviderImage: true,
        },
      });

      expect(result.profile.displayName).toBe(longName);
    });

    it('should reject displayName longer than 100 characters', () => {
      const tooLongName = 'a'.repeat(101);
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'light',
          profile: {
            displayName: tooLongName,
            useProviderImage: true,
          },
        }),
      ).toThrow();
    });

    it('should require useProviderImage field', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'light',
          profile: {
            displayName: 'Test',
          },
        }),
      ).toThrow();
    });

    it('should reject non-boolean useProviderImage', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'light',
          profile: {
            useProviderImage: 'true',
          },
        }),
      ).toThrow();
    });

    it('should accept valid URL for customImageUrl', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          useProviderImage: false,
          customImageUrl: 'https://cdn.example.com/user/profile.png',
        },
      });

      expect(result.profile.customImageUrl).toBe(
        'https://cdn.example.com/user/profile.png',
      );
    });

    it('should accept http URL for customImageUrl', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          useProviderImage: false,
          customImageUrl: 'http://example.com/image.jpg',
        },
      });

      expect(result.profile.customImageUrl).toBe('http://example.com/image.jpg');
    });

    it('should reject invalid URL for customImageUrl', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'light',
          profile: {
            useProviderImage: false,
            customImageUrl: 'not-a-valid-url',
          },
        }),
      ).toThrow();
    });

    it('should make customImageUrl optional', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          useProviderImage: true,
        },
      });

      expect(result.profile.customImageUrl).toBeUndefined();
    });

    it('should require profile field', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'light',
        }),
      ).toThrow();
    });
  });

  describe('complete settings object', () => {
    it('should accept valid complete user settings', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'dark',
        profile: {
          displayName: 'Jane Doe',
          useProviderImage: false,
          customImageUrl: 'https://example.com/jane.jpg',
        },
      });

      expect(result).toEqual({
        theme: 'dark',
        profile: {
          displayName: 'Jane Doe',
          useProviderImage: false,
          customImageUrl: 'https://example.com/jane.jpg',
        },
      });
    });

    it('should accept minimal valid settings', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'system',
        profile: {
          useProviderImage: true,
        },
      });

      expect(result).toEqual({
        theme: 'system',
        profile: {
          useProviderImage: true,
        },
      });
    });
  });

  // ===========================================================================
  // dataTables (issue #255)
  // ===========================================================================

  describe('dataTables field', () => {
    describe('absent-key fallback (defaults are NEVER materialized)', () => {
      it('should leave the whole namespace absent when not supplied', () => {
        const result = updateUserSettingsSchema.parse(basePut);

        expect(result.dataTables).toBeUndefined();
        expect('dataTables' in result).toBe(false);
      });

      it('should NOT materialize visibleColumns as [] for an entry that omits it', () => {
        const result = updateUserSettingsSchema.parse({
          ...basePut,
          dataTables: { jobs: { density: 'compact' } },
        });

        // The load-bearing assertion: an absent visibleColumns must stay
        // absent so the client falls back to the column contract's
        // priority-derived defaults and newly added columns still appear.
        expect(result.dataTables!.jobs.visibleColumns).toBeUndefined();
        expect(result.dataTables!.jobs).toEqual({ density: 'compact' });
      });

      it('should keep an empty entry empty rather than filling in a default layout', () => {
        const result = updateUserSettingsSchema.parse({
          ...basePut,
          dataTables: { jobs: {} },
        });

        expect(result.dataTables).toEqual({ jobs: {} });
      });

      it('should leave every sub-key absent independently', () => {
        const result = updateUserSettingsSchema.parse({
          ...basePut,
          dataTables: { jobs: { pageSize: 25 } },
        });

        expect(result.dataTables!.jobs).toEqual({ pageSize: 25 });
        expect(result.dataTables!.jobs.density).toBeUndefined();
        expect(result.dataTables!.jobs.sort).toBeUndefined();
        expect(result.dataTables!.jobs.visibleColumns).toBeUndefined();
      });
    });

    describe('valid payloads', () => {
      it('should accept a fully populated entry', () => {
        const entry = {
          visibleColumns: ['type', 'status', 'lastError'],
          density: 'comfortable' as const,
          sort: { field: 'createdAt', direction: 'desc' as const },
          pageSize: 50,
        };

        const result = updateUserSettingsSchema.parse({
          ...basePut,
          dataTables: { 'admin-jobs': entry },
        });

        expect(result.dataTables!['admin-jobs']).toEqual(entry);
      });

      it('should accept multiple table ids', () => {
        const result = updateUserSettingsSchema.parse({
          ...basePut,
          dataTables: {
            jobs: { pageSize: 25 },
            users: { density: 'compact' },
            admin_shares: { visibleColumns: ['token'] },
          },
        });

        expect(Object.keys(result.dataTables!).sort()).toEqual([
          'admin_shares',
          'jobs',
          'users',
        ]);
      });

      it.each(['compact', 'standard', 'comfortable'])(
        'should accept density "%s"',
        (density) => {
          const result = updateUserSettingsSchema.parse({
            ...basePut,
            dataTables: { jobs: { density } },
          });

          expect(result.dataTables!.jobs.density).toBe(density);
        },
      );

      it.each(['asc', 'desc'])(
        'should accept sort direction "%s"',
        (direction) => {
          const result = updateUserSettingsSchema.parse({
            ...basePut,
            dataTables: { jobs: { sort: { field: 'createdAt', direction } } },
          });

          expect(result.dataTables!.jobs.sort!.direction).toBe(direction);
        },
      );

      it('should accept table ids at the maximum length', () => {
        const id = 'a'.repeat(DATA_TABLE_MAX_ID_LENGTH);

        const result = updateUserSettingsSchema.parse({
          ...basePut,
          dataTables: { [id]: {} },
        });

        expect(result.dataTables![id]).toEqual({});
      });

      it('should accept exactly DATA_TABLE_MAX_TABLES table ids', () => {
        const dataTables: Record<string, unknown> = {};
        for (let i = 0; i < DATA_TABLE_MAX_TABLES; i++) {
          dataTables[`t${i}`] = {};
        }

        const result = updateUserSettingsSchema.parse({
          ...basePut,
          dataTables,
        });

        expect(Object.keys(result.dataTables!)).toHaveLength(
          DATA_TABLE_MAX_TABLES,
        );
      });

      it('should accept exactly DATA_TABLE_MAX_VISIBLE_COLUMNS columns', () => {
        const visibleColumns = Array.from(
          { length: DATA_TABLE_MAX_VISIBLE_COLUMNS },
          (_, i) => `c${i}`,
        );

        const result = updateUserSettingsSchema.parse({
          ...basePut,
          dataTables: { jobs: { visibleColumns } },
        });

        expect(result.dataTables!.jobs.visibleColumns).toHaveLength(
          DATA_TABLE_MAX_VISIBLE_COLUMNS,
        );
      });

      it('should accept an empty visibleColumns list when explicitly sent', () => {
        // Explicit [] is legal and means "all columns hidden" — it is only the
        // SCHEMA that must never invent it.
        const result = updateUserSettingsSchema.parse({
          ...basePut,
          dataTables: { jobs: { visibleColumns: [] } },
        });

        expect(result.dataTables!.jobs.visibleColumns).toEqual([]);
      });
    });

    describe('rejected payloads', () => {
      const reject = (dataTables: unknown) =>
        expect(() =>
          updateUserSettingsSchema.parse({ ...basePut, dataTables }),
        ).toThrow();

      it('should reject an invalid density', () => {
        reject({ jobs: { density: 'cozy' } });
      });

      it.each([
        ['uppercase', 'Jobs'],
        ['a space', 'admin jobs'],
        ['punctuation', 'jobs!'],
        ['a leading dash', '-jobs'],
        ['a leading underscore', '_jobs'],
        ['a dot', 'admin.jobs'],
        ['empty', ''],
      ])('should reject a tableId containing %s', (_label, tableId) => {
        reject({ [tableId]: {} });
      });

      it('should reject a tableId over the length cap', () => {
        reject({ ['a'.repeat(DATA_TABLE_MAX_ID_LENGTH + 1)]: {} });
      });

      it('should reject more than DATA_TABLE_MAX_TABLES table ids', () => {
        const dataTables: Record<string, unknown> = {};
        for (let i = 0; i <= DATA_TABLE_MAX_TABLES; i++) {
          dataTables[`t${i}`] = {};
        }

        reject(dataTables);
      });

      it('should reject more than DATA_TABLE_MAX_VISIBLE_COLUMNS columns', () => {
        reject({
          jobs: {
            visibleColumns: Array.from(
              { length: DATA_TABLE_MAX_VISIBLE_COLUMNS + 1 },
              (_, i) => `c${i}`,
            ),
          },
        });
      });

      it('should reject a column id over the length cap', () => {
        reject({
          jobs: { visibleColumns: ['a'.repeat(DATA_TABLE_MAX_ID_LENGTH + 1)] },
        });
      });

      it('should reject an empty column id', () => {
        reject({ jobs: { visibleColumns: [''] } });
      });

      it('should reject a sort field over the length cap', () => {
        reject({
          jobs: {
            sort: {
              field: 'a'.repeat(DATA_TABLE_MAX_ID_LENGTH + 1),
              direction: 'asc',
            },
          },
        });
      });

      it('should reject an invalid sort direction', () => {
        reject({ jobs: { sort: { field: 'createdAt', direction: 'sideways' } } });
      });

      it('should reject a sort without a direction', () => {
        reject({ jobs: { sort: { field: 'createdAt' } } });
      });

      it('should reject pageSize below the minimum', () => {
        reject({ jobs: { pageSize: 0 } });
      });

      it('should reject a negative pageSize', () => {
        reject({ jobs: { pageSize: -1 } });
      });

      it('should reject pageSize above the maximum', () => {
        reject({ jobs: { pageSize: DATA_TABLE_MAX_PAGE_SIZE + 1 } });
      });

      it('should reject a non-integer pageSize', () => {
        reject({ jobs: { pageSize: 25.5 } });
      });

      it('should reject unknown keys inside an entry (strict)', () => {
        reject({ jobs: { columnWidths: { type: 200 } } });
      });

      it('should reject a null entry on PUT (null-delete is PATCH-only)', () => {
        reject({ jobs: null });
      });

      it('should reject a non-object entry', () => {
        reject({ jobs: 'compact' });
      });
    });
  });

  // ===========================================================================
  // navigation (issue #392, epic #388)
  //
  // These assertions run against the WIRE schema, not the storage schema —
  // which is the point. A namespace present only in settings.schema.ts
  // validates and merges perfectly in the service's unit tests while every
  // real request silently no-ops, because nestjs-zod strips keys the body DTO
  // does not declare. See the "three hand-maintained copies" pitfall in
  // CLAUDE.md, and the HTTP round-trip proof in user-settings.controller.spec.ts.
  // ===========================================================================
  describe('navigation field', () => {
    it('should leave the namespace absent when not supplied (absent = defaults)', () => {
      const result = updateUserSettingsSchema.parse(basePut);

      expect(result.navigation).toBeUndefined();
    });

    it('should NOT materialize `pinned` / `railCollapsed` for an empty namespace', () => {
      const result = updateUserSettingsSchema.parse({
        ...basePut,
        navigation: {},
      });

      expect(result.navigation).toEqual({});
    });

    it('should accept a fully populated namespace', () => {
      const result = updateUserSettingsSchema.parse({
        ...basePut,
        navigation: { pinned: ['albums', 'people'], railCollapsed: true },
      });

      expect(result.navigation).toEqual({
        pinned: ['albums', 'people'],
        railCollapsed: true,
      });
    });

    it('should preserve pin ORDER — the list is the user-chosen display order', () => {
      const result = updateUserSettingsSchema.parse({
        ...basePut,
        navigation: { pinned: ['trash', 'albums', 'map'] },
      });

      expect(result.navigation!.pinned).toEqual(['trash', 'albums', 'map']);
    });

    it('should accept every pinnable key from the registry', () => {
      for (const key of NAVIGATION_PINNABLE_KEYS) {
        const result = updateUserSettingsSchema.parse({
          ...basePut,
          navigation: { pinned: [key] },
        });

        expect(result.navigation!.pinned).toEqual([key]);
      }
    });

    it('should accept exactly NAVIGATION_MAX_PINNED pins', () => {
      const pinned = NAVIGATION_PINNABLE_KEYS.slice(0, NAVIGATION_MAX_PINNED);

      const result = updateUserSettingsSchema.parse({
        ...basePut,
        navigation: { pinned: [...pinned] },
      });

      expect(result.navigation!.pinned).toHaveLength(NAVIGATION_MAX_PINNED);
    });

    it('should reject more than NAVIGATION_MAX_PINNED pins', () => {
      const pinned = NAVIGATION_PINNABLE_KEYS.slice(
        0,
        NAVIGATION_MAX_PINNED + 1,
      );

      expect(() =>
        updateUserSettingsSchema.parse({
          ...basePut,
          navigation: { pinned: [...pinned] },
        }),
      ).toThrow();
    });

    it('should REJECT an unknown pin key on the way in (a write naming one is a client bug)', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          ...basePut,
          navigation: { pinned: ['albums', 'holodeck'] },
        }),
      ).toThrow();
    });

    it('should reject a PRIMARY destination as a pin — pinnable keys are sub-destinations only', () => {
      // Pinning "Photos" is meaningless: it is already in the rail (spec §5).
      for (const primary of ['photos', 'explore', 'review', 'collections']) {
        expect(() =>
          updateUserSettingsSchema.parse({
            ...basePut,
            navigation: { pinned: [primary] },
          }),
        ).toThrow();
      }
    });

    it('should reject a non-boolean railCollapsed', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          ...basePut,
          navigation: { railCollapsed: 'yes' },
        }),
      ).toThrow();
    });

    it('should reject unknown keys inside the namespace (strict)', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          ...basePut,
          navigation: { railHidden: true },
        }),
      ).toThrow();
    });

    it('should reject a null field on PUT (null-delete is PATCH-only)', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          ...basePut,
          navigation: { pinned: null },
        }),
      ).toThrow();
    });
  });
});

describe('PatchUserSettingsDto (PATCH)', () => {
  describe('theme field', () => {
    it('should make theme field optional', () => {
      const result = patchUserSettingsSchema.parse({});

      expect(result.theme).toBeUndefined();
    });

    it('should accept "light" theme value when provided', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'light',
      });

      expect(result.theme).toBe('light');
    });

    it('should accept "dark" theme value when provided', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'dark',
      });

      expect(result.theme).toBe('dark');
    });

    it('should accept "system" theme value when provided', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'system',
      });

      expect(result.theme).toBe('system');
    });

    it('should reject invalid theme value when provided', () => {
      expect(() =>
        patchUserSettingsSchema.parse({
          theme: 'invalid',
        }),
      ).toThrow();
    });
  });

  describe('profile field', () => {
    it('should make profile field optional', () => {
      const result = patchUserSettingsSchema.parse({});

      expect(result.profile).toBeUndefined();
    });

    it('should accept empty profile object', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {},
      });

      expect(result.profile).toEqual({});
    });

    it('should accept partial profile - only displayName', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          displayName: 'Updated Name',
        },
      });

      expect(result.profile?.displayName).toBe('Updated Name');
      expect(result.profile?.useProviderImage).toBeUndefined();
    });

    it('should accept partial profile - only useProviderImage', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          useProviderImage: false,
        },
      });

      expect(result.profile?.useProviderImage).toBe(false);
      expect(result.profile?.displayName).toBeUndefined();
    });

    it('should accept partial profile - only customImageUrl', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          customImageUrl: 'https://example.com/new-image.jpg',
        },
      });

      expect(result.profile?.customImageUrl).toBe('https://example.com/new-image.jpg');
    });

    it('should accept partial profile with null customImageUrl', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          customImageUrl: null,
        },
      });

      expect(result.profile?.customImageUrl).toBeNull();
    });

    it('should validate displayName max length when provided', () => {
      const tooLongName = 'a'.repeat(101);
      expect(() =>
        patchUserSettingsSchema.parse({
          profile: {
            displayName: tooLongName,
          },
        }),
      ).toThrow();
    });

    it('should validate customImageUrl format when provided', () => {
      expect(() =>
        patchUserSettingsSchema.parse({
          profile: {
            customImageUrl: 'invalid-url',
          },
        }),
      ).toThrow();
    });

    it('should accept all profile fields together', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          displayName: 'New Name',
          useProviderImage: true,
          customImageUrl: null,
        },
      });

      expect(result.profile).toEqual({
        displayName: 'New Name',
        useProviderImage: true,
        customImageUrl: null,
      });
    });
  });

  describe('partial updates', () => {
    it('should accept empty object (all fields optional)', () => {
      const result = patchUserSettingsSchema.parse({});

      expect(result).toEqual({});
    });

    it('should accept update with only theme field', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'dark',
      });

      expect(result).toEqual({
        theme: 'dark',
      });
    });

    it('should accept update with only profile field', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          displayName: 'Test User',
        },
      });

      expect(result).toEqual({
        profile: {
          displayName: 'Test User',
        },
      });
    });

    it('should accept update with both theme and profile', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          useProviderImage: false,
          customImageUrl: 'https://example.com/avatar.png',
        },
      });

      expect(result).toEqual({
        theme: 'light',
        profile: {
          useProviderImage: false,
          customImageUrl: 'https://example.com/avatar.png',
        },
      });
    });
  });

  describe('dataTables field', () => {
    it('should make dataTables optional', () => {
      const result = patchUserSettingsSchema.parse({});

      expect(result.dataTables).toBeUndefined();
    });

    it('should accept a single table entry', () => {
      const result = patchUserSettingsSchema.parse({
        dataTables: { jobs: { pageSize: 100 } },
      });

      expect(result.dataTables).toEqual({ jobs: { pageSize: 100 } });
    });

    it('should NOT materialize omitted sub-keys', () => {
      const result = patchUserSettingsSchema.parse({
        dataTables: { jobs: { density: 'standard' } },
      });

      expect(result.dataTables!.jobs).toEqual({ density: 'standard' });
    });

    it('should accept null as a delete marker for a table id', () => {
      const result = patchUserSettingsSchema.parse({
        dataTables: { jobs: null },
      });

      expect(result.dataTables).toEqual({ jobs: null });
    });

    it('should accept an empty entry as a reset-to-defaults marker', () => {
      const result = patchUserSettingsSchema.parse({
        dataTables: { jobs: {} },
      });

      expect(result.dataTables).toEqual({ jobs: {} });
    });

    it('should apply the same bounds as PUT - invalid density', () => {
      expect(() =>
        patchUserSettingsSchema.parse({ dataTables: { jobs: { density: 'x' } } }),
      ).toThrow();
    });

    it('should apply the same bounds as PUT - invalid tableId', () => {
      expect(() =>
        patchUserSettingsSchema.parse({ dataTables: { 'Bad Id': {} } }),
      ).toThrow();
    });

    it('should apply the same bounds as PUT - pageSize out of range', () => {
      expect(() =>
        patchUserSettingsSchema.parse({
          dataTables: { jobs: { pageSize: DATA_TABLE_MAX_PAGE_SIZE + 1 } },
        }),
      ).toThrow();
    });

    it('should apply the same bounds as PUT - too many table ids', () => {
      const dataTables: Record<string, unknown> = {};
      for (let i = 0; i <= DATA_TABLE_MAX_TABLES; i++) {
        dataTables[`t${i}`] = {};
      }

      expect(() => patchUserSettingsSchema.parse({ dataTables })).toThrow();
    });

    it('should apply the same bounds as PUT - unknown key inside an entry', () => {
      expect(() =>
        patchUserSettingsSchema.parse({
          dataTables: { jobs: { columnOrder: ['a'] } },
        }),
      ).toThrow();
    });
  });

  describe('navigation field', () => {
    it('should make navigation optional', () => {
      const result = patchUserSettingsSchema.parse({});

      expect(result.navigation).toBeUndefined();
    });

    it('should accept a partial namespace — only railCollapsed', () => {
      const result = patchUserSettingsSchema.parse({
        navigation: { railCollapsed: true },
      });

      expect(result.navigation).toEqual({ railCollapsed: true });
    });

    it('should accept a partial namespace — only pinned', () => {
      const result = patchUserSettingsSchema.parse({
        navigation: { pinned: ['favorites'] },
      });

      expect(result.navigation).toEqual({ pinned: ['favorites'] });
    });

    it('should accept null as a delete marker for a field', () => {
      const result = patchUserSettingsSchema.parse({
        navigation: { pinned: null },
      });

      expect(result.navigation).toEqual({ pinned: null });
    });

    it('should accept `navigation: null` as a clear-the-namespace marker', () => {
      const result = patchUserSettingsSchema.parse({ navigation: null });

      expect(result.navigation).toBeNull();
    });

    it('should accept an empty namespace object', () => {
      const result = patchUserSettingsSchema.parse({ navigation: {} });

      expect(result.navigation).toEqual({});
    });

    it('should apply the same bounds as PUT - unknown pin key', () => {
      expect(() =>
        patchUserSettingsSchema.parse({ navigation: { pinned: ['holodeck'] } }),
      ).toThrow();
    });

    it('should apply the same bounds as PUT - too many pins', () => {
      const pinned = NAVIGATION_PINNABLE_KEYS.slice(
        0,
        NAVIGATION_MAX_PINNED + 1,
      );

      expect(() =>
        patchUserSettingsSchema.parse({ navigation: { pinned: [...pinned] } }),
      ).toThrow();
    });

    it('should apply the same bounds as PUT - unknown key inside the namespace', () => {
      expect(() =>
        patchUserSettingsSchema.parse({ navigation: { railHidden: true } }),
      ).toThrow();
    });

    it('should apply the same bounds as PUT - non-boolean railCollapsed', () => {
      expect(() =>
        patchUserSettingsSchema.parse({ navigation: { railCollapsed: 1 } }),
      ).toThrow();
    });
  });
});

// =============================================================================
// timezone (issue #444)
// =============================================================================
//
// These parse through the WIRE DTO, not the canonical schema in
// settings.schema.ts, and that is the entire point of the block. `z.object`
// strips unknown keys, so a field declared only canonically would validate in
// every service-level test and merge correctly in UserSettingsService while
// every real HTTP request silently dropped it — CLAUDE.md's "three
// hand-maintained copies" gotcha, in its user-settings form. If someone removes
// `timezone` from update-user-settings.dto.ts, the "survives" cases below fail.

describe('UpdateUserSettingsDto (PUT) — timezone', () => {
  it('carries a valid zone through the wire DTO instead of stripping it', () => {
    const result = updateUserSettingsSchema.parse({
      ...basePut,
      timezone: 'America/Costa_Rica',
    });

    expect(result.timezone).toBe('America/Costa_Rica');
  });

  it('carries UTC through — Intl.supportedValuesOf omits it on some runtimes', () => {
    expect(
      updateUserSettingsSchema.parse({ ...basePut, timezone: 'UTC' }).timezone,
    ).toBe('UTC');
  });

  it('leaves the key absent when omitted — absent means "no preference"', () => {
    const result = updateUserSettingsSchema.parse(basePut);

    expect(result.timezone).toBeUndefined();
    expect('timezone' in result).toBe(false);
  });

  it('rejects an unknown zone', () => {
    expect(() =>
      updateUserSettingsSchema.parse({ ...basePut, timezone: 'Mars/Olympus' }),
    ).toThrow();
  });

  it('rejects Etc/Unknown', () => {
    expect(() =>
      updateUserSettingsSchema.parse({ ...basePut, timezone: 'Etc/Unknown' }),
    ).toThrow();
  });

  it('rejects the empty string', () => {
    expect(() =>
      updateUserSettingsSchema.parse({ ...basePut, timezone: '' }),
    ).toThrow();
  });

  it('rejects a non-string', () => {
    expect(() =>
      updateUserSettingsSchema.parse({ ...basePut, timezone: 3600 }),
    ).toThrow();
  });

  it('rejects null on PUT — a full replacement omits instead of nulling', () => {
    expect(() =>
      updateUserSettingsSchema.parse({ ...basePut, timezone: null }),
    ).toThrow();
  });

  it('survives the compiled DTO class schema, not just the exported one', () => {
    const parsed = (UpdateUserSettingsDto as any).schema.parse({
      ...basePut,
      timezone: 'Pacific/Apia',
    });

    expect(parsed.timezone).toBe('Pacific/Apia');
  });
});

describe('PatchUserSettingsDto (PATCH) — timezone', () => {
  it('carries a valid zone through the wire DTO instead of stripping it', () => {
    expect(
      patchUserSettingsSchema.parse({ timezone: 'Europe/London' }).timezone,
    ).toBe('Europe/London');
  });

  it('accepts null to CLEAR the preference back to absent', () => {
    expect(patchUserSettingsSchema.parse({ timezone: null }).timezone).toBeNull();
  });

  it('leaves the key absent when omitted, so an unrelated patch cannot clear it', () => {
    const result = patchUserSettingsSchema.parse({ theme: 'dark' });

    expect(result.timezone).toBeUndefined();
    expect('timezone' in result).toBe(false);
  });

  it('applies the same validation as PUT — unknown zone', () => {
    expect(() =>
      patchUserSettingsSchema.parse({ timezone: 'Mars/Olympus' }),
    ).toThrow();
  });

  it('applies the same validation as PUT — Etc/Unknown', () => {
    expect(() =>
      patchUserSettingsSchema.parse({ timezone: 'Etc/Unknown' }),
    ).toThrow();
  });

  it('applies the same validation as PUT — empty string', () => {
    expect(() => patchUserSettingsSchema.parse({ timezone: '' })).toThrow();
  });

  it('survives the compiled DTO class schema, not just the exported one', () => {
    const parsed = (PatchUserSettingsDto as any).schema.parse({
      timezone: 'Asia/Kolkata',
    });

    expect(parsed.timezone).toBe('Asia/Kolkata');
  });
});
