/**
 * Unit tests for LocationSuggestionController.
 *
 * Pure delegation/metadata test — auth guard enforcement is tested in
 * integration tests, not here (mirrors enrichment-admin.controller.spec.ts).
 * Per-circle RBAC (assertCircleAccess) is a service-layer concern tested in
 * location-suggestion.service.spec.ts.
 */

import { LocationSuggestionController } from './location-suggestion.controller';
import { LocationSuggestionService } from './location-suggestion.service';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { LocationSuggestionQueryDto } from './dto/location-suggestion-query.dto';
import { AcceptLocationSuggestionDto } from './dto/accept-location-suggestion.dto';
import { BulkAcceptLocationSuggestionsDto } from './dto/bulk-accept-location-suggestions.dto';

const USER: RequestUser = {
  id: 'user-1',
  email: 'user@example.com',
  roles: ['Contributor'],
  permissions: ['media:read', 'media:write'],
  isActive: true,
};

describe('LocationSuggestionController', () => {
  let controller: LocationSuggestionController;
  let mockService: {
    listSuggestions: jest.Mock;
    bulkAcceptSuggestions: jest.Mock;
    acceptSuggestion: jest.Mock;
    rejectSuggestion: jest.Mock;
    revertSuggestion: jest.Mock;
    inferLocation: jest.Mock;
  };

  beforeEach(() => {
    mockService = {
      listSuggestions: jest.fn(),
      bulkAcceptSuggestions: jest.fn(),
      acceptSuggestion: jest.fn(),
      rejectSuggestion: jest.fn(),
      revertSuggestion: jest.fn(),
      inferLocation: jest.fn(),
    };
    controller = new LocationSuggestionController(mockService as unknown as LocationSuggestionService);
  });

  it('listSuggestions delegates to service.listSuggestions(query, user.id, user.permissions)', async () => {
    const query = { circleId: 'circle-1', status: 'pending', page: 1, pageSize: 20 } as LocationSuggestionQueryDto;
    const expected = { items: [], meta: { total: 0, page: 1, pageSize: 20 } };
    mockService.listSuggestions.mockResolvedValue(expected);

    const result = await controller.listSuggestions(query, USER);

    expect(mockService.listSuggestions).toHaveBeenCalledWith(query, USER.id, USER.permissions);
    expect(result).toBe(expected);
  });

  it('bulkAcceptSuggestions delegates to service.bulkAcceptSuggestions(dto, user.id, user.permissions)', async () => {
    const dto = { circleId: 'circle-1', minConfidence: 0.7 } as BulkAcceptLocationSuggestionsDto;
    const expected = { data: { accepted: 3 } };
    mockService.bulkAcceptSuggestions.mockResolvedValue(expected);

    const result = await controller.bulkAcceptSuggestions(dto, USER);

    expect(mockService.bulkAcceptSuggestions).toHaveBeenCalledWith(dto, USER.id, USER.permissions);
    expect(result).toBe(expected);
  });

  it('acceptSuggestion delegates to service.acceptSuggestion(id, dto, user.id, user.permissions)', async () => {
    const dto = { lat: 1, lng: 2 } as AcceptLocationSuggestionDto;
    const expected = { data: { id: 'suggestion-1', status: 'accepted' } };
    mockService.acceptSuggestion.mockResolvedValue(expected);

    const result = await controller.acceptSuggestion('suggestion-1', dto, USER);

    expect(mockService.acceptSuggestion).toHaveBeenCalledWith('suggestion-1', dto, USER.id, USER.permissions);
    expect(result).toBe(expected);
  });

  it('rejectSuggestion delegates to service.rejectSuggestion(id, user.id, user.permissions)', async () => {
    const expected = { data: { id: 'suggestion-1', status: 'rejected' } };
    mockService.rejectSuggestion.mockResolvedValue(expected);

    const result = await controller.rejectSuggestion('suggestion-1', USER);

    expect(mockService.rejectSuggestion).toHaveBeenCalledWith('suggestion-1', USER.id, USER.permissions);
    expect(result).toBe(expected);
  });

  it('revertSuggestion delegates to service.revertSuggestion(id, user.id, user.permissions)', async () => {
    const expected = { data: { id: 'suggestion-1', status: 'reverted' } };
    mockService.revertSuggestion.mockResolvedValue(expected);

    const result = await controller.revertSuggestion('suggestion-1', USER);

    expect(mockService.revertSuggestion).toHaveBeenCalledWith('suggestion-1', USER.id, USER.permissions);
    expect(result).toBe(expected);
  });

  it('inferLocation delegates to service.inferLocation(id, user.id, user.permissions)', async () => {
    const expected = { data: { jobId: 'job-1', status: 'pending' } };
    mockService.inferLocation.mockResolvedValue(expected);

    const result = await controller.inferLocation('media-1', USER);

    expect(mockService.inferLocation).toHaveBeenCalledWith('media-1', USER.id, USER.permissions);
    expect(result).toBe(expected);
  });
});
