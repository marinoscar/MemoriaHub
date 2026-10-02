// Generates the Android launcher and notification icons from the PWA's icons (issue #508), so the
// installed app and the installed PWA share one logo:
//
//   node apps/android/scripts/generate-launcher-icons.mjs
//
// Run by hand when the logo changes, never by the build (same posture as
// apps/web/scripts/generate-pwa-icons.mjs). Uses `sharp`, hoisted to the repo-root node_modules
// by the API workspace. The outputs are committed.
//
// Inputs:
//   apps/web/public/icons/icon-maskable-512.png   the PWA's maskable icon (logo at 70% of the
//                                                 canvas on an opaque white ground)
//   apps/web/public/android-chrome-512x512.png    the transparent master (its alpha channel is the
//                                                 logo's silhouette)
//
// Outputs under apps/android/app/src/main/res/:
//   mipmap-<dpi>/ic_launcher_foreground.png   adaptive-icon foreground (108dp canvas). The maskable
//                                             icon is scaled so the logo spans ~54% of the canvas,
//                                             inside the 66dp safe zone every launcher mask keeps;
//                                             the white ground blends into the white background
//                                             layer (@color/ic_launcher_background).
//   mipmap-<dpi>/ic_launcher_monochrome.png   Android 13 themed icon: white silhouette, transparent.
//   drawable-<dpi>/ic_notification.png        status-bar icon for delegated Web Push (24dp, white
//                                             silhouette; Android draws only the alpha channel).
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const androidRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webPublic = resolve(androidRoot, '..', 'web', 'public');
const maskable = resolve(webPublic, 'icons', 'icon-maskable-512.png');
const master = resolve(webPublic, 'android-chrome-512x512.png');
const res = resolve(androidRoot, 'app', 'src', 'main', 'res');

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
/** Adaptive icon canvas, in dp. */
const LAUNCHER_DP = 108;
/** The maskable icon's logo spans 70% of its canvas; we want the logo at 54% of 108dp. */
const MASKABLE_SCALE = 0.54 / 0.7;
/** The master's logo fills its canvas; monochrome logo at the same 54% as the foreground. */
const MONO_SCALE = 0.54;
const NOTIFICATION_DP = 24;
/** Notification icons keep a 2dp margin (material icon grid). */
const NOTIFICATION_SCALE = 20 / 24;

async function silhouette(size) {
  const alpha = await sharp(master).resize(size, size).ensureAlpha().extractChannel('alpha').toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: '#ffffff' } })
    .joinChannel(alpha)
    .png()
    .toBuffer();
}

async function centered(input, canvas, file) {
  await sharp({ create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toFile(file);
}

for (const [dpi, factor] of Object.entries(DENSITIES)) {
  const canvas = Math.round(LAUNCHER_DP * factor);
  const mipmap = resolve(res, `mipmap-${dpi}`);
  mkdirSync(mipmap, { recursive: true });

  const fg = Math.round(canvas * MASKABLE_SCALE);
  await centered(await sharp(maskable).resize(fg, fg).png().toBuffer(), canvas, resolve(mipmap, 'ic_launcher_foreground.png'));

  const mono = Math.round(canvas * MONO_SCALE);
  await centered(await silhouette(mono), canvas, resolve(mipmap, 'ic_launcher_monochrome.png'));

  const nCanvas = Math.round(NOTIFICATION_DP * factor);
  const drawable = resolve(res, `drawable-${dpi}`);
  mkdirSync(drawable, { recursive: true });
  await centered(await silhouette(Math.round(nCanvas * NOTIFICATION_SCALE)), nCanvas, resolve(drawable, 'ic_notification.png'));
}

console.log(`Wrote launcher and notification icons under ${res}`);
