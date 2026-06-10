import {
  updateUserSettingsSchema,
  patchUserSettingsSchema,
} from './update-user-settings.dto';

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
});
