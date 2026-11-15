import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseCsv, searchCatalogue } from './catalogue.mjs';
import { validateQuality, handleQuality, resolvePython } from './quality.mjs';
import { parseChannelProperties, handleChannels } from './channels.mjs';
const require = createRequire(import.meta.url);
const sky = require('../dist/archive.cjs');
const worker = require('../dist/worker.cjs');
const fixture = require('../dist/fixture.json');

const filtered = await sky.filterWavelength(fixture, 4.41, 4.55, new AbortController().signal);
assert.ok(filtered.fixture.headers.length > 0 && filtered.fixture.headers.length < fixture.headers.length);
assert.equal(filtered.fixture.headers.length, filtered.fixture.visitSizes.reduce((a,b) => a+b,0));
assert.equal(sky.decodeFixture(filtered.fixture).length, filtered.fixture.headers.length);
for (const h of filtered.fixture.headers) assert.ok(h.wavelength + h.bandwidth / 2 >= 4.41 && h.wavelength - h.bandwidth / 2 <= 4.55);
await assert.rejects(() => sky.filterWavelength(fixture, 4.9, 4.8, new AbortController().signal));

// A moving source needs a new aperture centre in the second visit.
const size = 65, centre = 32, scale = 6.15 / 3600;
const positions = [{ ra: 30, dec: 0 }, { ra: 30 + 16 * scale, dec: 0 }];
const samples = [
  { x: centre, excess: 21, wavelength: 4.42 },
  { x: centre + 16, excess: 42, wavelength: 4.50 },
  { x: centre + 16, excess: 63, wavelength: 4.65 },
];
const pixels = Buffer.alloc(samples.length * size ** 2 * 4);
const headers = samples.map(({ x, excess, wavelength }, exposure) => {
  for (let i = 0; i < size ** 2; i++) pixels.writeFloatLE(5, 4 * (exposure * size ** 2 + i));
  pixels.writeFloatLE(5 + excess, 4 * (exposure * size ** 2 + centre * size + x));
  return {
    size, x0: 0, y0: 0, crval: [30, 0], crpix: [centre + 1, centre + 1],
    pc: [1, 0, 0, 1], cdelt: [scale, scale], a: {}, b: {}, ap: {}, bp: {},
    wavelength, bandwidth: 0.04,
  };
});
const movingFixture = {
  ...fixture, ra0: 30, dec0: 0, dates: ['First', 'Second'],
  visitSizes: [1, 2], headers, pixels: pixels.toString('base64'),
};
const signal = new AbortController().signal;
const fixed = await sky.quickSpectrum(movingFixture, signal, positions[0]);
assert.deepEqual(fixed.map((point) => point.surfaceBrightness), [1, 0, 0]);
const moving = await sky.quickSpectrum(movingFixture, signal, (visit) => positions[visit]);
assert.deepEqual(moving.map((point) => point.surfaceBrightness), [1, 2, 3]);
assert.ok(moving.every((point) => point.wavelengthAtReferencePosition));
assert.ok(Math.abs(moving[1].flux - 42 * 37.86 * (Math.PI / 648000) ** 2 * 1e6) < 1e-12);
const missing = await sky.quickSpectrum(movingFixture, signal, (visit, exposure) => exposure === 1 ? undefined : positions[visit]);
assert.deepEqual(missing.map((point) => point.surfaceBrightness), [1, 3]);

assert.deepEqual(sky.decodeQualityFlags((1 << 1) + (1 << 21)), ['OVERFLOW (near saturation)', 'SOURCE (known source)']);
assert.deepEqual(sky.decodeQualityFlags(1 << 3), ['Unknown bit 3']);
assert.throws(() => sky.decodeQualityFlags(-1));
const a = new Float32Array([1, NaN, -2]), b = new Float32Array([3, 2, -2]);
const diff = sky.combineFrames(a,b,'difference'), reverse = sky.combineFrames(b,a,'difference');
assert.equal(diff[0], 2); assert.equal(reverse[0], -2); assert.ok(Number.isNaN(diff[1]));
assert.equal(sky.combineFrames(a,a,'difference')[2], 0);
assert.equal(sky.combineFrames(a,b,'sum')[0], 4);


const output = await worker.runRequest({engine:'typescript', scenario:'wise0855', cache:'none', fixture, wasm:'', frameMode:'exposures'}, () => {});
assert.equal(output.series.frames.length, 45);
assert.ok(output.series.counts.every(n => n === 1));

assert.equal(parseCsv('source_id,ra,dec\r\n"123,456",1.5,-2\r\n')[0].source_id, '123,456');
const params = new URLSearchParams({catalogue:'gaia', ra:'133.7', dec:'-7.2', fov:'5'});
const result = await searchCatalogue(params, async (url) => {
  assert.equal(url.hostname, 'gea.esac.esa.int');
  assert.match(url.searchParams.get('QUERY'), /gaiadr3\.gaia_source/);
  assert.match(url.searchParams.get('QUERY'), /ORDER BY phot_g_mean_mag ASC/);
  return new Response('source_id,ra,dec,pmra,pmdec,phot_g_mean_mag,bp_rp,parallax\n1234567890123456789,133.7,-7.2,-10.5,0,14.25,1.8,45.2\n');
});
assert.equal(result.sources[0].id, '1234567890123456789');
assert.equal(result.sources[0].pmdec, 0);
assert.equal(result.sources[0].magnitude, 14.25);
assert.equal(result.sources[0].colour, 1.8);
assert.equal(result.sources[0].parallax, 45.2);
assert.ok(sky.formatCatalogueSource(result.sources[0]).includes('G = 14.25'));

