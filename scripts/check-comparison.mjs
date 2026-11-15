import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolvePython } from './quality.mjs';

const require = createRequire(import.meta.url);
const sky = require('../dist/archive.cjs');
const fixture = require('../dist/fixture.json');

// 1. Unit tests: fluxRatio, magnitudeDifference, weightedMean, contaminationNames
{
  const r = sky.fluxRatio(10, 0.5, 5, 0.25);
  assert.ok(Math.abs(r.value - 2.0) < 1e-12);
  const expectedErr = Math.sqrt((0.5 / 5) ** 2 + (10 * 0.25 / 25) ** 2);
  assert.ok(Math.abs(r.error - expectedErr) < 1e-12);

  assert.equal(sky.fluxRatio(null, 0.1, 5, 0.1), null, 'null flux returns null, never 0');
  assert.equal(sky.fluxRatio(1, 0.1, 0, 0.1), null, 'zero reference flux returns null');
  assert.equal(sky.fluxRatio(1, NaN, 5, 0.1), null, 'NaN error returns null');

  const dm = sky.magnitudeDifference({ value: 4, error: 0.04 }, { value: 1, error: 0.01 });
  assert.ok(Math.abs(dm.value - (-2.5 * Math.log10(4))) < 1e-12);
  assert.ok(dm.error > 0);
  assert.equal(sky.magnitudeDifference({ value: -1, error: 0.1 }, { value: 1, error: 0.1 }), null);

  const wm = sky.weightedMean([
    { value: 2.0, error: 0.1 },
    { value: 2.0, error: 0.1 },
  ]);
  assert.ok(Math.abs(wm.value - 2.0) < 1e-12);
  assert.ok(Math.abs(wm.error - 0.1 / Math.SQRT2) < 1e-12);

  // Scatter-dominated error exceeds formal error when points disagree beyond uncertainties.
  const wmScatter = sky.weightedMean([
    { value: 1.0, error: 0.01 },
    { value: 2.0, error: 0.01 },
    { value: 3.0, error: 0.01 },
  ]);
  assert.ok(wmScatter.error > 0.5, `Expected scatter-inflated error, got ${wmScatter.error}`);

  // SOURCE bit (21) should NOT count as contamination; HOT (10) & OVERFLOW (1) SHOULD.
  assert.deepEqual(sky.contaminationNames(1 << 21), []);
  assert.deepEqual(sky.contaminationNames((1 << 21) | (1 << 1) | (1 << 10)), ['OVERFLOW', 'HOT']);
}

// Helper to create synthetic exposures with controlled sources, sky, saturation, and PM
function makeSyntheticExposure({
  id = 's0',
  mjd = 60800,
  wavelength = 4.5,
  bandwidth = 0.05,
  ra0 = 180.0,
  dec0 = 0.0,
  size = 61,
  scale = 6.15,
  skyLevel = 1.0,
  noiseSigma = 0.2,
  stars = [], // { ra, dec, peak, saturateCore?: boolean }
}) {
  const half = Math.floor(size / 2);
  const header = {
    id, size, x0: 0, y0: 0,
    crval: [ra0, dec0], crpix: [half + 1, half + 1],
    cdelt: [-scale / 3600, scale / 3600], pc: [1, 0, 0, 1],
    a: {}, b: {}, ap: {}, bp: {},
    mjd, wavelength, bandwidth, productKey: `dr1/level2/test/6/${id}.fits`,
  };
  const pixels = new Float32Array(size * size);
  // Deterministic pseudo-random sky noise (continuous values so MAD > 0 cleanly).
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const h = Math.sin((px + 1) * 12.9898 + (py + 1) * 78.233) * 43758.5453;
      const frac = (h - Math.floor(h)) * 2 - 1; // [-1, 1]
      pixels[py * size + px] = skyLevel + frac * noiseSigma * 1.732;
    }
  }
  const cosd = Math.cos(dec0 * Math.PI / 180);
  for (const star of stars) {
    const dxArcsec = (star.ra - ra0) * cosd * 3600;
    const dyArcsec = (star.dec - dec0) * 3600;
    const sx = half - dxArcsec / scale;
    const sy = half + dyArcsec / scale;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const r = Math.hypot(px - sx, py - sy);
        if (r <= 6.5) {
          if (star.saturateCore && r <= 2.2) {
            pixels[py * size + px] = NaN;
          } else {
            pixels[py * size + px] += star.peak * Math.exp(-0.5 * (r / 1.4) ** 2);
          }
        }
      }
    }
  }
  return { header, pixels };
}

