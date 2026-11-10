// platform-node-stub.mjs - a stand-in for the platform node API, to try the worker end to end without a server
// (RETRO-C10, #616). It serves one thumbnail_regen, one geocode (Nominatim answers 429 with Retry-After: 7) and one
// workflow_execute_batch job, then prints what the node submitted (results, failures with `rateLimited` and
// `retryAfterMs`, the PUT to the server-chosen output key).
//
//   FIXED_PORT=44555 RUN_MS=20000 node scripts/platform-node-stub.mjs 2> results.json &
//   MEMORIAHUB_SERVER_URL=http://127.0.0.1:44555 MEMORIAHUB_TOKEN=nod_placeholder MEMORIAHUB_HEADLESS=true \
//     MEMORIAHUB_ELIGIBLE_TYPES=thumbnail_regen,geocode,workflow_execute_batch node dist/cli.js node start --headless
//
// An in-process stand-in for the platform node API: one thumbnail job, one geocode job, one workflow job.
import http from 'node:http';
import { createRequire } from 'node:module';
const sharp = createRequire(import.meta.url)('sharp');
const img = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#aa5500' } }).jpeg().toBuffer();
const PORTENV = process.env.FIXED_PORT;
const jobs = [
  { type: 'thumbnail_regen', params: {}, subject: 'media_item' },
  { type: 'geocode', params: { lat: 9.93, lng: -84.08, provider: 'nominatim', baseUrl: 'http://127.0.0.1:' + process.env.FIXED_PORT + '/nom' }, subject: 'media_item' },
  { type: 'workflow_execute_batch', params: { runId: 'run-1', itemIds: ['a', 'b'], actions: [{ type: 'archive' }] }, subject: 'circle' },
];
const results = [];
let n = 0;
const send = (res, body, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: body })); };
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const url = req.url;
  const body = raw.length && req.headers['content-type']?.includes('json') ? JSON.parse(raw.toString()) : {};
  if (url.startsWith('/nom')) { res.writeHead(429, { 'retry-after': '7' }); return res.end('slow down'); }
  if (url === '/store/get') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(img); }
  if (url.startsWith('/store/put')) { results.push({ put: url, bytes: raw.length }); res.writeHead(200); return res.end(); }
  const path = url.replace(/^\/api/, '');
  if (path === '/nodes/register') return send(res, { node: { id: 'node-1', name: body.name }, reattached: false, serverFeatures: [] });
  if (path === '/nodes/job-types') return send(res, { types: jobs.map((j) => ({ type: j.type })) });
  if (/\/heartbeat$/.test(path)) return send(res, { ok: true });
  if (/\/telemetry$/.test(path) || /\/events$/.test(path)) return send(res, {});
  if (/\/claim$/.test(path)) {
    if (n >= jobs.length) return send(res, { jobs: [] });
    const j = jobs[n++]; const id = `job-${n}`;
    return send(res, { jobs: [{ job: { id, type: j.type, subjectType: j.subject, subjectId: 'x', priority: 0, attempts: 1, startedAt: new Date().toISOString(), leaseExpiresAt: null }, params: j.params, renewIntervalMs: 30000, claimToken: `ct-${n}` }] });
  }
  if (/\/download-url$/.test(path)) return send(res, { url: 'http://127.0.0.1:' + server.address().port + '/store/get', objectId: 'o1', size: String(img.length), mimeType: 'image/jpeg', expiresIn: 60, expiresAt: new Date(Date.now() + 60000).toISOString() });
  if (/\/upload-url$/.test(path)) return send(res, { url: 'http://127.0.0.1:' + server.address().port + '/store/put?sig=zz', key: 'node-outputs/' + path.split('/')[4] + '/obj', expiresIn: 60, expiresAt: new Date(Date.now() + 60000).toISOString() });
  if (/\/result$/.test(path)) { results.push({ result: path, body }); return send(res, { jobId: path.split('/')[4], outcome: 'succeeded', willRetry: false }); }
  if (/\/failure$/.test(path)) { results.push({ failure: path, body }); return send(res, { jobId: path.split('/')[4], outcome: 'failed', willRetry: false }); }
  if (/\/renew$/.test(path)) return send(res, {});
  send(res, {}, 404);
});
server.listen(Number(process.env.FIXED_PORT), '127.0.0.1', () => { console.log(server.address().port); });
setTimeout(() => { console.error(JSON.stringify(results, null, 1)); process.exit(0); }, Number(process.env.RUN_MS ?? 25000));
