import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseVOTable, searchObservations } from './observations.mjs';
import { discoverReleases, discoveredCollections, listedPrefixes, newerReleases, resetDiscovery } from './releases.mjs';

const require = createRequire(import.meta.url);
const sky = require('../dist/archive.cjs');
assert.ok(Math.abs(sky.parseCoordinate('08h55m10.831s', 'ra') - 133.795129167) < 1e-7);
assert.ok(Math.abs(sky.parseCoordinate('-7d14m42.53s', 'dec') + 7.24514722) < 1e-7);
assert.equal(sky.parseCoordinate('360', 'ra'), 0);
assert.equal(sky.parseCoordinate('-0:30:00', 'dec'), -0.5);
for (const value of ['NaN', '10:60:00', '90:00:01']) assert.throws(() => sky.parseCoordinate(value, 'dec'));

const fields = ['obs_id','obs_collection','energy_bandpassname','access_url','t_min','t_max','s_region'];
const path = 'dr1/level2/2025W19_1B/l2b-v27-2026-197/6/test.fits';
const row = ['test','spherex_dr1','SPHEREx-D6',`https://irsa.ipac.caltech.edu/ibe/data/spherex/${path}`,'60800','60801',''];
const xml = `<VOTABLE><RESOURCE><TABLE>${fields.map(name => `<FIELD name="${name}"/>`).join('')}<DATA><TABLEDATA><TR>${row.map(value => `<TD>${value}</TD>`).join('')}</TR></TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>`;
assert.equal(parseVOTable(xml).observations[0].productKey, path);
assert.equal(parseVOTable(xml.replace('<TD>60800</TD>', '<TD></TD>')).observations.length, 0);
const params = new URLSearchParams({ra:'133.7',dec:'-7.2',fov:'5',band:'6'});
let calls = 0;
const reply = await searchObservations(params, async () => { calls++; return new Response(xml); });
assert.equal(calls, 4);
assert.equal(reply.observations.length, 1);
assert.equal(reply.collections.length, 4);
await assert.rejects(() => searchObservations(new URLSearchParams({ra:'bad'}), async () => { throw new Error('must not fetch'); }));
await assert.rejects(() => searchObservations(params, async () => { throw new Error('offline'); }), /not answering/);

// New releases found in the bucket are searched too; their failures are marked and never fatal.
const qr4Xml = xml.replaceAll('dr1/', 'qr4/').replace('spherex_dr1', 'spherex_qr4');
assert.equal(parseVOTable(qr4Xml).observations.length, 0, 'unknown release ignored by default');
const withQr4 = await searchObservations(params, async (url) => new Response(String(url).includes('qr4') ? qr4Xml : xml), ['spherex_qr4', 'spherex_qr4_deep']);
assert.equal(withQr4.collections.length, 6);
assert.ok(withQr4.observations.some((item) => item.productKey.startsWith('qr4/')));
assert.ok(withQr4.collections.filter((c) => c.name.includes('qr4')).every((c) => c.discovered));
const qr4Down = await searchObservations(params, async (url) => { if (String(url).includes('qr4')) throw new Error('down'); return new Response(xml); }, ['spherex_qr4']);
assert.equal(qr4Down.collections.find((c) => c.name === 'spherex_qr4').status, 'unavailable');

const bucket = (prefixes, prefix = '') => `<?xml version="1.0"?><ListBucketResult><Prefix>${prefix}</Prefix>${prefixes.map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`;
assert.deepEqual(listedPrefixes(bucket(['dr1/', 'qr2/', 'qr3/'])), ['dr1/', 'qr2/', 'qr3/']);
assert.deepEqual(newerReleases(['dr1', 'qr3'], ['dr1', 'qr2', 'qr3', 'qr4', 'dr2', 'xr9', 'tmp']), ['dr2', 'qr4']);
const listing = async (url) => {
  const prefix = url.searchParams.get('prefix') ?? '';
  if (!prefix) return new Response(bucket(['dr1/', 'dr2/', 'qr3/', 'qr4/']));
  if (prefix === 'qr4/') return new Response(bucket(['qr4/level2/', 'qr4/dark/'], prefix));
  return new Response(bucket([`${prefix}dark/`], prefix)); // dr2 has no level2 images yet
};
assert.deepEqual(await discoverReleases(['dr1', 'qr3'], listing), ['qr4']);
resetDiscovery();
assert.deepEqual(await discoveredCollections(['spherex_dr1', 'spherex_qr3_deep'], listing, 1e12), ['spherex_qr4', 'spherex_qr4_deep']);
resetDiscovery();
assert.deepEqual(await discoveredCollections(['spherex_dr1'], async () => { throw new TypeError('offline'); }, 1e12), []);
resetDiscovery();

