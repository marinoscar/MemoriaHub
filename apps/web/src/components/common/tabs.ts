/**
 * Shared `<Tabs>` props — issue #451.
 *
 * MUI's default `variant="standard"` neither scrolls nor wraps: a tab bar
 * wider than its container is silently clipped, with no scroll buttons and no
 * indication that anything was cut off. At 360px that is exactly what happened
 * to "UI Settings | Storage | Maintenance" on `/admin/settings/system`.
 *
 * `scrollable` is a strict improvement rather than a phone-only alternative:
 * at widths where every tab already fits, MUI renders it identically to
 * `standard` (same left alignment, no scroll buttons, `scrollButtons="auto"`),
 * so spreading this into a tab bar cannot change the desktop rendering. That
 * is why it is applied unconditionally instead of behind a breakpoint — a
 * conditional would give two different DOMs to reason about for no gain.
 *
 * `allowScrollButtonsMobile` is required on top of `scrollButtons="auto"`:
 * MUI hides the scroll buttons below `sm` by default, which would leave the
 * phone case — the only one that needs them — without an affordance.
 *
 * Spread it, do not wrap it: `<Tabs {...scrollableTabsProps} value={…}>`. A
 * wrapper component would hide `Tabs`' own props behind an extra layer for no
 * benefit, and this way the fix is greppable from any tab bar in the app.
 */
export const scrollableTabsProps = {
  variant: 'scrollable',
  scrollButtons: 'auto',
  allowScrollButtonsMobile: true,
} as const;
