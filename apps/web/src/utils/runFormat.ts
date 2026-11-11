// The helpers live in the packaged core (`@marinoscar/memoriahub-web/core/headless`);
// this re-export keeps the app's imports unchanged.
export {
  runStatusColor,
  runStatusLabel,
  isTerminalRunStatus,
  formatCount,
  formatRelativeTime,
  formatCaptureDate,
  runProgressPercent,
} from '@marinoscar/memoriahub-web/core/headless';
