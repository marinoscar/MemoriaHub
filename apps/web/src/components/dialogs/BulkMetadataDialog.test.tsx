import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BulkMetadataDialog } from './BulkMetadataDialog';

// Field indices in the dialog (order: Captured At, Latitude, Longitude, Country, State, City, Location Name)
const FIELD_INDICES = {
  capturedAt: 0,
  latitude: 1,
  longitude: 2,
  country: 3,
  state: 4,
  city: 5,
  locationName: 6,
};

// Helper to get all checkboxes from the dialog (works with MUI portal)
const getCheckboxes = (): HTMLInputElement[] => {
  return screen.getAllByRole('checkbox') as HTMLInputElement[];
};

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

      // Field labels appear twice: once as checkbox label, once as input label
      expect(screen.getAllByLabelText(/Captured At/i).length).toBeGreaterThan(0);
      expect(screen.getAllByLabelText(/Latitude/i).length).toBeGreaterThan(0);
      expect(screen.getAllByLabelText(/Longitude/i).length).toBeGreaterThan(0);
      expect(screen.getAllByLabelText(/Country/i).length).toBeGreaterThan(0);
      expect(screen.getAllByLabelText(/State/i).length).toBeGreaterThan(0);
      expect(screen.getAllByLabelText(/City/i).length).toBeGreaterThan(0);
      expect(screen.getAllByLabelText(/Location Name/i).length).toBeGreaterThan(0);
    });

    it('shows checkboxes for enabling fields', () => {
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

      const checkboxes = getCheckboxes();
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

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      const checkboxes = getCheckboxes();
      checkboxes.forEach((checkbox) => {
        expect(checkbox).not.toBeChecked();
      });
    });

    it('enables field when checkbox is clicked', () => {
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

      // Find and click the first checkbox
      const checkboxes = getCheckboxes();
      const firstCheckbox = checkboxes[0];

      fireEvent.click(firstCheckbox);

      expect(firstCheckbox).toBeChecked();
    });

    it('disables field when checkbox is unchecked', () => {
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

      const checkboxes = getCheckboxes();
      const firstCheckbox = checkboxes[0];

      // Enable
      fireEvent.click(firstCheckbox);
      expect(firstCheckbox).toBeChecked();

      // Disable
      fireEvent.click(firstCheckbox);
      expect(firstCheckbox).not.toBeChecked();
    });
  });

  describe('form input', () => {
    // Helper to get TextField input by its label (skipping checkbox labels)
    const getTextFieldByLabel = (label: RegExp): HTMLInputElement => {
      const inputs = screen.getAllByLabelText(label) as HTMLInputElement[];
      // The TextField input has type="text", "datetime-local", or "number", not checkbox
      return inputs.find((input) => input.type !== 'checkbox')!;
    };

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

      const capturedAtInput = getTextFieldByLabel(/Captured At/i);
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

      const latitudeInput = getTextFieldByLabel(/Latitude/i);
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

      const longitudeInput = getTextFieldByLabel(/Longitude/i);
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

      const countryInput = getTextFieldByLabel(/Country/i);
      fireEvent.change(countryInput, { target: { value: 'USA' } });
      expect(countryInput.value).toBe('USA');

      const stateInput = getTextFieldByLabel(/^State$/i);
      fireEvent.change(stateInput, { target: { value: 'California' } });
      expect(stateInput.value).toBe('California');

      const cityInput = getTextFieldByLabel(/City/i);
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

      const locationNameInput = getTextFieldByLabel(/Location Name/i);
      fireEvent.change(locationNameInput, { target: { value: 'Golden Gate Bridge' } });

      expect(locationNameInput.value).toBe('Golden Gate Bridge');
    });
  });

  describe('interaction', () => {
    // Helper to get TextField input by its label (skipping checkbox labels)
    const getTextFieldByLabel = (label: RegExp): HTMLInputElement => {
      const inputs = screen.getAllByLabelText(label) as HTMLInputElement[];
      return inputs.find((input) => input.type !== 'checkbox')!;
    };

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

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Enable country field
      const checkboxes = getCheckboxes();
      const countryCheckbox = checkboxes[FIELD_INDICES.country];
      fireEvent.click(countryCheckbox);

      // Enter country value
      const countryInput = getTextFieldByLabel(/Country/i);
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

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Enter values in multiple fields but only enable one
      const countryInput = getTextFieldByLabel(/Country/i);
      fireEvent.change(countryInput, { target: { value: 'USA' } });

      const cityInput = getTextFieldByLabel(/City/i);
      fireEvent.change(cityInput, { target: { value: 'San Francisco' } });

      // Only enable country checkbox
      const checkboxes = getCheckboxes();
      const countryCheckbox = checkboxes[FIELD_INDICES.country];

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

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Enable and fill a field
      const checkboxes = getCheckboxes();
      const countryCheckbox = checkboxes[FIELD_INDICES.country];
      fireEvent.click(countryCheckbox);

      const countryInput = getTextFieldByLabel(/Country/i);
      fireEvent.change(countryInput, { target: { value: 'USA' } });

      const applyButton = screen.getByText(/Apply to 5 Items/i);
      fireEvent.click(applyButton);

      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    });

    it('resets form when dialog is closed via cancel button', () => {
      const onClose = vi.fn();
      const onApply = vi.fn();

      const { rerender } = render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Fill in some data
      const countryInput = getTextFieldByLabel(/Country/i);
      fireEvent.change(countryInput, { target: { value: 'USA' } });

      // Click cancel to trigger onClose (which also resets form)
      const cancelButton = screen.getByText('Cancel');
      fireEvent.click(cancelButton);

      // Reopen the dialog
      rerender(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Form should be reset (component resets on handleClose)
      const newCountryInput = getTextFieldByLabel(/Country/i);
      expect(newCountryInput.value).toBe('');
    });
  });

  describe('validation', () => {
    // Helper to get TextField input by its label (skipping checkbox labels)
    const getTextFieldByLabel = (label: RegExp): HTMLInputElement => {
      const inputs = screen.getAllByLabelText(label) as HTMLInputElement[];
      return inputs.find((input) => input.type !== 'checkbox')!;
    };

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

    it('enables apply button when at least one field is enabled', () => {
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

      // Enable country field
      const checkboxes = getCheckboxes();
      const countryCheckbox = checkboxes[FIELD_INDICES.country];
      fireEvent.click(countryCheckbox);

      const applyButton = screen.getByText(/Apply to 5 Items/i);
      expect(applyButton).not.toBeDisabled();
    });

    it('allows entering latitude values', () => {
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

      const latitudeInput = getTextFieldByLabel(/Latitude/i);

      // Valid latitude
      fireEvent.change(latitudeInput, { target: { value: '45.0' } });
      expect(latitudeInput.value).toBe('45.0');
    });

    it('allows entering longitude values', () => {
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

      const longitudeInput = getTextFieldByLabel(/Longitude/i);

      // Valid longitude
      fireEvent.change(longitudeInput, { target: { value: '-120.0' } });
      expect(longitudeInput.value).toBe('-120.0');
    });
  });

  describe('edge cases', () => {
    // Helper to get TextField input by its label (skipping checkbox labels)
    const getTextFieldByLabel = (label: RegExp): HTMLInputElement => {
      const inputs = screen.getAllByLabelText(label) as HTMLInputElement[];
      return inputs.find((input) => input.type !== 'checkbox')!;
    };

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

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Enable field but leave value empty
      const checkboxes = getCheckboxes();
      const countryCheckbox = checkboxes[FIELD_INDICES.country];
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

      render(
        <BulkMetadataDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onApply={onApply}
        />
      );

      // Enable latitude and set to empty (null)
      const checkboxes = getCheckboxes();
      const latCheckbox = checkboxes[FIELD_INDICES.latitude];

      fireEvent.click(latCheckbox);

      const latitudeInput = getTextFieldByLabel(/Latitude/i);
      fireEvent.change(latitudeInput, { target: { value: '' } });

      const applyButton = screen.getByText(/Apply to 5 Items/i);
      fireEvent.click(applyButton);

      await waitFor(() => {
        expect(onApply).toHaveBeenCalled();
      });
    });
  });
});
