/**
 * Settings Validator Tests
 *
 * Tests for settings input validation middleware.
 * Covers system settings category, system settings update, and user preferences update validation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  validateSystemSettingsCategory,
  validateSystemSettingsUpdate,
  validateUserPreferencesUpdate,
} from '../../../src/api/validators/settings.validator.js';

describe('Settings Validators', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();

    mockReq = {
      params: {},
      query: {},
      body: {},
    };
    mockRes = {};
    mockNext = vi.fn();
  });

  describe('validateSystemSettingsCategory', () => {
    it('passes for valid smtp category', () => {
      mockReq.params = { category: 'smtp' };

      validateSystemSettingsCategory(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('passes for valid push category', () => {
      mockReq.params = { category: 'push' };

      validateSystemSettingsCategory(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('passes for valid storage category', () => {
      mockReq.params = { category: 'storage' };

      validateSystemSettingsCategory(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('passes for valid features category', () => {
      mockReq.params = { category: 'features' };

      validateSystemSettingsCategory(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('passes for valid general category', () => {
      mockReq.params = { category: 'general' };

      validateSystemSettingsCategory(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('calls next with error for invalid category', () => {
      mockReq.params = { category: 'invalid' };

      validateSystemSettingsCategory(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
        })
      );
    });

    it('calls next with error for empty category', () => {
      mockReq.params = { category: '' };

      validateSystemSettingsCategory(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
        })
      );
    });

    it('calls next with error for missing category', () => {
      mockReq.params = {};

      validateSystemSettingsCategory(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
        })
      );
    });
  });

  describe('validateSystemSettingsUpdate', () => {
    describe('basic validation', () => {
      it('passes for valid settings object', () => {
        mockReq.params = { category: 'features' };
        mockReq.body = {
          settings: {
            aiSearch: true,
            faceRecognition: false,
          },
        };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith();
      });

      it('calls next with error when settings is missing', () => {
        mockReq.params = { category: 'features' };
        mockReq.body = {};

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 400,
          })
        );
      });

      it('calls next with error when settings is not an object', () => {
        mockReq.params = { category: 'features' };
        mockReq.body = { settings: 'not-an-object' };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 400,
          })
        );
      });

      it('calls next with error when settings is null', () => {
        mockReq.params = { category: 'features' };
        mockReq.body = { settings: null };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 400,
          })
        );
      });

      it('calls next with error when settings is an array', () => {
        mockReq.params = { category: 'features' };
        mockReq.body = { settings: ['item1', 'item2'] };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 400,
          })
        );
      });
    });

    describe('SMTP settings validation', () => {
      it('passes for valid SMTP settings', () => {
        mockReq.params = { category: 'smtp' };
        mockReq.body = {
          settings: {
            enabled: true,
            host: 'smtp.example.com',
            port: 587,
            secure: true,
          },
        };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith();
      });

      it('calls next with error for invalid port', () => {
        mockReq.params = { category: 'smtp' };
        mockReq.body = {
          settings: {
            port: 99999, // Port out of range
          },
        };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 400,
          })
        );
      });

      it('calls next with error for invalid email address', () => {
        mockReq.params = { category: 'smtp' };
        mockReq.body = {
          settings: {
            fromAddress: 'not-an-email',
          },
        };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 400,
          })
        );
      });

      it('passes for empty fromAddress (allowed)', () => {
        mockReq.params = { category: 'smtp' };
        mockReq.body = {
          settings: {
            fromAddress: '',
          },
        };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith();
      });
    });

    describe('features settings validation', () => {
      it('passes for valid feature flags', () => {
        mockReq.params = { category: 'features' };
        mockReq.body = {
          settings: {
            aiSearch: true,
            faceRecognition: false,
            webdavSync: true,
            publicSharing: true,
            guestUploads: false,
          },
        };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith();
      });

      it('calls next with error for non-boolean feature flag', () => {
        mockReq.params = { category: 'features' };
        mockReq.body = {
          settings: {
            aiSearch: 'yes', // Should be boolean
          },
        };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 400,
          })
        );
      });
    });

    describe('general settings validation', () => {
      it('passes for valid general settings', () => {
        mockReq.params = { category: 'general' };
        mockReq.body = {
          settings: {
            siteName: 'My Photo Hub',
            allowRegistration: true,
            maxUploadSizeMB: 200,
          },
        };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith();
      });

      it('calls next with error for empty site name', () => {
        mockReq.params = { category: 'general' };
        mockReq.body = {
          settings: {
            siteName: '',
          },
        };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 400,
          })
        );
      });

      it('calls next with error for negative maxUploadSizeMB', () => {
        mockReq.params = { category: 'general' };
        mockReq.body = {
          settings: {
            maxUploadSizeMB: -10,
          },
        };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 400,
          })
        );
      });
    });

    describe('push settings validation', () => {
      it('passes for valid push settings', () => {
        mockReq.params = { category: 'push' };
        mockReq.body = {
          settings: {
            enabled: true,
            provider: 'firebase',
          },
        };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith();
      });

      it('calls next with error for invalid provider', () => {
        mockReq.params = { category: 'push' };
        mockReq.body = {
          settings: {
            provider: 'invalid-provider',
          },
        };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 400,
          })
        );
      });
    });

    describe('storage settings validation', () => {
      it('passes for valid storage settings', () => {
        mockReq.params = { category: 'storage' };
        mockReq.body = {
          settings: {
            defaultBackend: 's3',
            s3Bucket: 'my-bucket',
          },
        };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith();
      });

      it('calls next with error for invalid backend', () => {
        mockReq.params = { category: 'storage' };
        mockReq.body = {
          settings: {
            defaultBackend: 'azure', // Not supported
          },
        };

        validateSystemSettingsUpdate(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 400,
          })
        );
      });
    });
  });

  describe('validateUserPreferencesUpdate', () => {
    it('passes for valid notification preferences', () => {
      mockReq.body = {
        notifications: {
          email: {
            enabled: true,
            digest: 'daily',
          },
        },
      };

      validateUserPreferencesUpdate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('passes for valid UI preferences', () => {
      mockReq.body = {
        ui: {
          theme: 'dark',
          gridSize: 'large',
        },
      };

      validateUserPreferencesUpdate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('passes for valid privacy preferences', () => {
      mockReq.body = {
        privacy: {
          showOnlineStatus: false,
          allowTagging: true,
          defaultAlbumVisibility: 'private',
        },
      };

      validateUserPreferencesUpdate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('passes for empty body (all optional)', () => {
      mockReq.body = {};

      validateUserPreferencesUpdate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('passes for combined preferences', () => {
      mockReq.body = {
        notifications: {
          email: { enabled: true },
          push: { enabled: false },
        },
        ui: { theme: 'light' },
        privacy: { showOnlineStatus: true },
      };

      validateUserPreferencesUpdate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('calls next with error for invalid theme', () => {
      mockReq.body = {
        ui: {
          theme: 'purple', // Not a valid theme
        },
      };

      validateUserPreferencesUpdate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
        })
      );
    });

    it('calls next with error for invalid digest value', () => {
      mockReq.body = {
        notifications: {
          email: {
            digest: 'monthly', // Not a valid option
          },
        },
      };

      validateUserPreferencesUpdate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
        })
      );
    });

    it('calls next with error for invalid gridSize', () => {
      mockReq.body = {
        ui: {
          gridSize: 'huge', // Not valid
        },
      };

      validateUserPreferencesUpdate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
        })
      );
    });

    it('calls next with error for invalid defaultAlbumVisibility', () => {
      mockReq.body = {
        privacy: {
          defaultAlbumVisibility: 'hidden', // Not valid
        },
      };

      validateUserPreferencesUpdate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
        })
      );
    });

    it('calls next with error for non-boolean enabled flag', () => {
      mockReq.body = {
        notifications: {
          email: {
            enabled: 'yes', // Should be boolean
          },
        },
      };

      validateUserPreferencesUpdate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
        })
      );
    });
  });
});
