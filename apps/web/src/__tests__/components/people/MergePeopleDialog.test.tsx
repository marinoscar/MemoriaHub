import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { MergePeopleDialog } from '../../../components/people/MergePeopleDialog';
import type { PersonListItem } from '../../../services/face';

function makePerson(id: string, name: string | null = 'Alice', faceCount = 2): PersonListItem {
  return {
    id,
    name,
    isUnlabeled: name === null,
    faceCount,
    coverFace: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const sourcePerson = makePerson('source-1', 'Alice', 3);
const otherPerson = makePerson('other-1', 'Bob', 5);
const anotherPerson = makePerson('another-1', 'Carol', 1);
const allPeople = [sourcePerson, otherPerson, anotherPerson];

describe('MergePeopleDialog', () => {
  let onClose: ReturnType<typeof vi.fn>;
  let onMerge: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onClose = vi.fn();
    onMerge = vi.fn().mockResolvedValue(undefined);
  });

  function renderDialog(open = true, people = allPeople) {
    return render(
      <MergePeopleDialog
        open={open}
        onClose={onClose}
        sourcePerson={sourcePerson}
        people={people}
        onMerge={onMerge}
      />
    );
  }

  it('renders the "Merge Person" title', () => {
    renderDialog();
    expect(screen.getByText('Merge Person')).toBeInTheDocument();
  });

  it('mentions the source person face count in the description', () => {
    renderDialog();
    // The description contains "3 faces" (the source face count)
    const desc = screen.getByText(/3 faces/i);
    expect(desc).toBeInTheDocument();
  });

  it('excludes the source person from the Autocomplete options', async () => {
    const user = userEvent.setup();
    renderDialog();
    const input = screen.getByRole('combobox');
    await user.click(input);
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^alice$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /bob/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /carol/i })).toBeInTheDocument();
  });

  it('Merge button is disabled when no target is selected', () => {
    renderDialog();
    const mergeBtn = screen.getByRole('button', { name: /^merge$/i });
    expect(mergeBtn).toBeDisabled();
  });

  it('shows warning alert when a target is selected', async () => {
    const user = userEvent.setup();
    renderDialog();
    const input = screen.getByRole('combobox');
    await user.click(input);
    const bobOption = await screen.findByRole('option', { name: /bob/i });
    await user.click(bobOption);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  it('Merge button is enabled after target is selected', async () => {
    const user = userEvent.setup();
    renderDialog();
    const input = screen.getByRole('combobox');
    await user.click(input);
    const bobOption = await screen.findByRole('option', { name: /bob/i });
    await user.click(bobOption);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^merge$/i })).not.toBeDisabled();
    });
  });

  it('calls onMerge with the target person id when Merge is clicked', async () => {
    const user = userEvent.setup();
    renderDialog();
    const input = screen.getByRole('combobox');
    await user.click(input);
    const bobOption = await screen.findByRole('option', { name: /bob/i });
    await user.click(bobOption);
    await user.click(screen.getByRole('button', { name: /^merge$/i }));
    await waitFor(() => {
      expect(onMerge).toHaveBeenCalledWith('other-1');
    });
  });

  it('calls onClose after successful merge', async () => {
    const user = userEvent.setup();
    renderDialog();
    const input = screen.getByRole('combobox');
    await user.click(input);
    const bobOption = await screen.findByRole('option', { name: /bob/i });
    await user.click(bobOption);
    await user.click(screen.getByRole('button', { name: /^merge$/i }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows error alert when onMerge rejects', async () => {
    onMerge.mockRejectedValue(new Error('Merge failed'));
    const user = userEvent.setup();
    renderDialog();
    const input = screen.getByRole('combobox');
    await user.click(input);
    const bobOption = await screen.findByRole('option', { name: /bob/i });
    await user.click(bobOption);
    await user.click(screen.getByRole('button', { name: /^merge$/i }));
    await waitFor(() => {
      expect(screen.getByText(/merge failed/i)).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not render when open=false', () => {
    renderDialog(false);
    expect(screen.queryByText('Merge Person')).not.toBeInTheDocument();
  });
});
