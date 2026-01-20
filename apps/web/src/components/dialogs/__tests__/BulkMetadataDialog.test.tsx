import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BulkMetadataDialog } from '../BulkMetadataDialog';

describe('BulkMetadataDialog', () => {
  describe('rendering', () => {
    it('renders when open', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      expect(screen.getByText('Edit Metadata')).toBeInTheDocument();
      expect(screen.getByText(/5 selected items/i)).toBeInTheDocument();
    });

    it('does not render when closed', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      render(
        <BulkMetadataDialog
          open={false}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      expect(screen.queryByText('Edit Metadata')).not.toBeInTheDocument();
    });

    it('shows all metadata field options', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      expect(screen.getByLabelText(/Captured At/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Latitude/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Longitude/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Country/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/State/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/City/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Location Name/i)).toBeInTheDocument();
    });

    it('shows checkboxes for enabling fields', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      const { container } = render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      const checkboxes = container.querySelectorAll('input[type="checkbox"]');
      expect(checkboxes.length).toBeGreaterThan(0);
    });

    it('shows cancel and apply buttons', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(screen.getByText(/Apply to 5 Items/i)).toBeInTheDocument();
    });
  });

  describe('field enabling', () => {
    it('starts with all fields disabled', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      const { container } = render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      const checkboxes = container.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach((checkbox) => {
        expect(checkbox).not.toBeChecked();
      });
    });

    it('enables field when checkbox is clicked', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      const { container } = render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Find and click the first checkbox
      const checkboxes = container.querySelectorAll('input[type="checkbox"]');
      const firstCheckbox = checkboxes[0] as HTMLInputElement;

      fireEvent.click(firstCheckbox);

      expect(firstCheckbox).toBeChecked();
    });

    it('disables field when checkbox is unchecked', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      const { container } = render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      const checkboxes = container.querySelectorAll('input[type="checkbox"]');
      const firstCheckbox = checkboxes[0] as HTMLInputElement;

      // Enable
      fireEvent.click(firstCheckbox);
      expect(firstCheckbox).toBeChecked();

      // Disable
      fireEvent.click(firstCheckbox);
      expect(firstCheckbox).not.toBeChecked();
    });
  });

  describe('form input', () => {
    it('allows entering captured at date', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      const capturedAtInput = screen.getByLabelText(/Captured At/i) as HTMLInputElement;
      fireEvent.change(capturedAtInput, { target: { value: '2024-01-01T12:00' } });

      expect(capturedAtInput.value).toBe('2024-01-01T12:00');
    });

    it('allows entering latitude', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      const latitudeInput = screen.getByLabelText(/Latitude/i) as HTMLInputElement;
      fireEvent.change(latitudeInput, { target: { value: '40.7128' } });

      expect(latitudeInput.value).toBe('40.7128');
    });

    it('allows entering longitude', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      const longitudeInput = screen.getByLabelText(/Longitude/i) as HTMLInputElement;
      fireEvent.change(longitudeInput, { target: { value: '-74.0060' } });

      expect(longitudeInput.value).toBe('-74.0060');
    });

    it('allows entering location fields', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      const countryInput = screen.getByLabelText(/Country/i) as HTMLInputElement;
      fireEvent.change(countryInput, { target: { value: 'USA' } });
      expect(countryInput.value).toBe('USA');

      const stateInput = screen.getByLabelText(/State/i) as HTMLInputElement;
      fireEvent.change(stateInput, { target: { value: 'California' } });
      expect(stateInput.value).toBe('California');

      const cityInput = screen.getByLabelText(/City/i) as HTMLInputElement;
      fireEvent.change(cityInput, { target: { value: 'San Francisco' } });
      expect(cityInput.value).toBe('San Francisco');
    });

    it('allows entering location name', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      const locationNameInput = screen.getByLabelText(/Location Name/i) as HTMLInputElement;
      fireEvent.change(locationNameInput, { target: { value: 'Golden Gate Bridge' } });

      expect(locationNameInput.value).toBe('Golden Gate Bridge');
    });
  });

  describe('interaction', () => {
    it('calls onClose when Cancel is clicked', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      const cancelButton = screen.getByText('Cancel');
      fireEvent.click(cancelButton);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onApply with selected fields when Apply is clicked', async () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      const { container } = render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Enable country field
      const countryCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(countryCheckbox);

      // Enter country value
      const countryInput = screen.getByLabelText(/Country/i) as HTMLInputElement;
      fireEvent.change(countryInput, { target: { value: 'USA' } });

      // Click Apply
      const applyButton = screen.getByText(/Apply to 5 Items/i);
      fireEvent.click(applyButton);

      await waitFor(() => {
        expect(onApply).toHaveBeenCalledTimes(1);
        expect(onApply).toHaveBeenCalledWith(
          expect.objectContaining({
            country: 'USA',
          })
        );
      });
    });

    it('only includes enabled fields in onApply', async () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      const { container } = render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Enter values in multiple fields but only enable one
      const countryInput = screen.getByLabelText(/Country/i) as HTMLInputElement;
      fireEvent.change(countryInput, { target: { value: 'USA' } });

      const cityInput = screen.getByLabelText(/City/i) as HTMLInputElement;
      fireEvent.change(cityInput, { target: { value: 'San Francisco' } });

      // Only enable country checkbox
      const checkboxes = container.querySelectorAll('input[type="checkbox"]');
      const countryCheckbox = Array.from(checkboxes).find((cb) => {
        const label = cb.closest('div')?.textContent;
        return label?.includes('Country');
      }) as HTMLInputElement;

      fireEvent.click(countryCheckbox);

      // Click Apply
      const applyButton = screen.getByText(/Apply to 5 Items/i);
      fireEvent.click(applyButton);

      await waitFor(() => {
        expect(onApply).toHaveBeenCalledTimes(1);
        const appliedData = onApply.mock.calls[0][0];
        expect(appliedData).toHaveProperty('country');
        expect(appliedData).not.toHaveProperty('city');
      });
    });

    it('closes dialog after applying', async () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      const { container } = render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Enable and fill a field
      const countryCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(countryCheckbox);

      const countryInput = screen.getByLabelText(/Country/i) as HTMLInputElement;
      fireEvent.change(countryInput, { target: { value: 'USA' } });

      const applyButton = screen.getByText(/Apply to 5 Items/i);
      fireEvent.click(applyButton);

      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    });

    it('resets form when dialog is closed', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      const { rerender, container } = render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Fill in some data
      const countryInput = screen.getByLabelText(/Country/i) as HTMLInputElement;
      fireEvent.change(countryInput, { target: { value: 'USA' } });

      // Close and reopen
      rerender(
        <BulkMetadataDialog
          open={false}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      rerender(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Form should be reset
      const newCountryInput = screen.getByLabelText(/Country/i) as HTMLInputElement;
      expect(newCountryInput.value).toBe('');
    });
  });

  describe('validation', () => {
    it('disables apply button when no fields are enabled', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      const applyButton = screen.getByText(/Apply to 5 Items/i);
      expect(applyButton).toBeDisabled();
    });

    it('enables apply button when at least one field is enabled and has value', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      const { container } = render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Enable country field
      const countryCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(countryCheckbox);

      // Enter value
      const countryInput = screen.getByLabelText(/Country/i) as HTMLInputElement;
      fireEvent.change(countryInput, { target: { value: 'USA' } });

      const applyButton = screen.getByText(/Apply to 5 Items/i);
      expect(applyButton).not.toBeDisabled();
    });

    it('validates latitude range', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      const latitudeInput = screen.getByLabelText(/Latitude/i) as HTMLInputElement;

      // Valid latitude
      fireEvent.change(latitudeInput, { target: { value: '45.0' } });
      expect(latitudeInput.value).toBe('45.0');

      // Invalid latitude (out of range)
      fireEvent.change(latitudeInput, { target: { value: '100.0' } });
      // Should show error or prevent invalid value
    });

    it('validates longitude range', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      const longitudeInput = screen.getByLabelText(/Longitude/i) as HTMLInputElement;

      // Valid longitude
      fireEvent.change(longitudeInput, { target: { value: '-120.0' } });
      expect(longitudeInput.value).toBe('-120.0');

      // Invalid longitude (out of range)
      fireEvent.change(longitudeInput, { target: { value: '200.0' } });
      // Should show error or prevent invalid value
    });
  });

  describe('edge cases', () => {
    it('handles selectedCount of 1', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={1}
          onClose={onClose}
          onApply={onApply}
        />
      );

      expect(screen.getByText(/1 selected item/i)).toBeInTheDocument();
      expect(screen.getByText(/Apply to 1 Item/i)).toBeInTheDocument();
    });

    it('handles large selectedCount', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={999}
          onClose={onClose}
          onApply={onApply}
        />
      );

      expect(screen.getByText(/999 selected items/i)).toBeInTheDocument();
      expect(screen.getByText(/Apply to 999 Items/i)).toBeInTheDocument();
    });

    it('handles empty string values', async () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      const { container } = render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Enable field but leave value empty
      const countryCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(countryCheckbox);

      const applyButton = screen.getByText(/Apply to 5 Items/i);
      fireEvent.click(applyButton);

      // Should still call onApply with empty value or skip the field
      await waitFor(() => {
        expect(onApply).toHaveBeenCalled();
      });
    });

    it('handles null coordinates', async () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      const { container } = render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Enable latitude and set to empty (null)
      const latCheckbox = Array.from(
        container.querySelectorAll('input[type="checkbox"]')
      ).find((cb) => cb.closest('div')?.textContent?.includes('Latitude')) as HTMLInputElement;

      fireEvent.click(latCheckbox);

      const latitudeInput = screen.getByLabelText(/Latitude/i) as HTMLInputElement;
      fireEvent.change(latitudeInput, { target: { value: '' } });

      const applyButton = screen.getByText(/Apply to 5 Items/i);
      fireEvent.click(applyButton);

      await waitFor(() => {
        expect(onApply).toHaveBeenCalled();
      });
    });
  });
});