// Deep-field search steps back in 90-day windows when recent slices are empty (e.g. R Draconis in DR1 deep).
const emptyXml = `<VOTABLE><RESOURCE><TABLE>${fields.map(name => `<FIELD name="${name}"/>`).join('')}<DATA><TABLEDATA></TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>`;
const deepPath = 'dr1/level2/2025W25_1A/l2b-deep/5/rdra_deep.fits';
const deepRow = ['deep1', 'spherex_dr1_deep', 'SPHEREx-D5', `https://irsa.ipac.caltech.edu/ibe/data/spherex/${deepPath}`, '60850', '60850.1', ''];
const deepXml = `<VOTABLE><RESOURCE><TABLE>${fields.map(name => `<FIELD name="${name}"/>`).join('')}<DATA><TABLEDATA><TR>${deepRow.map(value => `<TD>${value}</TD>`).join('')}</TR></TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>`;
const rdraSeen = [];
const rdraReply = await searchObservations(new URLSearchParams({
  ra: '248.167233', dec: '66.755024', fov: '5', band: '5', fromMjd: '60789', toMjd: '61060',
}), async (url, options) => {
  assert.match(options?.headers?.['User-Agent'] ?? '', /SkyShift/);
  const q = new URL(url).searchParams;
  const col = q.get('COLLECTION');
  const [start, end] = q.get('TIME').split(' ').map(Number);
  rdraSeen.push({ col, start, end });
  if (col === 'spherex_dr1_deep' && start <= 60850 && end >= 60850) return new Response(deepXml);
  return new Response(emptyXml);
});
assert.equal(rdraReply.observations.length, 1);
assert.equal(rdraReply.observations[0].productKey, deepPath);
const dr1DeepMeta = rdraReply.collections.find((c) => c.name === 'spherex_dr1_deep');
assert.ok(dr1DeepMeta.fromMjd <= 60850 && dr1DeepMeta.toMjd >= 60850);
assert.equal(dr1DeepMeta.count, 1);
assert.ok(rdraSeen.filter((s) => s.col === 'spherex_dr1_deep').length === 3);

let narrowCalls = 0;
await searchObservations(new URLSearchParams({
  ra: '248.167233', dec: '66.755024', fov: '5', band: '5', fromMjd: '60800', toMjd: '60830',
}), async () => { narrowCalls++; return new Response(emptyXml); });
assert.equal(narrowCalls, 4);

