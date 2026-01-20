import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMediaSelection } from '../useMediaSelection';

describe('useMediaSelection', () => {
  describe('initial state', () => {
    it('starts with empty selection', () => {
      const { result } = renderHook(() => useMediaSelection());

      expect(result.current.selectedIds.size).toBe(0);
      expect(result.current.selectedCount).toBe(0);
    });

    it('starts with all helper functions available', () => {
      const { result } = renderHook(() => useMediaSelection());

      expect(typeof result.current.isSelected).toBe('function');
      expect(typeof result.current.toggleSelection).toBe('function');
      expect(typeof result.current.selectAll).toBe('function');
      expect(typeof result.current.clearSelection).toBe('function');
    });
  });

  describe('toggleSelection', () => {
    it('adds an item when not selected', () => {
      const { result } = renderHook(() => useMediaSelection());

      act(() => {
        result.current.toggleSelection('item-1');
      });

      expect(result.current.selectedIds.has('item-1')).toBe(true);
      expect(result.current.selectedCount).toBe(1);
    });

    it('removes an item when already selected', () => {
      const { result } = renderHook(() => useMediaSelection());

      // Add item
      act(() => {
        result.current.toggleSelection('item-1');
      });

      expect(result.current.selectedIds.has('item-1')).toBe(true);

      // Remove item
      act(() => {
        result.current.toggleSelection('item-1');
      });

      expect(result.current.selectedIds.has('item-1')).toBe(false);
      expect(result.current.selectedCount).toBe(0);
    });

    it('handles multiple items independently', () => {
      const { result } = renderHook(() => useMediaSelection());

      act(() => {
        result.current.toggleSelection('item-1');
        result.current.toggleSelection('item-2');
        result.current.toggleSelection('item-3');
      });

      expect(result.current.selectedCount).toBe(3);
      expect(result.current.selectedIds.has('item-1')).toBe(true);
      expect(result.current.selectedIds.has('item-2')).toBe(true);
      expect(result.current.selectedIds.has('item-3')).toBe(true);

      // Toggle item-2 off
      act(() => {
        result.current.toggleSelection('item-2');
      });

      expect(result.current.selectedCount).toBe(2);
      expect(result.current.selectedIds.has('item-1')).toBe(true);
      expect(result.current.selectedIds.has('item-2')).toBe(false);
      expect(result.current.selectedIds.has('item-3')).toBe(true);
    });
  });

  describe('isSelected', () => {
    it('returns false for unselected items', () => {
      const { result } = renderHook(() => useMediaSelection());

      expect(result.current.isSelected('item-1')).toBe(false);
    });

    it('returns true for selected items', () => {
      const { result } = renderHook(() => useMediaSelection());

      act(() => {
        result.current.toggleSelection('item-1');
      });

      expect(result.current.isSelected('item-1')).toBe(true);
    });

    it('updates when selection changes', () => {
      const { result } = renderHook(() => useMediaSelection());

      act(() => {
        result.current.toggleSelection('item-1');
      });

      expect(result.current.isSelected('item-1')).toBe(true);

      act(() => {
        result.current.toggleSelection('item-1');
      });

      expect(result.current.isSelected('item-1')).toBe(false);
    });
  });

  describe('selectAll', () => {
    it('selects all provided items', () => {
      const { result } = renderHook(() => useMediaSelection());

      const itemIds = ['item-1', 'item-2', 'item-3', 'item-4'];

      act(() => {
        result.current.selectAll(itemIds);
      });

      expect(result.current.selectedCount).toBe(4);
      itemIds.forEach((id) => {
        expect(result.current.selectedIds.has(id)).toBe(true);
      });
    });

    it('replaces previous selection', () => {
      const { result } = renderHook(() => useMediaSelection());

      // Select initial items
      act(() => {
        result.current.toggleSelection('item-1');
        result.current.toggleSelection('item-2');
      });

      expect(result.current.selectedCount).toBe(2);

      // Select all new items
      act(() => {
        result.current.selectAll(['item-3', 'item-4', 'item-5']);
      });

      expect(result.current.selectedCount).toBe(3);
      expect(result.current.selectedIds.has('item-1')).toBe(false);
      expect(result.current.selectedIds.has('item-2')).toBe(false);
      expect(result.current.selectedIds.has('item-3')).toBe(true);
      expect(result.current.selectedIds.has('item-4')).toBe(true);
      expect(result.current.selectedIds.has('item-5')).toBe(true);
    });

    it('handles empty array', () => {
      const { result } = renderHook(() => useMediaSelection());

      act(() => {
        result.current.toggleSelection('item-1');
      });

      expect(result.current.selectedCount).toBe(1);

      act(() => {
        result.current.selectAll([]);
      });

      expect(result.current.selectedCount).toBe(0);
    });
  });

  describe('clearSelection', () => {
    it('removes all selected items', () => {
      const { result } = renderHook(() => useMediaSelection());

      act(() => {
        result.current.toggleSelection('item-1');
        result.current.toggleSelection('item-2');
        result.current.toggleSelection('item-3');
      });

      expect(result.current.selectedCount).toBe(3);

      act(() => {
        result.current.clearSelection();
      });

      expect(result.current.selectedCount).toBe(0);
      expect(result.current.selectedIds.size).toBe(0);
    });

    it('is idempotent when selection is already empty', () => {
      const { result } = renderHook(() => useMediaSelection());

      expect(result.current.selectedCount).toBe(0);

      act(() => {
        result.current.clearSelection();
      });

      expect(result.current.selectedCount).toBe(0);
    });
  });

  describe('selectedCount', () => {
    it('updates when items are added', () => {
      const { result } = renderHook(() => useMediaSelection());

      expect(result.current.selectedCount).toBe(0);

      act(() => {
        result.current.toggleSelection('item-1');
      });

      expect(result.current.selectedCount).toBe(1);

      act(() => {
        result.current.toggleSelection('item-2');
      });

      expect(result.current.selectedCount).toBe(2);
    });

    it('updates when items are removed', () => {
      const { result } = renderHook(() => useMediaSelection());

      act(() => {
        result.current.selectAll(['item-1', 'item-2', 'item-3']);
      });

      expect(result.current.selectedCount).toBe(3);

      act(() => {
        result.current.toggleSelection('item-2');
      });

      expect(result.current.selectedCount).toBe(2);
    });

    it('matches selectedIds.size', () => {
      const { result } = renderHook(() => useMediaSelection());

      act(() => {
        result.current.selectAll(['item-1', 'item-2', 'item-3', 'item-4', 'item-5']);
      });

      expect(result.current.selectedCount).toBe(result.current.selectedIds.size);
    });
  });

  describe('performance', () => {
    it('handles large selections efficiently', () => {
      const { result } = renderHook(() => useMediaSelection());

      const largeArray = Array.from({ length: 1000 }, (_, i) => `item-${i}`);

      act(() => {
        result.current.selectAll(largeArray);
      });

      expect(result.current.selectedCount).toBe(1000);

      // Check that lookup is still fast (O(1) with Set)
      expect(result.current.isSelected('item-500')).toBe(true);
      expect(result.current.isSelected('item-999')).toBe(true);
      expect(result.current.isSelected('item-1000')).toBe(false);
    });
  });
});
