/**
 * BeforeAfterSlider — unit tests.
 *
 * Covers:
 *  - Both images and both labels render.
 *  - Keyboard interaction on the handle (role="slider"): arrows (+-2),
 *    Home/End (to the ends), PageUp/PageDown (+-10), and aria-valuenow
 *    updates to match.
 *  - The slider <-> side-by-side toggle switches modes.
 *  - The full-screen zoom dialog opens via the explicit "View larger" button
 *    (not pointer-drag/tap — jsdom's pointer-capture stub makes drag
 *    assertions unreliable, and the button exists precisely so keyboard
 *    users aren't required to tap the image).
 */
import { describe, it, expect } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { BeforeAfterSlider } from '../../../components/media/BeforeAfterSlider';

const defaultProps = {
  beforeUrl: 'https://cdn.example.com/before.jpg',
  afterUrl: 'https://cdn.example.com/after.jpg',
};

describe('BeforeAfterSlider', () => {
  // -------------------------------------------------------------------------
  describe('rendering', () => {
    it('renders both images and both labels', () => {
      render(<BeforeAfterSlider {...defaultProps} />);

      expect(screen.getByAltText('Before')).toHaveAttribute(
        'src',
        'https://cdn.example.com/before.jpg',
      );
      expect(screen.getByAltText('After')).toHaveAttribute(
        'src',
        'https://cdn.example.com/after.jpg',
      );
      // Labels appear as corner chips, twice each (once per view — the
      // slider stage and the frame's own labels) — use getAllByText.
      expect(screen.getAllByText('Before').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('After').length).toBeGreaterThanOrEqual(1);
    });

    it('renders custom labels when provided', () => {
      render(
        <BeforeAfterSlider
          {...defaultProps}
          beforeLabel="Original"
          afterLabel="Enhanced"
        />,
      );

      expect(screen.getByAltText('Original')).toBeInTheDocument();
      expect(screen.getByAltText('Enhanced')).toBeInTheDocument();
      expect(screen.queryByAltText('Before')).not.toBeInTheDocument();
    });

    it('renders a loading spinner instead of an image when a URL is null', () => {
      render(<BeforeAfterSlider beforeUrl={null} afterUrl={null} />);

      expect(screen.queryByAltText('Before')).not.toBeInTheDocument();
      expect(screen.queryByAltText('After')).not.toBeInTheDocument();
      expect(screen.getAllByRole('progressbar').length).toBeGreaterThan(0);
    });

    it('exposes the divider handle with role="slider"', () => {
      render(<BeforeAfterSlider {...defaultProps} />);

      const slider = screen.getByRole('slider');
      expect(slider).toHaveAttribute('aria-valuemin', '0');
      expect(slider).toHaveAttribute('aria-valuemax', '100');
      expect(slider).toHaveAttribute('aria-valuenow', '50');
    });
  });

  // -------------------------------------------------------------------------
  describe('keyboard interaction', () => {
    it('ArrowRight moves the divider +2 and ArrowLeft moves it -2', async () => {
      const user = userEvent.setup();
      render(<BeforeAfterSlider {...defaultProps} />);

      const slider = screen.getByRole('slider');
      slider.focus();

      await user.keyboard('{ArrowRight}');
      expect(slider).toHaveAttribute('aria-valuenow', '52');

      await user.keyboard('{ArrowLeft}');
      await user.keyboard('{ArrowLeft}');
      expect(slider).toHaveAttribute('aria-valuenow', '48');
    });

    it('PageUp moves +10 and PageDown moves -10', async () => {
      const user = userEvent.setup();
      render(<BeforeAfterSlider {...defaultProps} />);

      const slider = screen.getByRole('slider');
      slider.focus();

      await user.keyboard('{PageUp}');
      expect(slider).toHaveAttribute('aria-valuenow', '60');

      await user.keyboard('{PageDown}');
      await user.keyboard('{PageDown}');
      expect(slider).toHaveAttribute('aria-valuenow', '40');
    });

    it('Home moves to 0 and End moves to 100', async () => {
      const user = userEvent.setup();
      render(<BeforeAfterSlider {...defaultProps} />);

      const slider = screen.getByRole('slider');
      slider.focus();

      await user.keyboard('{Home}');
      expect(slider).toHaveAttribute('aria-valuenow', '0');

      await user.keyboard('{End}');
      expect(slider).toHaveAttribute('aria-valuenow', '100');
    });

    it('clamps at the ends — ArrowLeft past 0 stays at 0', async () => {
      const user = userEvent.setup();
      render(<BeforeAfterSlider {...defaultProps} />);

      const slider = screen.getByRole('slider');
      slider.focus();

      await user.keyboard('{Home}');
      await user.keyboard('{ArrowLeft}');
      expect(slider).toHaveAttribute('aria-valuenow', '0');
    });

    it('clamps at the ends — ArrowRight past 100 stays at 100', async () => {
      const user = userEvent.setup();
      render(<BeforeAfterSlider {...defaultProps} />);

      const slider = screen.getByRole('slider');
      slider.focus();

      await user.keyboard('{End}');
      await user.keyboard('{ArrowRight}');
      expect(slider).toHaveAttribute('aria-valuenow', '100');
    });

    it('updates aria-valuetext to match the current position', async () => {
      const user = userEvent.setup();
      render(<BeforeAfterSlider {...defaultProps} />);

      const slider = screen.getByRole('slider');
      slider.focus();

      await user.keyboard('{Home}');
      expect(slider).toHaveAttribute('aria-valuetext', '0% before');
    });
  });

  // -------------------------------------------------------------------------
  describe('slider <-> side-by-side toggle', () => {
    it('defaults to slider mode (a single frame with the drag handle)', () => {
      render(<BeforeAfterSlider {...defaultProps} />);

      expect(screen.getByTestId('before-after-frame')).toBeInTheDocument();
      expect(screen.getByRole('slider')).toBeInTheDocument();
    });

    it('switches to side-by-side mode: no drag handle, two separate panes', async () => {
      const user = userEvent.setup();
      render(<BeforeAfterSlider {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /side by side/i }));

      expect(screen.queryByRole('slider')).not.toBeInTheDocument();
      expect(screen.queryByTestId('before-after-frame')).not.toBeInTheDocument();
      expect(screen.getByAltText('Before')).toBeInTheDocument();
      expect(screen.getByAltText('After')).toBeInTheDocument();
    });

    it('switches back to slider mode from side-by-side', async () => {
      const user = userEvent.setup();
      render(<BeforeAfterSlider {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /side by side/i }));
      await user.click(screen.getByRole('button', { name: /^slider comparison$/i }));

      expect(screen.getByRole('slider')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('full-screen zoom dialog', () => {
    it('opens via the explicit "View larger" button', async () => {
      const user = userEvent.setup();
      render(<BeforeAfterSlider {...defaultProps} />);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /view larger/i }));

      const dialog = await screen.findByRole('dialog');
      expect(dialog).toBeInTheDocument();
      // The full-screen copy renders its own set of before/after images.
      expect(within(dialog).getAllByAltText('Before').length).toBeGreaterThan(0);
      expect(within(dialog).getAllByAltText('After').length).toBeGreaterThan(0);
    });

    it('closes when the close button is clicked', async () => {
      const user = userEvent.setup();
      render(<BeforeAfterSlider {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /view larger/i }));
      const dialog = await screen.findByRole('dialog');

      await user.click(within(dialog).getByRole('button', { name: /close comparison/i }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('does not render a "View larger" button or dialog when zoomable is false', () => {
      render(<BeforeAfterSlider {...defaultProps} zoomable={false} />);

      expect(screen.queryByRole('button', { name: /view larger/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('height prop', () => {
    it('accepts a plain number without throwing', () => {
      expect(() => render(<BeforeAfterSlider {...defaultProps} height={300} />)).not.toThrow();
    });
  });
});