function packSyntheticFixture(id, ra0, dec0, dates, visitSizes, exposures) {
  const size = exposures[0].header.size;
  const half = Math.floor(size / 2);
  const totalBytes = exposures.reduce((s, e) => s + e.pixels.byteLength, 0);
  const bytes = new Uint8Array(totalBytes);
  const view = new DataView(bytes.buffer);
  let cursor = 0;
  for (const e of exposures) {
    for (const v of e.pixels) { view.setFloat32(cursor, v, true); cursor += 4; }
  }
  return {
    id, ra0, dec0, half, scale: 6.15,
    dates, visitSizes,
    headers: exposures.map((e) => e.header),
    pixels: Buffer.from(bytes).toString('base64'),
  };
}

// 2. Proper-motion-aware aperture positioning + common-mode drift cancellation vs true variability
{
  const ra0 = 269.446269, dec0 = 4.768204; // Barnard-like coordinates
  const cosd = Math.cos(dec0 * Math.PI / 180);
  // Target moves +10.0"/yr north (pmdec = +10000 mas/yr); ref sits 120" east.
  const targetStar = { label: 'Moving Target', ra: ra0, dec: dec0, pmra: 0, pmdec: 10000, epoch: 2025.0 };
  const refRa = ra0 + (120 / 3600) / cosd, refDec = dec0;
  const refStar = { label: 'Steady Reference', ra: refRa, dec: refDec, pmra: 0, pmdec: 0, epoch: 2025.0 };

  const mjds = [60700, 60700.1, 60700.2, 60700.3, 61065.25, 61065.35, 61065.45, 61065.55];
  // First test: Constant ratio despite 1.4x throughput drift in Visit 2 (both stars scale together).
  const constExposures = mjds.map((mjd, i) => {
    const yr = sky.mjdToJulianYear(mjd);
    const tDec = dec0 + (yr - 2025.0) * 10000 / 3600000;
    const throughput = i < 4 ? 1.0 : 1.4;
    return makeSyntheticExposure({
      id: `c${i}`, mjd, ra0, dec0,
      wavelength: 4.45 + (i % 4) * 0.03,
      stars: [
        { ra: ra0, dec: tDec, peak: 50 * throughput },
        { ra: refRa, dec: refDec, peak: 25 * throughput },
      ],
    });
  });
  const constFix = packSyntheticFixture('pm-const', ra0, dec0, ['2025-01-25', '2026-01-25'], [4, 4], constExposures);
  const tMeas = await sky.measureStarSeries(constFix, targetStar, new AbortController().signal);
  const rMeas = await sky.measureStarSeries(constFix, refStar, new AbortController().signal);
  assert.equal(tMeas.length, 8);
  assert.ok(tMeas.every((m) => m.status === 'measured' && m.flux > 0), 'PM tracking finds target in every epoch');
  // Verify proper motion shifted dec between visits by ~10"
  assert.ok(Math.abs((tMeas[4].dec - tMeas[0].dec) * 3600 - 10.0) < 0.05);

  const compConst = sky.compareStars(tMeas, rMeas, constFix.dates, 120);
  assert.equal(compConst.verdict, 'constant', `Common-mode drift should cancel out: ${compConst.verdictText}`);
  assert.equal(compConst.usablePairs, 8);

  // Second test: True variability (Target dims by 0.5 mag in Visit 2 while Reference stays steady).
  const varExposures = mjds.map((mjd, i) => {
    const yr = sky.mjdToJulianYear(mjd);
    const tDec = dec0 + (yr - 2025.0) * 10000 / 3600000;
    const targetScale = i < 4 ? 1.0 : 0.631; // -2.5*log10(0.631) ≈ +0.50 mag fainter
    return makeSyntheticExposure({
      id: `v${i}`, mjd, ra0, dec0,
      wavelength: 4.45 + (i % 4) * 0.03,
      stars: [
        { ra: ra0, dec: tDec, peak: 50 * targetScale },
        { ra: refRa, dec: refDec, peak: 25 },
      ],
    });
  });
  const varFix = packSyntheticFixture('pm-var', ra0, dec0, ['2025-01-25', '2026-01-25'], [4, 4], varExposures);
  const compVar = sky.compareStars(
    await sky.measureStarSeries(varFix, targetStar, new AbortController().signal),
    await sky.measureStarSeries(varFix, refStar, new AbortController().signal),
    varFix.dates, 120,
  );
  assert.equal(compVar.verdict, 'variable', `Expected variable verdict, got ${compVar.verdict}: ${compVar.verdictText}`);
  assert.ok(Math.abs(compVar.amplitudeMag - 0.5) < 0.05, `Expected ~0.50 mag variation, got ${compVar.amplitudeMag}`);
}

