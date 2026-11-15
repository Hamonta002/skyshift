import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const sky = require('../dist/archive.cjs');
const worker = require('../dist/worker.cjs');

const fixtures = { wise0855: require('../dist/fixture.json') };
for (const id of ['barnard', 'epsindiB', 'rwaur', 'rdra']) {
  const path = fileURLToPath(new URL(`../reference/fixtures/examples/${id}.json`, import.meta.url));
  if (existsSync(path)) fixtures[id] = JSON.parse(readFileSync(path, 'utf8')).fixture;
}
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

async function analyse(fixture) {
  const { series } = await worker.runRequest({ engine: 'typescript', scenario: 'wise0855', cache: 'none', fixture, wasm: '', frameMode: 'visits' }, () => {});
  let offset = 0;
  const mjds = fixture.visitSizes.map((size) => {
    const values = fixture.headers.slice(offset, offset + size).map((h) => h.mjd).filter(Number.isFinite); offset += size;
    return values.reduce((a, b) => a + b, 0) / values.length;
  });
  const full = series.counts.map((c, i) => (c >= 5 ? i : -1)).filter((i) => i >= 0);
  const [a, b] = full.slice(-2);
  const track = sky.trackSource(series.frames, series.side, b, fixture.half, fixture.half, fixture, mjds);
  return { series, a, b, track, motion: sky.fitMotion(track), light: sky.brightness(track, series.frames.length),
    movers: sky.findMovers(series.frames, series.side, mjds, series.counts) };
}

// gridToSky inverts fieldPixel.
const wise = fixtures.wise0855;
for (const [x, y] of [[0, 0], [20, 20], [33.4, 7.9]]) {
  const [ra, dec] = sky.gridToSky(wise, x, y);
  const [px, py] = sky.fieldPixel(wise, ra, dec);
  assert.ok(Math.abs(px - x) < 1e-6 && Math.abs(py - y) < 1e-6, `grid round trip ${x},${y}`);
}

// Real data: catalogue proper motions (SIMBAD) for the moving targets.
const expected = {
  wise0855: { total: 8.15, angle: 274.7, moving: true, variable: false },
  barnard: { total: 10.39, angle: 355.6, moving: true },
  epsindiB: { total: 4.68, angle: 121.8, moving: true },
  rwaur: { moving: false, variable: true },
  rdra: { moving: false, saturated: true },
};
for (const [id, fixture] of Object.entries(fixtures)) {
  const result = await analyse(fixture), want = expected[id];
  assert.ok(result.track && result.track.length === result.series.frames.length, `${id}: tracked in every visit`);
  assert.equal(result.motion.significant, want.moving, `${id}: moving = ${want.moving} (${result.motion.total.toFixed(2)}″/yr)`);
  if (want.moving) {
    assert.ok(Math.abs(result.motion.total - want.total) <= Math.max(3 * result.motion.error, 0.25 * want.total), `${id}: speed ${result.motion.total.toFixed(2)} vs ${want.total}`);
    assert.ok(angleDiff(result.motion.angle, want.angle) <= 25, `${id}: direction ${result.motion.angle.toFixed(0)}° vs ${want.angle}°`);
  }
  if (want.variable !== undefined) assert.equal(result.light.variable, want.variable, `${id}: variable = ${want.variable}`);
  if (want.saturated) {
    assert.ok(result.track.every((p) => p.saturated), `${id}: saturated core detected`);
    assert.ok(result.track.every((p) => Math.hypot(p.x - fixture.half, p.y - fixture.half) < 1.5), `${id}: position from the masked core`);
  }
  // The mover finder reports the target and nothing else in these fields.
  const atTarget = (c) => Math.hypot(c.x - fixture.half, c.y - fixture.half) < 3;
  const movers = result.movers.filter((c) => c.kind === 'mover');
  assert.ok(result.movers.every(atTarget), `${id}: no false candidates (${result.movers.map((c) => `${c.kind} at ${(c.x - fixture.half).toFixed(0)},${(c.y - fixture.half).toFixed(0)}`).join('; ')})`);
  if (want.moving) {
    assert.equal(movers.length, 1, `${id}: one mover`);
    const speed = movers[0].speed * fixture.scale;
    assert.ok(Math.abs(speed - want.total) <= 0.25 * want.total, `${id}: finder speed ${speed.toFixed(2)} vs ${want.total}`);
    assert.ok(movers[0].frames[0] < movers[0].frames[1] && movers[0].shift > 1, `${id}: shown across two visits`);
  } else assert.equal(movers.length, 0, `${id}: no movers`);
  if (id === 'rwaur') assert.ok(result.movers.some((c) => c.kind === 'brighter' && atTarget(c)), 'rwaur: brightness change found');
  if (id === 'rdra') assert.ok(result.movers.some((c) => c.kind === 'fainter' && c.saturated && atTarget(c)), 'rdra: fading found from the masked core');
  console.log(`${id}: ${result.motion.total.toFixed(2)} ± ${result.motion.error.toFixed(2)}″/yr at ${result.motion.angle.toFixed(0)}°, variable ${result.light.variable}, ${result.movers.filter((m) => m.kind === 'mover').length} mover candidate(s)`);
}

