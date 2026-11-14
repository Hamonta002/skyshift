import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseCsv, searchCatalogue } from './catalogue.mjs';
import { validateQuality, handleQuality } from './quality.mjs';
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
  return new Response('source_id,ra,dec,pmra,pmdec\n1234567890123456789,133.7,-7.2,-10.5,0\n');
});
assert.equal(result.sources[0].id, '1234567890123456789');
assert.equal(result.sources[0].pmdec, 0);
const central = {id:'x',ra:fixture.ra0,dec:fixture.dec0,pmra:0,pmdec:3600,epoch:2016};
const origin = sky.cataloguePixel(fixture,central,2016);
assert.ok(Math.abs(origin[0] - fixture.half) < 1e-8 && Math.abs(origin[1] - fixture.half) < 1e-8);
const moved = sky.cataloguePixel(fixture,central,2017);
assert.ok(moved[1] > origin[1]);
assert.ok(Math.abs((moved[1] - origin[1]) - 3.6 / fixture.scale) < 0.2);
await assert.rejects(() => searchCatalogue(new URLSearchParams({catalogue:'gaia',ra:'1',dec:'2',fov:'999'}), () => {throw Error('unexpected fetch')}));
console.log('Exposure, wavelength, quality and catalogue checks passed (offline fixtures).');

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
