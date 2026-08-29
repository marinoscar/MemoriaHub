import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import ArchiveIcon from '@mui/icons-material/Archive';
import { render } from '../../utils/test-utils';
import { AdminPageHeader } from '../../../components/admin/AdminPageHeader';

/**
 * Issue #451. The three properties asserted here are the ones the ~19 admin
 * pages depend on and that a future refactor could plausibly break:
 *
 *   1. the title is still the page's single `<h1>` (every page spec queries it
 *      by role and level, so a change of `component` breaks them all at once);
 *   2. the back link is HIDDEN by a breakpoint rather than UNMOUNTED — a
 *      conditional render would drop it from the wide-viewport a11y tree and
 *      would flash it in on mount under `useMediaQuery`;
 *   3. the icon is aligned to the title's first line rather than centred
 *      against a wrapped title block, which was the reported defect.
 */
/**
 * The `display` declaration Emotion injected for the element, keyed by the
 * `min-width` of the media query carrying it.
 *
 * jsdom never evaluates media queries when computing style, so a breakpoint
 * rule is only observable by reading the injected stylesheet directly. Emotion
 * emits one `@media (min-width: …)` block per `sx` breakpoint key — including
 * `xs`, which becomes `min-width:0px` — so this returns e.g.
 * `{ '0px': 'display: none;', '600px': 'display: inline-block;' }`.
 */
function emotionRulesFor(el: HTMLElement): Record<string, string> {
  const classes = [...el.classList];
  const out: Record<string, string> = {};

  for (const sheet of [...document.styleSheets]) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet; nothing of ours lives there
    }

    for (const rule of [...rules]) {
      if (!(rule instanceof CSSMediaRule)) continue;

      const minWidth = /min-width:\s*([\w.]+)/.exec(rule.conditionText)?.[1];
      if (!minWidth) continue;

      for (const inner of [...rule.cssRules]) {
        if (classes.some((c) => inner.cssText.includes(`.${c}`))) {
          out[minWidth] = (out[minWidth] ?? '') + inner.cssText;
        }
      }
    }
  }

  return out;
}

describe('AdminPageHeader', () => {
  it('renders the title as the page heading, with the description', () => {
    render(
      <AdminPageHeader
        title={<>Archiving &amp; Deletion</>}
        description={<>Archive hides items from browse surfaces.</>}
      />,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Archiving & Deletion');
    expect(screen.getByText('Archive hides items from browse surfaces.')).toBeInTheDocument();
  });

  it('omits the description paragraph entirely when none is given', () => {
    render(<AdminPageHeader title="Jobs" />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Jobs');
    expect(screen.queryByText(/Archive hides/)).not.toBeInTheDocument();
  });

  it('points the back link at the admin hub by default', () => {
    render(<AdminPageHeader title="Face Settings" />);

    const link = screen.getByRole('link', { name: /Back to Settings/ });
    expect(link).toHaveAttribute('href', '/admin/settings');
  });

  it('honours an explicit backTo destination', () => {
    render(<AdminPageHeader title="Job Insights" backTo="/admin/settings/jobs" />);

    expect(screen.getByRole('link', { name: /Back to Settings/ })).toHaveAttribute(
      'href',
      '/admin/settings/jobs',
    );
  });

  it('hides the back link below sm with a breakpoint rather than unmounting it', () => {
    render(<AdminPageHeader title="Database Backup" />);

    // The link must stay MOUNTED — a conditional render on `useMediaQuery`
    // would drop it from the wide-viewport a11y tree and flash it in on mount.
    const link = screen.getByRole('link', { name: /Back to Settings/ });
    expect(link).toBeInTheDocument();

    // jsdom does not evaluate `@media` when computing style, so asserting
    // `getComputedStyle(link).display === 'none'` proves nothing — it returns
    // the same value whichever breakpoint is meant to win. Read Emotion's
    // injected rules instead. Emotion compiles an `sx` breakpoint object into
    // one `@media (min-width:…)` block PER KEY, `xs` included, so the hidden
    // state is `min-width:0px` rather than an unconditional declaration.
    const rules = emotionRulesFor(link);

    expect(rules['0px']).toMatch(/display:\s*none/);
    expect(rules['600px']).toMatch(/display:\s*inline-block/);
  });

  it('aligns the icon to the first line of the title, not the block centre', () => {
    render(
      <AdminPageHeader
        icon={<ArchiveIcon data-testid="header-icon" color="primary" />}
        title={<>Archiving &amp; Deletion</>}
      />,
    );

    const iconWrapper = screen.getByTestId('header-icon').parentElement as HTMLElement;
    expect(getComputedStyle(iconWrapper).flexShrink).toBe('0');

    const row = iconWrapper.parentElement as HTMLElement;
    expect(getComputedStyle(row).alignItems).toBe('flex-start');
  });

  it('wrap-guards the optional actions slot', () => {
    render(
      <AdminPageHeader
        title="Doctor"
        actions={<button data-testid="run-btn">Run diagnostics</button>}
      />,
    );

    const slot = screen.getByTestId('run-btn').parentElement as HTMLElement;
    expect(getComputedStyle(slot).flexWrap).toBe('wrap');
  });
});