// A synthetic uncompressed detector tests offset calculation, big-endian decoding,
// range validation, and crop projection without requiring a network connection.
const card = (key, value) => (key.padEnd(8) + '= ' + value).padEnd(80);
const block = (cards, size = 2880) => cards.join('').padEnd(size - 80, ' ') + 'END'.padEnd(80);
const primary = block([card('SIMPLE','T'), card('BITPIX','8'), card('NAXIS','0')]);
const image = block([
  card('XTENSION', "'IMAGE   '"), card('EXTNAME', "'IMAGE   '"), card('BITPIX','-32'),
  card('NAXIS','2'), card('NAXIS1','2040'), card('NAXIS2','2040'),
  card('CRVAL1','133.7'), card('CRVAL2','-7.2'), card('CRPIX1','1021'), card('CRPIX2','1021'),
  card('CDELT1','-0.001708333333333'), card('CDELT2','0.001708333333333'),
], 23040);
const file = new Uint8Array(25920 + 2040 * 2040 * 4);
file.set(new TextEncoder().encode(primary + image));
const data = new DataView(file.buffer);
for (let y = 950; y <= 1090; y++) for (let x = 950; x <= 1090; x++) data.setFloat32(25920 + 4 * (y * 2040 + x), x + y, false);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, options) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
  const start = Number(match[1]), end = Number(match[2]);
  return new Response(file.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}` } });
};
try {
  const exposure = await sky.fetchExposure({id:'test', productKey:path, detector:6, startMjd:60800, endMjd:60801}, 133.7, -7.2, 5, new AbortController().signal);
  const h = exposure.header;
  assert.equal(exposure.pixels[(1020 - h.y0) * h.size + 1020 - h.x0], 2040);
  assert.equal(h.mjd, 60800.5);
  await assert.rejects(() => sky.fetchExposure({id:'bad', productKey:'../../bad.fits', detector:6, startMjd:1, endMjd:2}, 0, 0, 5, new AbortController().signal), /Invalid archive/);

  // 20' FOV with >14 visits samples visits evenly (preserving oldest and newest) instead of failing.
  const manyObs = Array.from({ length: 20 }, (_, i) => ({
    id: `v${i}`,
    productKey: `dr1/level2/2025W19_1B/l2b-v27-2026-197/6/v${i}.fits`,
    detector: 6,
    startMjd: 60800 + i * 45,
    endMjd: 60800 + i * 45 + 0.1,
  }));
  const sampled20 = await sky.makeLiveFixture(manyObs, 133.7, -7.2, 20, new AbortController().signal, () => {}, false);
  assert.equal(sampled20.dates.length, 14);
  assert.equal(sampled20.headers[0].productKey, manyObs[0].productKey);
  assert.equal(sampled20.headers[sampled20.headers.length - 1].productKey, manyObs[19].productKey);
} finally { globalThis.fetch = originalFetch; }

// WCS-WAVE lookup is cached per detector/release so repeated calls avoid redundant tail requests.
{
  const waveHeader = block([
    card('XTENSION', "'BINTABLE'"), card('EXTNAME', "'WCS-WAVE'"),
    card('BITPIX', '8'), card('NAXIS', '2'), card('NAXIS1', '48'), card('NAXIS2', '1'),
    card('TFORM1', "'2J      '"), card('TFORM2', "'2J      '"), card('TFORM3', "'4E      '"), card('TFORM4', "'4E      '"),
  ], 2880);
  const waveBlock = new Uint8Array(5760);
  waveBlock.set(new TextEncoder().encode(waveHeader));
  const dv = new DataView(waveBlock.buffer, 2880);
  dv.setInt32(0, 1, false); dv.setInt32(4, 2040, false);
  dv.setInt32(8, 1, false); dv.setInt32(12, 2040, false);
  for (let py = 0; py < 2; py++) for (let px = 0; px < 2; px++) {
    const idx = 16 + 8 * (py * 2 + px);
    dv.setFloat32(idx, 4.4 + px * 0.2 + py * 0.4, false);
    dv.setFloat32(idx + 4, 0.04, false);
  }
  let waveFetches = 0;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options?.headers?.Range, 'bytes=-5760');
    waveFetches++;
    return new Response(waveBlock, { status: 206 });
  };
  try {
    const mkHdr = (name) => ({
      id: name, size: 21, x0: 1000, y0: 1000, crval: [133.7, -7.2], crpix: [11, 11],
      cdelt: [-0.0017, 0.0017], pc: [1, 0, 0, 1], a: {}, b: {}, ap: {}, bp: {},
      productKey: `dr1/level2/2025W19_1B/l2b-v27-2026-197/6/${name}.fits`,
    });
    const [w1, bw1] = await sky.fetchWavelength(mkHdr('a'), 0, 0, new AbortController().signal);
    const [w2] = await sky.fetchWavelength(mkHdr('b'), 2039, 2039, new AbortController().signal);
    assert.equal(waveFetches, 1);
    assert.ok(Math.abs(w1 - 4.4) < 1e-4 && Math.abs(bw1 - 0.04) < 1e-4);
    assert.ok(Math.abs(w2 - 5.0) < 1e-4);
    const [w5] = await sky.fetchWavelength({
      ...mkHdr('c'), productKey: 'dr1/level2/2025W19_1B/l2b-v27-2026-197/5/c.fits',
    }, 0, 0, new AbortController().signal);
    assert.equal(waveFetches, 2);
    assert.ok(Math.abs(w5 - 4.4) < 1e-4);

    const cancelled = new AbortController(), active = new AbortController();
    const header = { ...mkHdr('d'), productKey: 'dr1/level2/2025W19_1B/l2b-v27-2026-197/4/d.fits' };
    globalThis.fetch = async (_url, { signal }) => {
      if (signal === cancelled.signal) {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return new Response(waveBlock, { status: 206 });
    };
    const rejected = assert.rejects(sky.fetchWavelength(header, 0, 0, cancelled.signal), { name: 'AbortError' });
    const usable = sky.fetchWavelength(header, 0, 0, active.signal);
    cancelled.abort();
    const [[w4]] = await Promise.all([usable, rejected]);
    assert.ok(Math.abs(w4 - 4.4) < 1e-4);
  } finally { globalThis.fetch = originalFetch; }
}

// Retry-After handling for HTTP 429 and 503 range requests.
assert.equal(sky.parseRetryAfterMs('2', 1000), 2000);
assert.equal(sky.parseRetryAfterMs('0', 1000), 0);
assert.equal(sky.parseRetryAfterMs('120', 1000), 15000);
assert.equal(sky.parseRetryAfterMs('Wed, 01 Jan 2025 00:00:05 GMT', 1000, Date.parse('Wed, 01 Jan 2025 00:00:00 GMT')), 5000);
assert.equal(sky.parseRetryAfterMs(null, 1000), 1000);
{
  let attempt = 0;
  globalThis.fetch = async (_url, options) => {
    attempt++;
    if (attempt === 1) return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
    if (attempt === 2) return new Response('', { status: 503, headers: { 'Retry-After': '0' } });
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    const start = Number(match[1]), end = Number(match[2]);
    return new Response(file.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}` } });
  };
  try {
    const retried = await sky.fetchExposure({ id: 'retry', productKey: 'dr1/level2/2025W19_1B/l2b-v27-2026-197/6/retry.fits', detector: 6, startMjd: 60800, endMjd: 60801 }, 133.7, -7.2, 5, new AbortController().signal);
    assert.equal(attempt, 4); // 2 retries + header/pixel range reads
    assert.equal(retried.header.productKey, 'dr1/level2/2025W19_1B/l2b-v27-2026-197/6/retry.fits');
  } finally { globalThis.fetch = originalFetch; }
}

