import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { render } from '../utils/test-utils.js';

vi.mock('../../src/search/headless/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSearchFields: vi.fn(),
}));

import { getSearchFields } from '../../src/search/headless/index.js';
import { SearchFieldsSettings } from '../../src/search/ui/components/SearchFieldsSettings.js';

const fields = [
  { key: 'type', label: 'Media type', type: 'enum' },
  { key: 'tag', label: 'Tag', type: 'text' },
];

describe('SearchFieldsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSearchFields).mockResolvedValue(fields as never);
  });

  it('treats an empty saved list as every field selected', async () => {
    render(<SearchFieldsSettings settings={{}} updateSettings={vi.fn()} />);
    const box = await screen.findByRole('checkbox', { name: /media type/i });
    expect(box).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /tag/i })).toBeChecked();
  });

  it('saves the chosen keys under search.visibleFields', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    render(<SearchFieldsSettings settings={{ search: { visibleFields: ['type', 'tag'] } }} updateSettings={updateSettings} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /tag/i }));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ search: { visibleFields: ['type'] } }));
  });
});