// Synthetic: three visits half a year apart with noise and a field of stars.
{
  const side = 81, mjds = [60000, 60182.6, 60365.25], counts = [10, 10, 10];
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const gauss = () => random() + random() + random() + random() - 2;
  const field = Array.from({ length: 30 }, () => [8 + random() * 65, 8 + random() * 65, 2 + random() * 20]);
  const frame = (extra) => {
    const pixels = Float32Array.from({ length: side * side }, () => 0.05 * gauss());
    for (const [cx, cy, amp] of [...field, ...extra]) for (let y = Math.max(0, Math.floor(cy - 6)); y <= Math.min(side - 1, cy + 6); y++)
      for (let x = Math.max(0, Math.floor(cx - 6)); x <= Math.min(side - 1, cx + 6); x++) pixels[y * side + x] += amp * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / 1.5);
    return pixels;
  };
  const moving = [0, 1, 2].map((i) => frame([[40 + 1.5 * i, 40, 6]]));
  const found = sky.findMovers(moving, side, mjds, counts);
  assert.equal(found.length, 1, `synthetic mover: ${found.map((c) => c.kind)}`);
  assert.equal(found[0].kind, 'mover');
  assert.ok(Math.abs(found[0].speed - 3) < 0.3, `synthetic speed ${found[0].speed}`);
  assert.deepEqual(found[0].frames, [0, 2]);
  assert.ok(Math.abs(found[0].shift - 3) < 0.3, `synthetic shift ${found[0].shift}`);
  const brightening = [6, 6, 12].map((amp) => frame([[40, 40, amp]]));
  const changed = sky.findMovers(brightening, side, mjds, counts);
  assert.ok(changed.length === 1 && changed[0].kind === 'brighter' && !changed[0].single, `synthetic brightening: ${changed.map((c) => c.kind)}`);
  assert.ok(Math.abs(changed[0].change + 0.75) < 0.15, `brightening of ${changed[0].change} mag`);
  assert.equal(sky.findMovers([0, 1, 2].map(() => frame([])), side, mjds, counts).length, 0, 'a still field has no candidates');
  const appearing = [frame([]), frame([]), frame([[40, 40, 6]])];
  const fresh = sky.findMovers(appearing, side, mjds, counts);
  assert.ok(fresh.length === 1 && fresh[0].kind === 'brighter' && fresh[0].single, `synthetic new source: ${fresh.map((c) => c.kind)}`);
}

// Tracking can follow a larger jump after it learns the velocity or gets a proper-motion hint.
{
  const side = 41, star = (cx, cy, amp) => Float32Array.from({ length: side * side }, (_, i) => {
    const x = i % side, y = Math.floor(i / side);
    return amp * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / 2) + 0.01 * Math.sin(i * 12.9898);
  });
  const testField = { ra0: 180, dec0: 0, half: 20, scale: 6.15 };
  const frames3 = [star(20, 20, 15), star(22.5, 20, 18), star(28.0, 20, 24)];
  const mjds3 = [60000, 60182.625, 60584.4]; // 0.5 yr then 1.1 yr (5.5 px jump between frame 1 and 2 > 3.5 px)
  const trackedExtrap = sky.trackSource(frames3, side, 0, 20, 20, testField, mjds3);
  assert.equal(trackedExtrap.length, 3, '2-visit MJD linear extrapolation tracks across 5.5 px inter-visit jump');
  assert.deepEqual(trackedExtrap.map((p) => p.mjd), mjds3);
  const lc = sky.brightness(trackedExtrap, 3);
  assert.equal(lc.deltaMag.filter((m) => m !== null).length, 3);
  assert.ok(lc.deltaMag[2] < lc.deltaMag[0], 'brighter frame 2 has more negative deltaMag');

  // Direct jump of 5.5 px from start frame 0 -> 1 using motionHint.
  const frames2 = [star(20, 20, 15), star(25.5, 20, 15)];
  const mjds2 = [60000, 60365.25]; // 1 year, 5.5 px west = -5.5 * 6.15 * 1000 mas/yr east
  const trackedHint = sky.trackSource(frames2, side, 0, 20, 20, testField, mjds2, { pmra: -5.5 * 6150, pmdec: 0 });
  assert.equal(trackedHint.length, 2, 'motionHint tracks 5.5 px jump from first visit');
}

