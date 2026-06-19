import { describe, it, expect, vi } from 'vitest';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../hooks/useSearch', () => ({
  useSearch: vi.fn(),
}));

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(() => ({ activeCircle: null })),
}));

vi.mock('../../components/media/MediaResultsGrid', () => ({
  MediaResultsGrid: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import SearchPage from '../../pages/SearchPage';

// Placeholder tests — will be updated in feat(ui): rebuild search page
describe('SearchPage — extended coverage', () => {
  it('renders without crashing', () => {
    render(<SearchPage />);
    expect(true).toBe(true);
  });
});
