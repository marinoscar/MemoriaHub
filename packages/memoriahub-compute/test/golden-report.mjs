// Reports (always) the max diff of the CLIP embedding against the committed
// golden vector for each image, with the runner CPU model, and decides whether
// a diff fails the job. Usage: node golden-report.mjs <api.json> <worker.json>
//
// WHY THIS IS CPU-GATED: the committed golden vector (golden-clip-512.json) was
// derived on an AVX2-class CPU. The CLIP model is int8-quantized and
// onnxruntime's quantized kernels are instruction-set dependent: with
// byte-identical input pixels (compare-parity.mjs proves that) an AMD EPYC 9V45
// runner (AVX-512 VNNI) yields a max diff of 0.01527 while an EPYC 7763 passes.
// So the gate is BLOCKING only on a CPU model listed in GOLDEN_BLESSED_CPU
// (regex, default EPYC 7763 = the class the vector reproduces on); elsewhere the
// diff is reported as a ::warning:: and a summary row, never hidden. Whether to
// regenerate the golden vector on newer hardware is an owner decision.
import { readFileSync, appendFileSync } from 'node:fs';

const TOL = 1e-4;
const blessed = new RegExp(process.env.GOLDEN_BLESSED_CPU || 'EPYC 7763');
const rows = [];
let fail = false;
for (const [label, file] of [['API image', process.argv[2]], ['worker image', process.argv[3]]]) {
  const r = JSON.parse(readFileSync(file, 'utf8'));
  const isBlessed = blessed.test(r.cpuModel);
  const ok = r.goldenMaxDiff != null && r.goldenMaxDiff < TOL;
  const status = ok ? 'pass' : isBlessed ? 'FAIL (blocking CPU class)' : 'differs (non-blocking CPU class)';
  rows.push(`| ${label} | ${r.cpuModel} | ${r.goldenMaxDiff} | ${isBlessed ? 'blocking' : 'warning only'} | ${status} |`);
  console.log(`${label}: cpu="${r.cpuModel}" goldenMaxDiff=${r.goldenMaxDiff} (tolerance ${TOL}) -> ${status}`);
  if (!ok && isBlessed) {
    fail = true;
  } else if (!ok) {
    console.log(`::warning title=CLIP golden vector differs on this CPU class::${label} max diff ${r.goldenMaxDiff} on "${r.cpuModel}" (not in the blessed class /${blessed.source}/). onnxruntime int8 kernels are instruction-set dependent; the cross-executor parity check is the blocking invariant.`);
  }
}
const table = `### CLIP committed-golden-vector comparison\n\n| Image | CPU | Max diff | Gate | Result |\n|---|---|---|---|---|\n${rows.join('\n')}\n`;
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table + '\n');
process.exit(fail ? 1 : 0);