// P2-03: In-flight crop deduplication & cacheDiagnostics.
{
  let rangeCalls = 0;
  globalThis.fetch = async (_url, options) => {
    rangeCalls++;
    await new Promise((r) => setTimeout(r, 10));
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    const start = Number(match[1]), end = Number(match[2]);
    return new Response(file.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}` } });
  };
  try {
    const obs = { id: 'dedup', productKey: 'dr1/level2/2025W19_1B/l2b-v27-2026-197/6/dedup.fits', detector: 6, startMjd: 60800, endMjd: 60801 };
    const [c1, c2] = await Promise.all([
      sky.fetchExposure(obs, 133.7, -7.2, 5, new AbortController().signal),
      sky.fetchExposure(obs, 133.7, -7.2, 5, new AbortController().signal),
    ]);
    assert.equal(rangeCalls, 2, 'Concurrent identical crop requests share in-flight promise (header + pixels only once)');
    assert.equal(c1.header.productKey, c2.header.productKey);
    const diag = await sky.cacheDiagnostics();
    assert.ok(diag.memoryCrops >= 2, `Expected >=2 cached crops, got ${diag.memoryCrops}`);
    assert.ok(diag.memoryCropBytes > 0);
    assert.equal(diag.waveGrids, 3);
  } finally { globalThis.fetch = originalFetch; }
}

// P2-06: Preflight download estimation and frame wavelength spans.
{
  const est5 = sky.estimateDownloadBytes([], 5);
  const est20 = sky.estimateDownloadBytes([], 20);
  assert.ok(est20.perExposureBytes > est5.perExposureBytes, '20-arcmin field has larger per-exposure byte estimate than 5-arcmin');
  assert.ok(est5.maximumExposures > est20.maximumExposures);
  const mockObs = Array.from({ length: 12 }, (_, i) => ({
    id: `e${i}`, productKey: `dr1/level2/2025W19_1B/l2b-v27-2026-197/6/e${i}.fits`, detector: 6, startMjd: 60800 + Math.floor(i / 4) * 50, endMjd: 60801 + Math.floor(i / 4) * 50,
  }));
  const estObs = sky.estimateDownloadBytes(mockObs, 5);
  assert.equal(estObs.totalVisits, 3);
  assert.equal(estObs.keptVisits, 3);
  assert.equal(estObs.selectedExposures, 12);
  assert.equal(estObs.totalBytes, 12 * estObs.perExposureBytes);

  const sampleFixture = {
    id: 'wspan', ra0: 133.7, dec0: -7.2, half: 20, scale: 3.075, dates: ['2025-05-01'], visitSizes: [2],
    headers: [
      { size: 41, x0: 0, y0: 0, crval: [133.7, -7.2], crpix: [21, 21], cdelt: [-0.001, 0.001], pc: [1, 0, 0, 1], a: {}, b: {}, ap: {}, bp: {}, wavelength: 4.50, bandwidth: 0.04 },
      { size: 41, x0: 0, y0: 0, crval: [133.7, -7.2], crpix: [21, 21], cdelt: [-0.001, 0.001], pc: [1, 0, 0, 1], a: {}, b: {}, ap: {}, bp: {}, wavelength: 4.80, bandwidth: 0.06 },
    ],
    pixels: '',
  };
  const visitSpan = sky.frameWavelengthSpan(sampleFixture, 0, 'visits', 6);
  assert.equal(visitSpan.exact, true);
  assert.ok(Math.abs(visitSpan.min - 4.48) < 1e-6 && Math.abs(visitSpan.max - 4.83) < 1e-6);
  const expSpan = sky.frameWavelengthSpan(sampleFixture, 1, 'exposures', 6);
  assert.equal(expSpan.exact, true);
  assert.ok(Math.abs(expSpan.min - 4.77) < 1e-6 && Math.abs(expSpan.max - 4.83) < 1e-6);
  const nominalSpan = sky.frameWavelengthSpan({ ...sampleFixture, headers: [{ ...sampleFixture.headers[0], wavelength: undefined, bandwidth: undefined }] }, 0, 'visits', 2);
  assert.deepEqual(nominalSpan, { min: 1.10, max: 1.65, exact: false });
}

console.log('Archive and coordinate checks passed (synthetic FITS and VOTable; no live service).');
