// Diffs the JSON written by emit-parity.mjs inside the API image and inside the
// worker image on the same runner. Exits 1 on any mismatch (CLIP > 1e-4, dHash,
// pixel hashes). Runs on the CI runner itself; no dependencies.
// Usage: node compare-parity.mjs <api.json> <worker.json>
import { readFileSync, appendFileSync } from 'node:fs';

const TOL = 1e-4;
const [a, b] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, 'utf8')));
const rows = [];
let failed = false;
const row = (what, ok, detail) => {
  rows.push(`| ${what} | ${ok ? 'match' : '**MISMATCH**'} | ${detail} |`);
  if (!ok) failed = true;
};

if (a.cpuModel !== b.cpuModel) {
  console.log(`::warning::API and worker containers report different CPU models (${a.cpuModel} vs ${b.cpuModel}); not the same runner?`);
}
for (const name of Object.keys(a.fixtures)) {
  const x = a.fixtures[name];
  const y = b.fixtures[name];
  row(`${name} decode pixels`, x.decodePixelsSha256 === y.decodePixelsSha256 && !x.pixelsError && !y.pixelsError, x.pixelsError ?? y.pixelsError ?? 'sha256 equal');
  row(`${name} resize 224 pixels`, x.resize224PixelsSha256 === y.resize224PixelsSha256 && !x.pixelsError && !y.pixelsError, 'sha256');
  row(`${name} dHash`, x.dhash === y.dhash && x.dhash != null, `api=${x.dhash} worker=${y.dhash}`);
  if (!x.clip || !y.clip) {
    row(`${name} CLIP embedding`, false, `null embedding (api=${x.clip ? 'ok' : 'null'}, worker=${y.clip ? 'ok' : 'null'})`);
  } else {
    let max = 0;
    for (let i = 0; i < x.clip.length; i++) max = Math.max(max, Math.abs(x.clip[i] - y.clip[i]));
    row(`${name} CLIP embedding`, x.clip.length === y.clip.length && max < TOL, `max element-wise diff ${max} (tolerance ${TOL})`);
  }
}

const table = `### Cross-executor parity (API image vs worker image, same runner: ${a.cpuModel})\n\n| Check | Result | Detail |\n|---|---|---|\n${rows.join('\n')}\n`;
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table + '\n');
if (failed) {
  console.log('::error title=Executor parity FAILED::the API image and the worker image produced different results for the same fixture on the same CPU. Server and worker embeddings would disagree; see the table above.');
  process.exit(1);
}
