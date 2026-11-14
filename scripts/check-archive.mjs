import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseVOTable, searchObservations } from './observations.mjs';

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
await assert.rejects(() => searchObservations(params, async () => { throw new Error('offline'); }), /unavailable/);

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
} finally { globalThis.fetch = originalFetch; }
console.log('Archive and coordinate checks passed (synthetic FITS and VOTable; no live service).');