// P2-04: CatWISE2020 query sorting (ORDER BY w1mpro ASC), proper-motion conversion (arcsec/yr -> mas/yr), and epoch 2015.4 propagation.
{
  const wiseParams = new URLSearchParams({catalogue:'wise', ra:'133.7', dec:'-7.2', fov:'5'});
  const wiseRes = await searchCatalogue(wiseParams, async (url) => {
    assert.equal(url.hostname, 'irsa.ipac.caltech.edu');
    assert.match(url.searchParams.get('QUERY'), /ORDER BY w1mpro ASC/);
    return new Response('source_name,ra,dec,pmra,pmdec,w1mpro,w2mpro\nJ085510.83-071442.5,133.759765,-7.242186,-8.12,0.67,17.82,14.02\n');
  });
  const s = wiseRes.sources[0];
  assert.equal(s.id, 'J085510.83-071442.5');
  assert.equal(s.catalogue, 'wise');
  assert.equal(s.pmra, -8120);
  assert.equal(s.pmdec, 670);
  assert.equal(s.epoch, 2015.4);
  assert.equal(s.magnitude, 17.82);
  assert.ok(Math.abs(s.colour - 3.8) < 1e-6);
  const formatted = sky.formatCatalogueSource(s);
  assert.ok(formatted.includes('CatWISE2020 J085510.83-071442.5') && formatted.includes('W1 = 17.82') && formatted.includes('8.15″/yr'));
}

const central = {id:'x',ra:fixture.ra0,dec:fixture.dec0,pmra:0,pmdec:3600,epoch:2016};
const origin = sky.cataloguePixel(fixture,central,2016);
assert.ok(Math.abs(origin[0] - fixture.half) < 1e-8 && Math.abs(origin[1] - fixture.half) < 1e-8);
const moved = sky.cataloguePixel(fixture,central,2017);
assert.ok(moved[1] > origin[1]);
assert.ok(Math.abs((moved[1] - origin[1]) - 3.6 / fixture.scale) < 0.2);

// Target proper-motion metadata supports Barnard's Star, Epsilon Indi B, and WISE 0855.
for (const [id, minPmMas] of [['wise0855', 8000], ['barnard', 10000], ['epsindiB', 4000]]) {
  const target = sky.TARGETS.find((t) => t.id === id);
  assert.ok(target && Math.hypot(target.pmra, target.pmdec) > minPmMas, `${id} has high proper motion`);
  assert.equal(sky.findTargetAt(target.ra, target.dec)?.id, id);
  const pos2026 = sky.targetPosition(target, 51544.5 + 26 * 365.25);
  assert.ok(sky.separation(pos2026[0], pos2026[1], target.ra, target.dec) < 0.1, `${id} J2000->2026.0 consistency`);
  const pos2025 = sky.targetPosition(target, 51544.5 + 25 * 365.25);
  assert.ok(sky.separation(pos2025[0], pos2025[1], pos2026[0], pos2026[1]) > 4, `${id} moves across epochs`);
}

// quickSpectrum tracks proper motion of Barnard's Star using target metadata (not just WISE 0855).
{
  const barnard = sky.TARGETS.find((t) => t.id === 'barnard');
  const mjd = 60900;
  const [raNow, decNow] = sky.targetPosition(barnard, mjd);
  const size = 41, half = 20, scale = 6.15;
  const [dxArcsec, dyArcsec] = [
    (raNow - barnard.ra) * Math.cos(barnard.dec * Math.PI / 180) * 3600,
    (decNow - barnard.dec) * 3600,
  ];
  const srcX = half - dxArcsec / scale, srcY = half + dyArcsec / scale;
  const pixels = new Float32Array(size * size).fill(1);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    if (Math.hypot(px - srcX, py - srcY) <= 1.5) pixels[py * size + px] = 100;
  }
  const b64 = Buffer.from(pixels.buffer).toString('base64');
  const testFix = {
    id: 'barnard-pm-test',
    ra0: barnard.ra, dec0: barnard.dec, half, scale,
    dates: ['2025-08-13'], visitSizes: [1],
    headers: [{
      id: 'b1', size, x0: 0, y0: 0, crval: [barnard.ra, barnard.dec], crpix: [half + 1, half + 1],
      cdelt: [-scale / 3600, scale / 3600], pc: [1, 0, 0, 1], a: {}, b: {}, ap: {}, bp: {},
      mjd, wavelength: 4.6, bandwidth: 0.05, productKey: 'dr1/level2/test/6/b.fits',
    }],
    pixels: b64,
  };
  const spec = await sky.quickSpectrum(testFix, new AbortController().signal);
  assert.equal(spec.length, 1);
  assert.ok(spec[0].flux > 0.1, `Barnard aperture photometry tracks moving star (flux=${spec[0].flux})`);
  assert.equal(spec[0].mode, 'aperture');
  assert.equal(spec[0].saturated, false);
  assert.ok(spec[0].error > 0);
}

