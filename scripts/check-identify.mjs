import assert from 'node:assert/strict';
import { identify, parseIdentify, parseSkybot, propagate, rankMatches, separationArcsec } from './identify.mjs';

// Barnard's Star: SIMBAD J2000 position, 10.36″/yr north. By 2026 it is ~4′ away.
const barnard = { ra: 269.4520769586187, dec: 4.693364966576667, pmra: -801.551, pmdec: 10362.394 };
const [ra26, dec26] = propagate(barnard.ra, barnard.dec, barnard.pmra, barnard.pmdec, 2000, 2026.25);
assert.ok(separationArcsec(barnard.ra, barnard.dec, ra26, dec26) > 250, 'propagation moves the star');
const mjd = 51544.5 + 26.25 * 365.25;

const simbadCsv = `main_id,otype,description,ra,dec,pmra,pmdec,plx_value,sp_type,refs
"NAME Barnard's Star b","Pl","Extra-solar Planet",${barnard.ra},${barnard.dec},${barnard.pmra},${barnard.pmdec},546.9759,,34
"NAME Barnard's star","BY*","BY Dra Variable",${barnard.ra},${barnard.dec},${barnard.pmra},${barnard.pmdec},546.9759,"M4V",924
"HD 999","*","Star",${ra26 + 0.01},${dec26},,,,,5
`;
const gaiaCsv = `source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag,bp_rp
4472832130942575872,269.44850252543836,4.739420051112412,-801.551,10362.394,546.97,8.19,2.83
`;
const skybotText = `# Flag: 1
# Ticket: 1
# Num | Name | RA(h) | DE(deg) | Class | Mv | Err(arcsec) | d(arcsec) | dRA(arcsec/h) | dDEC(arcsec/h) | Dg(ua) | Dh(ua)
 - | 2014 XY59 | 08 55 9.8093 | -07 05 10.585 | MB>Inner | 22.7 | 0.014 | 564.296 | 42.0626 | -15.287 | 1.35 | 1.79
 447827 | 2007 TW334 | 08 55 18.7730 | -06 55 13.296 | MB>Middle | 21.6 | 0.017 | 12.5 | 18.07 | -32.04 | 2.18 | 2.54
`;
const calls = [];
const fetcher = async (url) => {
  calls.push(url.host);
  if (url.host === 'simbad.cds.unistra.fr') return new Response('<!doctype html><title>Page unavailable</title>', { status: 200 });
  if (url.host === 'simbad.harvard.edu') return new Response(simbadCsv);
  if (url.host === 'gea.esac.esa.int') return new Response(gaiaCsv);
  if (url.host === 'ssp.imcce.fr') return new Response(null, { status: 204 });
  throw new Error(`unexpected host ${url.host}`);
};
const result = await identify(new URLSearchParams({ ra: String(ra26), dec: String(dec26), mjd: String(mjd), radius: '8' }), fetcher);
assert.equal(result.simbad.status, 'ok');
assert.ok(calls.includes('simbad.cds.unistra.fr') && calls.includes('simbad.harvard.edu'), 'falls back to the SIMBAD mirror');
assert.equal(result.simbad.matches[0].name, "Barnard's star", 'host star ranks above its planet');
assert.equal(result.simbad.matches[0].description, 'BY Dra Variable');
assert.ok(result.simbad.matches[0].separation < 1, `propagated match ${result.simbad.matches[0].separation}″`);
assert.ok(!result.simbad.matches.some((m) => m.name === 'HD 999'), 'unrelated star outside the radius is dropped');
assert.equal(result.gaia.matches[0].magnitude, 8.19);
assert.ok(result.gaia.matches[0].separation < 2, 'Gaia position propagated from 2016');
assert.deepEqual(result.skybot, { status: 'ok', matches: [] });

// One service failing does not hide the others.
const partial = await identify(new URLSearchParams({ ra: String(ra26), dec: String(dec26), mjd: String(mjd) }), async (url) => {
  if (url.host.startsWith('simbad')) throw new TypeError('fetch failed');
  return fetcher(url);
});
assert.match(partial.simbad.status, /SIMBAD is unavailable/);
assert.equal(partial.gaia.status, 'ok');

// Unresolvable components: the most-studied entry (the system) leads.
const rw = rankMatches([{ name: 'RW Aur B', type: 'Or*', separation: 0.4, refs: 60 }, { name: 'RW Aur', type: 'TT*', separation: 0.6, refs: 700 },
  { name: 'Field star', type: '*', separation: 6.5, refs: 900 }]);
assert.deepEqual(rw.map((m) => m.name), ['RW Aur', 'RW Aur B', 'Field star']);

// SkyBoT text parsing and nearest-first ordering.
const ssos = parseSkybot(skybotText, 61000);
assert.equal(ssos.length, 2);
assert.deepEqual(ssos[1], { number: '447827', name: '2007 TW334', kind: 'MB>Middle', magnitude: 21.6, separation: 12.5, mjd: 61000 });
assert.deepEqual(parseSkybot('# Flag: 0\n', 61000), []);
assert.throws(() => parseSkybot('<html>', 61000));

// Input validation happens before any network call.
for (const bad of [{ ra: '400', dec: '0', mjd: '61000' }, { ra: '1', dec: '0' }, { ra: '1', dec: '0', mjd: '61000', radius: '99' },
  { ra: '1', dec: '0', mjd: '61000', epochs: '61000,61001,61002,61003,61004' }]) {
  assert.throws(() => parseIdentify(new URLSearchParams(bad)), undefined, JSON.stringify(bad));
}
console.log('Identification checks passed (SIMBAD fallback, proper-motion propagation, Gaia, SkyBoT; mocked services).');
