/**
 * Serializes a rendered tree for a committed snapshot: one tag per line, with the parts of MUI's output that
 * change from run to run (Emotion's hashed class names, generated ids) removed, so a snapshot changes only
 * when what a page renders changes.
 */
export function normalizedHtml(container: Element): string {
  return container.innerHTML
    .replace(/\s+class="([^"]*)"/g, (_m, value: string) => {
      const kept = value
        .split(/\s+/)
        .filter((token) => token && !/^css-[a-z0-9]+(-[A-Za-z0-9-]+)?$/.test(token))
        .join(' ');
      return kept ? ` class="${kept}"` : '';
    })
    .replace(/(id|for|htmlFor|aria-labelledby|aria-controls|aria-describedby)="(:r[0-9a-z]+:|_r_[0-9a-z]+_|mui-[0-9]+)[^"]*"/g, '$1="<generated>"')
    .replace(/></g, '>\n<');
}