// Deep stack and colour-band cropping.
assert.deepEqual(Array.from(sky.deepStack([new Float32Array([1, NaN]), new Float32Array([3, 5]), new Float32Array([2, NaN])])), [2, 5]);
assert.deepEqual(Array.from(sky.cropGrid(Float32Array.from({ length: 25 }, (_, i) => i), 5, 3)), [6, 7, 8, 11, 12, 13, 16, 17, 18]);
assert.throws(() => sky.cropGrid(new Float32Array(16), 4, 3));

// Verdicts from catalogue matches and measured behaviour.
const point = (frame, mjd) => ({ frame, x: 20, y: 20, ra: 1, dec: 1, flux: 1, snr: 50, peak: 20, height: 1, mjd });
const track3 = [point(0, 60800), point(1, 61000), point(2, 61200)];
const still = { east: 0, north: 0, total: 0.1, error: 0.2, angle: 0, significant: false, spanYears: 1, points: 3, residual: 0 };
const moving = { ...still, east: -8, north: 1, total: 8.1, error: 0.6, angle: 275, significant: true };
const flat = { deltaMag: [0, 0, 0], amplitude: 0, variable: false, chi2: 0 };
const none = { simbad: { status: 'ok', matches: [] }, gaia: { status: 'ok', matches: [] }, skybot: { status: 'ok', matches: [] } };
const bd = { name: 'WISEA J085510.74-071442.5', type: 'BD*', description: 'Brown Dwarf', separation: 1.2, pmra: -8123.7, pmdec: 673.2, parallax: 438, spectralType: 'Y4' };
let verdict = sky.classifyObject(track3, 3, moving, flat, { ...none, simbad: { status: 'ok', matches: [bd] } });
assert.equal(verdict.label, 'Brown Dwarf: WISEA J085510.74-071442.5');
assert.equal(verdict.tone, 'known');
assert.ok(verdict.reasons.some((r) => /agrees with the catalogue/.test(r)), verdict.reasons.join(' | '));
verdict = sky.classifyObject(track3, 3, moving, flat, none);
assert.equal(verdict.tone, 'candidate'); assert.match(verdict.label, /Unidentified moving source/);
verdict = sky.classifyObject([point(1, 61000)], 3, null, flat, { ...none, skybot: { status: 'ok', matches: [{ name: '2014 XY59', number: null, kind: 'MB>Inner', magnitude: 22.7, separation: 12, mjd: 61000 }] } });
assert.match(verdict.label, /Known solar-system object: 2014 XY59/);
verdict = sky.classifyObject(track3, 3, still, flat, { ...none, gaia: { status: 'ok', matches: [{ name: '123', type: 'star', description: 'Gaia DR3 source', separation: 0.4, pmra: 1, pmdec: 1, parallax: 10, magnitude: 14.2 }] } });
assert.equal(verdict.label, 'Star (Gaia DR3 source)'); assert.ok(verdict.reasons.some((r) => /100 pc/.test(r)));
verdict = sky.classifyObject(track3, 3, still, flat, null);
assert.equal(verdict.tone, 'neutral');
// Before (or without) a catalogue check, a mover is described, not called unidentified.
verdict = sky.classifyObject(track3, 3, moving, flat, null);
assert.deepEqual([verdict.label, verdict.tone], ['Moving source', 'neutral']);
// A planet sharing its host star's position does not win over the star.
const planet = { ...bd, name: "Barnard's Star b", type: 'Pl', description: 'Extra-solar Planet' };
verdict = sky.classifyObject(track3, 3, still, flat, { ...none, simbad: { status: 'ok', matches: [planet, { ...bd, name: "Barnard's star", type: 'BY*', description: 'BY Dra Variable' }] } });
assert.equal(verdict.label, "BY Dra Variable: Barnard's star");

console.log(`Tracking, motion, mover and verdict checks passed (${Object.keys(fixtures).length} real fields).`);