// 3. Missing, edge, saturated, contaminated, and unmatched-wavelength handling
{
  const ra0 = 100.0, dec0 = 10.0;
  const cosd = Math.cos(dec0 * Math.PI / 180);
  const refRa = ra0 + (120 / 3600) / cosd;
  const target = { label: 'T', ra: ra0, dec: dec0 };
  const ref = { label: 'R', ra: refRa, dec: dec0 };

  const exps = [
    // Exposure 0: both clean
    makeSyntheticExposure({ id: 'e0', mjd: 60800, ra0, dec0, stars: [{ ra: ra0, dec: dec0, peak: 40 }, { ra: refRa, dec: dec0, peak: 20 }] }),
    // Exposure 1: target core saturated (blanked), ref clean -> mismatch mode rejected
    makeSyntheticExposure({ id: 'e1', mjd: 60800.1, ra0, dec0, stars: [{ ra: ra0, dec: dec0, peak: 400, saturateCore: true }, { ra: refRa, dec: dec0, peak: 20 }] }),
    // Exposure 2: contaminated exposure (will be given HOT flag on target)
    makeSyntheticExposure({ id: 'e2', mjd: 60800.2, ra0, dec0, stars: [{ ra: ra0, dec: dec0, peak: 40 }, { ra: refRa, dec: dec0, peak: 20 }] }),
    // Exposure 3: clean but second visit
    makeSyntheticExposure({ id: 'e3', mjd: 60900.0, ra0, dec0, stars: [{ ra: ra0, dec: dec0, peak: 40 }, { ra: refRa, dec: dec0, peak: 20 }] }),
  ];
  // Exposure 4: edge star (reference placed outside image)
  const fix = packSyntheticFixture('edge-test', ra0, dec0, ['2025-05-05', '2025-08-13'], [3, 1], exps);
  const tM = await sky.measureStarSeries(fix, target, new AbortController().signal);
  const rM = await sky.measureStarSeries(fix, ref, new AbortController().signal);
  const offM = await sky.measureStarSeries(fix, { label: 'Off', ra: ra0 + 1.0, dec: dec0 }, new AbortController().signal);

  assert.equal(offM[0].status, 'edge');
  assert.equal(offM[0].flux, null, 'Off-image measurement must be null, never 0');
  assert.equal(tM[1].status, 'estimate', 'Saturated core should produce wing estimate');

  // Mark exposure 2 contaminated (HOT bit 10) and exposure 0 with benign SOURCE bit (21)
  tM[0].flags = 1 << 21;
  tM[2].flags = (1 << 21) | (1 << 10);

  const comp = sky.compareStars(tM, rM, fix.dates, 120);
  assert.equal(comp.pairs[0].usable, true, 'Benign SOURCE flag must be allowed');
  assert.equal(comp.pairs[1].usable, false, 'Saturated target vs clean ref must not mix');
  assert.match(comp.pairs[1].reason, /saturated/);
  assert.equal(comp.pairs[2].usable, false, 'HOT contamination flag must reject pair');
  assert.match(comp.pairs[2].reason, /HOT/);
  assert.equal(comp.pairs[3].usable, true);

  // Unsuitable reference checks: overlapping apertures (< 31") & saturated reference (> 50%)
  const compOverlap = sky.compareStars(tM, rM, fix.dates, 20);
  assert.equal(compOverlap.assessment.suitable, false);
  assert.equal(compOverlap.verdict, 'unsuitable-reference');
  assert.match(compOverlap.assessment.reasons[0], /overlap/i);

  const satRef = rM.map((m) => ({ ...m, status: 'estimate' }));
  const compSatRef = sky.compareStars(tM.map((m) => ({ ...m, status: 'estimate' })), satRef, fix.dates, 120);
  assert.equal(compSatRef.assessment.suitable, false);
  assert.match(compSatRef.assessment.reasons[0], /saturated/i);

  // Wavelength mismatch exclusion test: target at 4.40 um, ref at 4.60 um with 0.04 um bandwidth
  const waveT = tM.map((m) => ({ ...m, status: 'measured', flags: 0, wavelength: 4.40, bandwidth: 0.04 }));
  const waveR = rM.map((m) => ({ ...m, status: 'measured', flags: 0, wavelength: 4.60, bandwidth: 0.04 }));
  const compWave = sky.compareStars(waveT, waveR, fix.dates, 120);
  assert.equal(compWave.usablePairs, 0);
  assert.ok(compWave.pairs.every((p) => p.reason.startsWith('wavelength mismatch')));
}

