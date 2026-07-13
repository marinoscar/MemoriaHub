/**
 * Unit tests for ConfidenceMeter.
 *
 * Covers:
 *  - null/undefined confidence renders "—" and an inert (color="inherit") bar
 *  - Numeric confidence is rendered as a rounded percentage
 *  - Color thresholds: >=70% success, >=40% (and <70%) warning, <40% error
 *  - Custom label vs. the "Confidence" default
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfidenceMeter } from '../../../components/review/ConfidenceMeter';

describe('ConfidenceMeter', () => {
  describe('null / undefined confidence', () => {
    it('renders an em dash when confidence is null', () => {
      render(<ConfidenceMeter confidence={null} />);

      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('renders an em dash when confidence is undefined', () => {
      render(<ConfidenceMeter confidence={undefined} />);

      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('renders the bar at value=0 with color="inherit" when confidence is null', () => {
      const { container } = render(<ConfidenceMeter confidence={null} />);

      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow', '0');
      expect(container.querySelector('.MuiLinearProgress-colorInherit')).not.toBeNull();
    });

    it('sets the tooltip title to "No confidence score" when null', () => {
      render(<ConfidenceMeter confidence={null} />);

      // MUI Tooltip forwards `title` onto the wrapped element as aria-label
      // when no visible tooltip is open; the underlying bar carries it.
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-label', 'No confidence score');
    });
  });

  describe('numeric confidence rendering', () => {
    it('renders a rounded percentage for 0.734', () => {
      render(<ConfidenceMeter confidence={0.734} />);

      expect(screen.getByText('73%')).toBeInTheDocument();
    });

    it('renders 100% for confidence=1', () => {
      render(<ConfidenceMeter confidence={1} />);

      expect(screen.getByText('100%')).toBeInTheDocument();
    });

    it('renders 0% for confidence=0 (not treated as null/undefined)', () => {
      render(<ConfidenceMeter confidence={0} />);

      expect(screen.getByText('0%')).toBeInTheDocument();
      expect(screen.queryByText('—')).toBeNull();
    });

    it('sets aria-valuenow to the rounded percentage', () => {
      render(<ConfidenceMeter confidence={0.82} />);

      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '82');
    });
  });

  describe('color thresholds', () => {
    it('uses success color at exactly 70%', () => {
      const { container } = render(<ConfidenceMeter confidence={0.7} />);

      expect(container.querySelector('.MuiLinearProgress-colorSuccess')).not.toBeNull();
    });

    it('uses success color above 70%', () => {
      const { container } = render(<ConfidenceMeter confidence={0.95} />);

      expect(container.querySelector('.MuiLinearProgress-colorSuccess')).not.toBeNull();
    });

    it('uses warning color at exactly 40%', () => {
      const { container } = render(<ConfidenceMeter confidence={0.4} />);

      expect(container.querySelector('.MuiLinearProgress-colorWarning')).not.toBeNull();
    });

    it('uses warning color just below 70% (e.g. 69%)', () => {
      const { container } = render(<ConfidenceMeter confidence={0.69} />);

      expect(container.querySelector('.MuiLinearProgress-colorWarning')).not.toBeNull();
    });

    it('uses error color below 40%', () => {
      const { container } = render(<ConfidenceMeter confidence={0.39} />);

      expect(container.querySelector('.MuiLinearProgress-colorError')).not.toBeNull();
    });

    it('uses error color at 0%', () => {
      const { container } = render(<ConfidenceMeter confidence={0} />);

      expect(container.querySelector('.MuiLinearProgress-colorError')).not.toBeNull();
    });
  });

  describe('label', () => {
    it('defaults to the "Confidence" label when none is given', () => {
      render(<ConfidenceMeter confidence={0.5} />);

      expect(screen.getByText('Confidence')).toBeInTheDocument();
    });

    it('renders a custom label when provided', () => {
      render(<ConfidenceMeter confidence={0.5} label="Cohesion" />);

      expect(screen.getByText('Cohesion')).toBeInTheDocument();
      expect(screen.queryByText('Confidence')).toBeNull();
    });
  });
});