// P2-01: resolveSpectrumTarget priority (tracked -> selected -> target/field centre)
{
  const resolvedDefault = sky.resolveSpectrumTarget(fixture, 'wise0855', null, null);
  assert.ok(resolvedDefault.label.includes('WISE 0855'));
  assert.equal(resolvedDefault.pmra, -8123.7);
  const resolvedSelected = sky.resolveSpectrumTarget(fixture, 'wise0855', null, {
    ra: 133.9, dec: -7.1, label: 'Selected star', pmra: 120, pmdec: -40, epoch: 2016.0,
  });
  assert.equal(resolvedSelected.label, 'Selected star');
  assert.equal(resolvedSelected.pmra, 120);
  const resolvedTracked = sky.resolveSpectrumTarget(fixture, 'wise0855', {
    start: { ra: 133.9, dec: -7.1, frame: 0 },
    points: [{ frame: 0, ra: 133.9, dec: -7.1, mjd: 60800 }],
    motion: { significant: true, east: -8.1, north: 0.68 },
    id: {
      simbad: { matches: [{ name: 'Tracked SIMBAD', pmra: -8118, pmdec: 680 }] },
      gaia: { matches: [] },
    },
  }, { ra: 133.8, dec: -7.24, label: 'Selected star' });
  assert.equal(resolvedTracked.label, 'Tracked SIMBAD');
  assert.equal(resolvedTracked.pmra, -8118);
}

// P2-01: WISE 0855 visit-tagged spectrum and matched-wavelength visit comparison
{
  const wiseSpec = await sky.quickSpectrum(fixture, new AbortController().signal, sky.resolveSpectrumTarget(fixture, 'wise0855', null, null));
  assert.equal(wiseSpec.length, 45);
  assert.deepEqual([...new Set(wiseSpec.map(p => p.visit))].sort(), [0, 1, 2]);
  assert.ok(wiseSpec.every(p => p.mode === 'aperture' && !p.saturated && p.error > 0));
  const comp = sky.compareSpectrumVisits(wiseSpec, fixture.dates);
  assert.equal(comp.bins.length, 3);
  assert.ok(comp.summary.includes('Matched-wavelength visit medians'));
}

// P2-01: R Draconis saturated-core wing/ring photometry fallback & visit variability
{
  const rdraFix = structuredClone(require('../reference/fixtures/examples/rdra.json').fixture);
  rdraFix.headers.forEach((h, i) => { h.wavelength = 3.9 + (i % 12) * 0.08; h.bandwidth = 0.04; });
  const rdraTarget = sky.resolveSpectrumTarget(rdraFix, 'rdra', null, null);
  const rdraSpec = await sky.quickSpectrum(rdraFix, new AbortController().signal, rdraTarget);
  assert.equal(rdraSpec.length, 34);
  assert.ok(rdraSpec.every(p => p.mode === 'ring' && p.saturated === true && p.flux > 0.9 && p.error > 0));
  const rdraComp = sky.compareSpectrumVisits(rdraSpec, rdraFix.dates);
  assert.equal(rdraComp.bins.length, 3);
  assert.ok(Math.abs(rdraComp.medianDeltaMag) > 0.5, `Expected strong R Dra variability, got Δmag=${rdraComp.medianDeltaMag}`);
}
await assert.rejects(() => searchCatalogue(new URLSearchParams({catalogue:'gaia',ra:'1',dec:'2',fov:'999'}), () => {throw Error('unexpected fetch')}));
console.log('Exposure, wavelength, quality and catalogue checks passed (offline fixtures).');

assert.ok(['python', 'python3'].includes(resolvePython().toLowerCase().replace(/\.exe$/, '')) || Boolean(process.env.SKYSHIFT_PYTHON));
const flagParams = new URLSearchParams({key:'dr1/level2/test.fits',x:'100',y:'50'});
assert.deepEqual(validateQuality(flagParams), {key:'dr1/level2/test.fits',x:100,y:50});
assert.throws(() => validateQuality(new URLSearchParams({key:'../../etc/passwd',x:'1',y:'1'})));
const flagResult = await handleQuality(flagParams, async input => ({...input,combined:2}));
assert.equal(flagResult.combined, 2);

const wavelengths = Array.from({length:102}, (_, i) => 0.75 + i * 0.04);
const props = `hips_cube_depth = 102\ndata_cube_crval3_arr = ${wavelengths.join(' ')}\n`;
const channels = parseChannelProperties(props);
assert.equal(channels.length,102);
assert.equal(channels[50].blank,true); assert.equal(channels[51].blank,true);
assert.equal(channels[16].band,1); assert.equal(channels[17].band,2);
assert.throws(() => parseChannelProperties('hips_cube_depth=102\ndata_cube_crval3_arr=1'));
const channelResponse = await handleChannels(async () => new Response(props));
assert.equal(channelResponse.channels.length, 102);
