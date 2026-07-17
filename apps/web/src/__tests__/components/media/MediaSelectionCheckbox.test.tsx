/**
 * Unit tests for MediaSelectionCheckbox.
 *
 * Covers:
 *  - Issue #94: the shared selection control is an IconButton (role="button")
 *    rendering CheckBoxOutlineBlank when unchecked and CheckBox when checked
 *    — not a MUI Checkbox (role="checkbox").
 *  - Clicking calls onToggle exactly once and stops propagation so a click
 *    on the selection control never also fires a parent's onClick (e.g. the
 *    gallery tile / review card opening a lightbox/detail page).
 *  - comfortableTouchTarget prop renders without error (smoke-level check).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MediaSelectionCheckbox } from '../../../components/media/MediaSelectionCheckbox';

describe('MediaSelectionCheckbox', () => {
  describe('checked state rendering', () => {
    it('renders CheckBoxOutlineBlank icon and no "checkbox" role when unchecked', () => {
      render(
        <MediaSelectionCheckbox checked={false} onToggle={vi.fn()} ariaLabel="Select item" />,
      );

      const button = screen.getByRole('button', { name: 'Select item' });
      expect(button).toBeInTheDocument();
      expect(screen.getByTestId('CheckBoxOutlineBlankIcon')).toBeInTheDocument();
      expect(screen.queryByTestId('CheckBoxIcon')).toBeNull();
      expect(screen.queryByRole('checkbox')).toBeNull();
    });

    it('renders CheckBox icon when checked', () => {
      render(<MediaSelectionCheckbox checked={true} onToggle={vi.fn()} ariaLabel="Select item" />);

      const button = screen.getByRole('button', { name: 'Select item' });
      expect(button).toBeInTheDocument();
      expect(screen.getByTestId('CheckBoxIcon')).toBeInTheDocument();
      expect(screen.queryByTestId('CheckBoxOutlineBlankIcon')).toBeNull();
    });

    it('exposes the given ariaLabel as the accessible name', () => {
      render(
        <MediaSelectionCheckbox checked={false} onToggle={vi.fn()} ariaLabel="Deselect item" />,
      );

      expect(screen.getByRole('button', { name: 'Deselect item' })).toBeInTheDocument();
    });
  });

  describe('click behavior', () => {
    it('calls onToggle exactly once when clicked', async () => {
      const user = userEvent.setup();
      const onToggle = vi.fn();

      render(<MediaSelectionCheckbox checked={false} onToggle={onToggle} ariaLabel="Select item" />);

      await user.click(screen.getByRole('button', { name: 'Select item' }));

      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('stops propagation so a parent onClick handler is not also triggered', async () => {
      const user = userEvent.setup();
      const onToggle = vi.fn();
      const parentOnClick = vi.fn();

      render(
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div onClick={parentOnClick}>
          <MediaSelectionCheckbox checked={false} onToggle={onToggle} ariaLabel="Select item" />
        </div>,
      );

      await user.click(screen.getByRole('button', { name: 'Select item' }));

      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(parentOnClick).not.toHaveBeenCalled();
    });
  });

  describe('comfortableTouchTarget', () => {
    it('renders without error when comfortableTouchTarget is true', () => {
      render(
        <MediaSelectionCheckbox
          checked={false}
          onToggle={vi.fn()}
          ariaLabel="Select item"
          comfortableTouchTarget
        />,
      );

      expect(screen.getByRole('button', { name: 'Select item' })).toBeInTheDocument();
    });

    it('renders without error when comfortableTouchTarget is false (default)', () => {
      render(<MediaSelectionCheckbox checked={false} onToggle={vi.fn()} ariaLabel="Select item" />);

      expect(screen.getByRole('button', { name: 'Select item' })).toBeInTheDocument();
    });
  });
});
