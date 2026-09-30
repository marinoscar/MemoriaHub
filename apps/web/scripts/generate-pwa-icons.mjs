// Generates the PWA icon set under `public/icons/` from the committed
// `public/android-chrome-512x512.png` master (issue #482, epic #481).
//
//   node apps/web/scripts/generate-pwa-icons.mjs
//
// Uses `sharp`, which is NOT a dependency of the web workspace: it is hoisted
// to the repo-root `node_modules` by the API workspace. That is deliberate —
// this script is run by hand when the logo changes, never by the build, so it
// must not pull a native image library into the web bundle's dependency graph.
//
// Outputs (all referenced by `pwa/manifest.ts` or `src/sw.ts`, and asserted to
// exist by `src/__tests__/pwa/manifest.test.ts`):
//   icon-192.png / icon-512.png            purpose "any" — the logo as-is
//   icon-maskable-192.png / -512.png       purpose "maskable" — the logo shrunk
//                                          into the 80% safe zone on an opaque
//                                          white ground, so Android's adaptive
//                                          mask never crops the loops
//   badge-72.png                           the notification status-bar badge:
//                                          white silhouette on transparent.
//                                          Android draws ONLY the alpha channel
//                                          of a badge, so a colour logo there
//                                          renders as a solid white square.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const master = resolve(webRoot, 'public', 'android-chrome-512x512.png');
const outDir = resolve(webRoot, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const out = (name) => resolve(outDir, name);

for (const size of [192, 512]) {
  await sharp(master).resize(size, size).png().toFile(out(`icon-${size}.png`));

  // 70% of the canvas keeps the logo's corners inside the maskable safe zone
  // (a circle of radius 40% of the canvas), with a little breathing room.
  const inner = Math.round(size * 0.7);
  const logo = await sharp(master).resize(inner, inner).png().toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: '#ffffff' },
  })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toFile(out(`icon-maskable-${size}.png`));
}

// Badge: keep the master's alpha, paint every pixel white.
const BADGE = 72;
const alpha = await sharp(master)
  .resize(BADGE, BADGE)
  .ensureAlpha()
  .extractChannel('alpha')
  .toBuffer();
await sharp({
  create: { width: BADGE, height: BADGE, channels: 3, background: '#ffffff' },
})
  .joinChannel(alpha, { raw: undefined })
  .png()
  .toFile(out('badge-72.png'));

console.log(`Wrote PWA icons to ${outDir}`);