// 4. Numerical validation against reference/measure_frames.py photometry formulas (Python)
{
  const wiseTarget = sky.resolveSpectrumTarget(fixture, 'wise0855', null, null);
  const wiseSeries = await sky.measureStarSeries(fixture, wiseTarget, new AbortController().signal);
  assert.equal(wiseSeries.length, 45);
  assert.ok(wiseSeries.every((m) => m.status === 'measured' && Number.isFinite(m.flux) && m.error > 0));
  assert.ok(wiseSeries.filter((m) => m.flux > 0).length >= 40);

  const rdraFix = structuredClone(require('../reference/fixtures/examples/rdra.json').fixture);
  // R Dra has real pixels but no bundled wavelength metadata. This check
  // compares the aperture measurements, which do not depend on wavelength.
  for (const header of rdraFix.headers) {
    header.wavelength = 4.1;
    header.bandwidth = 0.04;
  }
  const rdraTarget = sky.resolveSpectrumTarget(rdraFix, 'rdra', null, null);
  const rdraSeries = await sky.measureStarSeries(rdraFix, rdraTarget, new AbortController().signal);
  assert.ok(rdraSeries.some((m) => m.status === 'estimate'), 'R Dra contains saturated wing estimates');

  // Run reference Python photometry equations directly on decoded pixels of exposure 0 (WISE 0855) & exposure 0 (R Dra)
  const pyCode = `
import base64, json, math, sys
import struct
from statistics import median

OMEGA_SR = 37.86 * (math.pi / 648000.0) ** 2

def measure_py(pixels, size, cx, cy):
    samples = [(i % size, i // size, value) for i, value in enumerate(pixels)]

    def at(x, y, inner, outer):
        return [(sx, sy, value) for sx, sy, value in samples if inner < math.hypot(sx - x, sy - y) <= outer]

    sky = [value for x, y, value in samples if 8 < math.hypot(x - cx, y - cy) < 14 and math.isfinite(value)]
    bg = median(sky)
    sig = max(1.4826 * median(abs(value - bg) for value in sky), 1e-9)
    core = at(cx, cy, -1, 2.5)
    if all(math.isfinite(v) for _, _, v in core):
        mx, my = cx, cy
        for _ in range(8):
            weights = [(x, y, v - bg) for x, y, v in at(mx, my, -1, 2.5) if math.isfinite(v) and v > bg]
            total_weight = sum(w for _, _, w in weights)
            if total_weight <= 0:
                break
            mx = sum(x * w for x, _, w in weights) / total_weight
            my = sum(y * w for _, y, w in weights) / total_weight
        values = [v - bg for _, _, v in at(mx, my, -1, 2.5) if math.isfinite(v)]
        return dict(mode="measured", flux=sum(values) * 1e6 * OMEGA_SR, err=sig * math.sqrt(len(values)) * 1e6 * OMEGA_SR)
    wing = at(cx, cy, 3, 6)
    values = [v - bg for _, _, v in wing if math.isfinite(v)]
    return dict(mode="estimate", flux=sum(values) / len(values) * len(wing) * 1e6 * OMEGA_SR, err=sig * math.sqrt(len(wing)) * 1e6 * OMEGA_SR)

payload = json.loads(sys.stdin.read())
out = []
for item in payload:
    raw = struct.unpack(f'<{item["size"] ** 2}f', base64.b64decode(item["pixels"]))
    out.append(measure_py(raw, item["size"], item["cx"], item["cy"]))
print(json.dumps(out))
`;
  const wiseDecoded = sky.decodeFixture(fixture);
  const wiseIdx = wiseSeries.findIndex((m) => m.snr !== null && m.snr >= 5);
  assert.ok(wiseIdx >= 0, 'Expected at least one WISE 0855 exposure with S/N >= 5');
  const wiseEx = wiseDecoded[wiseIdx];
  const [wRa0, wDec0] = sky.exposureSkyPosition(wiseTarget, wiseEx.header.mjd);
  const [wx, wy] = sky.worldToPixel(wiseEx.wcs, wRa0, wDec0);

  const rdraDecoded = sky.decodeFixture(rdraFix);
  const rdraEx0 = rdraDecoded[0];
  const [rRa0, rDec0] = sky.exposureSkyPosition(rdraTarget, rdraEx0.header.mjd);
  const [rx, ry] = sky.worldToPixel(rdraEx0.wcs, rRa0, rDec0);

  const pyInput = [
    { pixels: Buffer.from(wiseEx.pixels.buffer, wiseEx.pixels.byteOffset, wiseEx.pixels.byteLength).toString('base64'), size: wiseEx.header.size, cx: wx - wiseEx.header.x0, cy: wy - wiseEx.header.y0 },
    { pixels: Buffer.from(rdraEx0.pixels.buffer, rdraEx0.pixels.byteOffset, rdraEx0.pixels.byteLength).toString('base64'), size: rdraEx0.header.size, cx: rx - rdraEx0.header.x0, cy: ry - rdraEx0.header.y0 },
  ];
  const pyRes = spawnSync(resolvePython(), ['-c', pyCode], { input: JSON.stringify(pyInput), encoding: 'utf8' });
  assert.equal(pyRes.status, 0, `Python reference check failed: ${pyRes.stderr}`);
  const pyOut = JSON.parse(pyRes.stdout);

  const jsWise = wiseSeries[wiseIdx];
  assert.ok(Math.abs(jsWise.flux - pyOut[0].flux) / pyOut[0].flux < 1e-6, `WISE 0855 flux mismatch: JS=${jsWise.flux} vs Py=${pyOut[0].flux}`);
  assert.ok(Math.abs(jsWise.error - pyOut[0].err) / pyOut[0].err < 1e-6, `WISE 0855 err mismatch: JS=${jsWise.error} vs Py=${pyOut[0].err}`);

  const jsRdra0 = rdraSeries[0];
  assert.equal(jsRdra0.status, pyOut[1].mode);
  assert.ok(Math.abs(jsRdra0.flux - pyOut[1].flux) / pyOut[1].flux < 1e-6, `R Dra wing flux mismatch: JS=${jsRdra0.flux} vs Py=${pyOut[1].flux}`);
  assert.ok(Math.abs(jsRdra0.error - pyOut[1].err) / pyOut[1].err < 1e-6, `R Dra wing err mismatch: JS=${jsRdra0.error} vs Py=${pyOut[1].err}`);
}

console.log('Comparison star analysis checks passed (ratios, PM tracking, flags, saturation, Python reference validation).');
