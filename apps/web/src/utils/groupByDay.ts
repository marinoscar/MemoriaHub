import type { MediaItem } from '../types/media';

export function groupByDay(
  items: MediaItem[],
): Array<{ key: string; label: string; items: MediaItem[] }> {
  const groups = new Map<string, { label: string; items: MediaItem[] }>();

  for (const item of items) {
    let key: string;
    let label: string;

    const dateStr = item.capturedAt ?? item.importedAt;
    if (!dateStr) {
      key = 'undated';
      label = 'Undated';
    } else {
      const d = new Date(dateStr);
      // YYYY-MM-DD in local time
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      key = `${year}-${month}-${day}`;
      label = d.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    }

    if (!groups.has(key)) {
      groups.set(key, { label, items: [] });
    }
    groups.get(key)!.items.push(item);
  }

  // Newest day first; undated last
  return Array.from(groups.entries())
    .sort(([a], [b]) => {
      if (a === 'undated') return 1;
      if (b === 'undated') return -1;
      return b.localeCompare(a);
    })
    .map(([key, value]) => ({ key, ...value }));
}
