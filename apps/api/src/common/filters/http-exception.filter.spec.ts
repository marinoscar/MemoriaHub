import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;
  let mockResponse: any;
  let mockRequest: any;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new HttpExceptionFilter();

    // Mock Fastify response object
    mockResponse = {
      code: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };

    mockRequest = {
      url: '/api/test',
      method: 'GET',
    };

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as ArgumentsHost;
  });

  describe('HttpException handling', () => {
    it('should format HttpException with proper status code and message', () => {
      const exception = new HttpException('Test error', HttpStatus.BAD_REQUEST);

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(400);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          code: 'BAD_REQUEST',
          message: 'Test error',
        }),
      );
    });

    it('should handle 400 Bad Request with validation errors', () => {
      const validationErrors = [
        { field: 'email', message: 'Invalid email format' },
        { field: 'password', message: 'Password too short' },
      ];
      const exception = new HttpException(
        {
          message: 'Validation failed',
          details: validationErrors,
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(400);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          code: 'BAD_REQUEST',
          message: 'Validation failed',
          details: validationErrors,
        }),
      );
    });

    it('should handle 401 Unauthorized', () => {
      const exception = new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(401);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        }),
      );
    });

    it('should handle 403 Forbidden', () => {
      const exception = new HttpException('Forbidden', HttpStatus.FORBIDDEN);

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(403);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: 'Forbidden',
        }),
      );
    });

    it('should handle 404 Not Found', () => {
      const exception = new HttpException('Resource not found', HttpStatus.NOT_FOUND);

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(404);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 404,
          code: 'NOT_FOUND',
          message: 'Resource not found',
        }),
      );
    });

    it('should handle 409 Conflict', () => {
      const exception = new HttpException('Resource already exists', HttpStatus.CONFLICT);

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(409);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 409,
          code: 'CONFLICT',
          message: 'Resource already exists',
        }),
      );
    });

    it('should handle 412 Precondition Failed', () => {
      const exception = new HttpException(
        'Version mismatch',
        HttpStatus.PRECONDITION_FAILED,
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(412);
      // Note: 412 maps to 'ERROR' since it's not in the codeMap
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 412,
          code: 'ERROR',
          message: 'Version mismatch',
        }),
      );
    });

    it('should handle 500 Internal Server Error', () => {
      const exception = new HttpException(
        'Internal error',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(500);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'Internal error',
        }),
      );
    });
  });

  describe('Error response structure', () => {
    it('should include timestamp in error response', () => {
      const exception = new HttpException('Test', HttpStatus.BAD_REQUEST);
      const beforeTime = new Date().toISOString();

      filter.catch(exception, mockHost);

      const response = mockResponse.send.mock.calls[0][0];
      expect(response.timestamp).toBeDefined();
      expect(new Date(response.timestamp)).toBeInstanceOf(Date);
      expect(response.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should include request path in error response', () => {
      const exception = new HttpException('Test', HttpStatus.BAD_REQUEST);
      mockRequest.url = '/api/users/123';

      filter.catch(exception, mockHost);

      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/api/users/123',
        }),
      );
    });

    it('should handle exceptions with error array (validation errors)', () => {
      const errors = [
        { property: 'email', constraints: { isEmail: 'email must be an email' } },
        { property: 'age', constraints: { min: 'age must be >= 18' } },
      ];
      const exception = new HttpException(
        {
          message: 'Validation failed',
          details: errors,
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          message: 'Validation failed',
          details: errors,
        }),
      );
    });

    it('should not include details field when no details provided', () => {
      const exception = new HttpException('Simple error', HttpStatus.BAD_REQUEST);

      filter.catch(exception, mockHost);

      const response = mockResponse.send.mock.calls[0][0];
      expect(response.details).toBeUndefined();
    });
  });

  describe('Generic Error handling', () => {
    it('should handle generic Error objects (non-HttpException)', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const error = new Error('Something went wrong');

      filter.catch(error, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(500);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong',
          details: expect.stringContaining('Error: Something went wrong'),
        }),
      );

      process.env.NODE_ENV = originalEnv;
    });

    it('should not expose stack traces in production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const error = new Error('Something went wrong');

      filter.catch(error, mockHost);

      const response = mockResponse.send.mock.calls[0][0];
      expect(response.details).toBeUndefined();

      process.env.NODE_ENV = originalEnv;
    });

    it('should handle unknown exception types', () => {
      const unknownError = { some: 'unknown error' };

      filter.catch(unknownError, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(500);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        }),
      );
    });
  });

  describe('Error code mapping', () => {
    it('should map 422 to UNPROCESSABLE_ENTITY', () => {
      const exception = new HttpException('Invalid data', HttpStatus.UNPROCESSABLE_ENTITY);

      filter.catch(exception, mockHost);

      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'UNPROCESSABLE_ENTITY',
        }),
      );
    });

    it('should map 429 to TOO_MANY_REQUESTS', () => {
      const exception = new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);

      filter.catch(exception, mockHost);

      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'TOO_MANY_REQUESTS',
        }),
      );
    });

    it('should default to ERROR for unmapped status codes', () => {
      const exception = new HttpException('Service unavailable', HttpStatus.SERVICE_UNAVAILABLE);

      filter.catch(exception, mockHost);

      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 503,
          code: 'ERROR',
        }),
      );
    });
  });

  describe('String vs Object response handling', () => {
    it('should handle string exception response', () => {
      const exception = new HttpException('Simple string message', HttpStatus.BAD_REQUEST);

      filter.catch(exception, mockHost);

      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Simple string message',
        }),
      );
    });

    it('should handle object exception response with custom code', () => {
      const exception = new HttpException(
        {
          code: 'CUSTOM_CODE',
          message: 'Custom error',
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      // Note: The filter overrides custom code with standard code mapping
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'BAD_REQUEST',
          message: 'Custom error',
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // RFC 8628 / OAuth 2.0 error field propagation
  // New behaviour: error + error_description are forwarded verbatim when present
  // ---------------------------------------------------------------------------

  describe('RFC 8628 / OAuth error field propagation', () => {
    it('should include error and error_description when present in HttpException payload', () => {
      const exception = new HttpException(
        {
          error: 'authorization_pending',
          error_description: 'User has not yet authorized this device',
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'authorization_pending',
          error_description: 'User has not yet authorized this device',
        }),
      );
    });

    it('should propagate slow_down RFC error code', () => {
      const exception = new HttpException(
        {
          error: 'slow_down',
          error_description: 'Polling too frequently. Please slow down.',
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      const sent = mockResponse.send.mock.calls[0][0];
      expect(sent.error).toBe('slow_down');
      expect(sent.error_description).toBe('Polling too frequently. Please slow down.');
    });

    it('should propagate expired_token RFC error code', () => {
      const exception = new HttpException(
        {
          error: 'expired_token',
          error_description: 'The device code has expired',
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      const sent = mockResponse.send.mock.calls[0][0];
      expect(sent.error).toBe('expired_token');
      expect(sent.error_description).toBe('The device code has expired');
    });

    it('should propagate access_denied RFC error code', () => {
      const exception = new HttpException(
        {
          error: 'access_denied',
          error_description: 'User denied the authorization request',
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      const sent = mockResponse.send.mock.calls[0][0];
      expect(sent.error).toBe('access_denied');
    });

    it('should propagate invalid_grant RFC error code on 401', () => {
      const exception = new HttpException(
        {
          error: 'invalid_grant',
          error_description: 'Invalid device code',
        },
        HttpStatus.UNAUTHORIZED,
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.code).toHaveBeenCalledWith(401);
      const sent = mockResponse.send.mock.calls[0][0];
      expect(sent.error).toBe('invalid_grant');
      expect(sent.error_description).toBe('Invalid device code');
    });

    it('should include both error fields alongside standard statusCode, code, and message', () => {
      const exception = new HttpException(
        {
          message: 'User has not yet authorized this device',
          error: 'authorization_pending',
          error_description: 'User has not yet authorized this device',
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      const sent = mockResponse.send.mock.calls[0][0];
      expect(sent).toMatchObject({
        statusCode: 400,
        code: 'BAD_REQUEST',
        message: 'User has not yet authorized this device',
        error: 'authorization_pending',
        error_description: 'User has not yet authorized this device',
        timestamp: expect.any(String),
        path: '/api/test',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Regression guard: ordinary exceptions must NOT gain stray error fields
  // ---------------------------------------------------------------------------

  describe('regression guard — ordinary exceptions keep unchanged shape', () => {
    it('should NOT include error or error_description for a plain string HttpException', () => {
      const exception = new HttpException('Simple error', HttpStatus.BAD_REQUEST);

      filter.catch(exception, mockHost);

      const sent = mockResponse.send.mock.calls[0][0];
      expect(sent).not.toHaveProperty('error');
      expect(sent).not.toHaveProperty('error_description');
    });

    it('should NOT include error or error_description for an object HttpException without those fields', () => {
      const exception = new HttpException(
        { message: 'Validation failed', details: [{ field: 'email' }] },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      const sent = mockResponse.send.mock.calls[0][0];
      expect(sent).not.toHaveProperty('error');
      expect(sent).not.toHaveProperty('error_description');
      // Original fields still present
      expect(sent.statusCode).toBe(400);
      expect(sent.message).toBe('Validation failed');
    });

    it('should NOT include error or error_description for a generic Error', () => {
      const error = new Error('Unexpected crash');

      filter.catch(error, mockHost);

      const sent = mockResponse.send.mock.calls[0][0];
      expect(sent).not.toHaveProperty('error');
      expect(sent).not.toHaveProperty('error_description');
      expect(sent.statusCode).toBe(500);
      expect(sent.message).toBe('Unexpected crash');
    });

    it('should NOT include error or error_description for an unknown object exception', () => {
      filter.catch({ some: 'unknown' }, mockHost);

      const sent = mockResponse.send.mock.calls[0][0];
      expect(sent).not.toHaveProperty('error');
      expect(sent).not.toHaveProperty('error_description');
      expect(sent.statusCode).toBe(500);
    });

    it('should NOT add error field when the HttpException payload has a numeric error property', () => {
      // Ensures we don't forward non-string values that happen to be named "error"
      const exception = new HttpException(
        { message: 'Type mismatch', error: 42 as any },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      const sent = mockResponse.send.mock.calls[0][0];
      // A numeric 'error' must NOT be forwarded (the filter guards typeof === 'string')
      expect(sent).not.toHaveProperty('error');
    });

    it('should NOT add error_description field when it is not a string', () => {
      const exception = new HttpException(
        { message: 'Error', error: 'some_code', error_description: { nested: true } as any },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      const sent = mockResponse.send.mock.calls[0][0];
      // error is a string so it IS forwarded
      expect(sent.error).toBe('some_code');
      // error_description is not a string so it must NOT be forwarded
      expect(sent).not.toHaveProperty('error_description');
    });

    it('should preserve 401 Unauthorized shape without stray fields', () => {
      const exception = new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);

      filter.catch(exception, mockHost);

      const sent = mockResponse.send.mock.calls[0][0];
      expect(sent).toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      });
      expect(sent).not.toHaveProperty('error');
      expect(sent).not.toHaveProperty('error_description');
    });

    it('should preserve 403 Forbidden shape without stray fields', () => {
      const exception = new HttpException('Forbidden', HttpStatus.FORBIDDEN);

      filter.catch(exception, mockHost);

      const sent = mockResponse.send.mock.calls[0][0];
      expect(sent).toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'Forbidden',
      });
      expect(sent).not.toHaveProperty('error');
      expect(sent).not.toHaveProperty('error_description');
    });
  });
});
