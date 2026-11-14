// Plain-JavaScript check of the numerical core the browser needs: TAN-SIP, resampling, median stacking.
//   1. accuracy against Astropy on real SPHEREx headers
//   2. the same visit stacks as the Python reference, on real pixels
//   3. timing at the default and the largest view
// No dependencies.   python export_for_js.py && node bench.mjs [_work/wise0855_d6.json]
import { readFileSync } from "node:fs";

const D2R = Math.PI / 180;

// ---- sky transform ------------------------------------------------------------------------------
function makeWcs(e) {
  const a0 = e.crval[0] * D2R, d0 = e.crval[1] * D2R;
  const cd = [e.pc[0] * e.cdelt[0], e.pc[1] * e.cdelt[0], e.pc[2] * e.cdelt[1], e.pc[3] * e.cdelt[1]];
  const det = cd[0] * cd[3] - cd[1] * cd[2];
  const poly = (c) => Float64Array.from(["0_0", "1_0", "0_1", "2_0", "1_1", "0_2", "3_0", "2_1", "1_2", "0_3"], (k) => c[k] || 0);
  return {
    n: [Math.cos(d0) * Math.cos(a0), Math.cos(d0) * Math.sin(a0), Math.sin(d0)],              // pointing direction
    east: [-Math.sin(a0), Math.cos(a0), 0],
    north: [-Math.sin(d0) * Math.cos(a0), -Math.sin(d0) * Math.sin(a0), Math.cos(d0)],
    cd, inv: [cd[3] / det, -cd[1] / det, -cd[2] / det, cd[0] / det],
    cx: e.crpix[0] - 1, cy: e.crpix[1] - 1,                                                    // 0-based reference pixel
    A: poly(e.a), B: poly(e.b), AP: poly(e.ap), BP: poly(e.bp),
  };
}
// third-order SIP polynomial
const sip = (c, u, v) => c[0] + c[1] * u + c[2] * v + c[3] * u * u + c[4] * u * v + c[5] * v * v + c[6] * u * u * u + c[7] * u * u * v + c[8] * u * v * v + c[9] * v * v * v;

// Unit vector on the sky -> 0-based pixel. The header's inverse polynomial is a fit, good to ~0.005 px;
// each fixed-point step with the forward polynomial tightens it (two steps: ~2e-6 px).
function vecToPix(w, px, py, pz, refine, out) {
  const t = px * w.n[0] + py * w.n[1] + pz * w.n[2];
  const xi = (px * w.east[0] + py * w.east[1]) / t / D2R;
  const eta = (px * w.north[0] + py * w.north[1] + pz * w.north[2]) / t / D2R;
  const U = w.inv[0] * xi + w.inv[1] * eta, V = w.inv[2] * xi + w.inv[3] * eta;
  let u = U + sip(w.AP, U, V), v = V + sip(w.BP, U, V);
  for (let i = 0; i < refine; i++) { const un = U - sip(w.A, u, v), vn = V - sip(w.B, u, v); u = un; v = vn; }
  out[0] = u + w.cx; out[1] = v + w.cy;
}
function pixToWorld(w, x, y) {
  const u = x - w.cx, v = y - w.cy, uu = u + sip(w.A, u, v), vv = v + sip(w.B, u, v);
  const xi = (w.cd[0] * uu + w.cd[1] * vv) * D2R, eta = (w.cd[2] * uu + w.cd[3] * vv) * D2R;
  const X = w.n[0] + xi * w.east[0] + eta * w.north[0], Y = w.n[1] + xi * w.east[1] + eta * w.north[1], Z = w.n[2] + eta * w.north[2];
  return [(Math.atan2(Y, X) / D2R + 360) % 360, Math.atan2(Z, Math.hypot(X, Y)) / D2R];
}
const skyVec = (ra, dec) => [Math.cos(dec * D2R) * Math.cos(ra * D2R), Math.cos(dec * D2R) * Math.sin(ra * D2R), Math.sin(dec * D2R)];

// ---- output grid: north up, east left, fixed on the sky ----------------------------------------
function makeGrid(ra0, dec0, half, scaleArcsec) {
  const g = makeWcs({ crval: [ra0, dec0], crpix: [half + 1, half + 1], pc: [1, 0, 0, 1], cdelt: [-scaleArcsec / 3600, scaleArcsec / 3600], a: {}, b: {}, ap: {}, bp: {} });
  const n = 2 * half + 1;
  const vec = (i, j) => {                                       // sky direction of grid position (i, j); also valid off the grid
    const xi = g.cd[0] * (i - half) * D2R, eta = g.cd[3] * (j - half) * D2R;
    const X = g.n[0] + xi * g.east[0] + eta * g.north[0], Y = g.n[1] + xi * g.east[1] + eta * g.north[1], Z = g.n[2] + eta * g.north[2], r = Math.hypot(X, Y, Z);
    return [X / r, Y / r, Z / r];
  };
  return { n, vec };
}

// Where each grid pixel falls in the exposure. The exact transform is evaluated every `step` grid pixels and
// interpolated in between (step 1 = exact everywhere).
function mapping(grid, w, refine, step) {
  const n = grid.n, m = Math.ceil((n - 1) / step) + 1, lx = new Float64Array(m * m), ly = new Float64Array(m * m), p = [0, 0];
  for (let b = 0; b < m; b++) for (let a = 0; a < m; a++) {
    const v = grid.vec(a * step, b * step);
    vecToPix(w, v[0], v[1], v[2], refine, p);
    lx[b * m + a] = p[0]; ly[b * m + a] = p[1];
  }
  if (step === 1) return { x: lx, y: ly };
  const x = new Float64Array(n * n), y = new Float64Array(n * n);
  for (let j = 0, k = 0; j < n; j++) {
    const b = Math.min(Math.floor(j / step), m - 2), fy = (j - b * step) / step;
    for (let i = 0; i < n; i++, k++) {
      const a = Math.min(Math.floor(i / step), m - 2), fx = (i - a * step) / step, q = b * m + a;
      x[k] = (lx[q] * (1 - fx) + lx[q + 1] * fx) * (1 - fy) + (lx[q + m] * (1 - fx) + lx[q + m + 1] * fx) * fy;
      y[k] = (ly[q] * (1 - fx) + ly[q + 1] * fx) * (1 - fy) + (ly[q + m] * (1 - fx) + ly[q + m + 1] * fx) * fy;
    }
  }
  return { x, y };
}

// ---- resample one exposure onto the grid (bilinear) and subtract its median; null if under half covered
function resample(grid, w, img, size, x0, y0, refine = 2, step = 1) {
  const N = grid.n * grid.n, out = new Float32Array(N), map = mapping(grid, w, refine, step);
  let nfin = 0;
  for (let k = 0; k < N; k++) {
    const bx = map.x[k] - x0, by = map.y[k] - y0, ix = Math.floor(bx), iy = Math.floor(by);
    if (ix < 0 || iy < 0 || ix >= size - 1 || iy >= size - 1) { out[k] = NaN; continue; }
    const tx = bx - ix, ty = by - iy, o = iy * size + ix;
    const val = img[o] * (1 - tx) * (1 - ty) + img[o + 1] * tx * (1 - ty) + img[o + size] * (1 - tx) * ty + img[o + size + 1] * tx * ty;
    out[k] = val;
    if (val === val) nfin++;
  }
  if (nfin < 0.5 * N) return null;
  const fin = new Float32Array(nfin);
  for (let k = 0, c = 0; k < N; k++) if (out[k] === out[k]) fin[c++] = out[k];
  fin.sort();
  const med = nfin % 2 ? fin[(nfin - 1) / 2] : 0.5 * (fin[nfin / 2 - 1] + fin[nfin / 2]);
  for (let k = 0; k < N; k++) out[k] -= med;
  return out;
}
// per-pixel median over the exposures of one visit, ignoring NaN
function medianStack(frames, N) {
  const out = new Float32Array(N), buf = new Float32Array(frames.length);
  for (let k = 0; k < N; k++) {
    let m = 0;
    for (let f = 0; f < frames.length; f++) {
      const v = frames[f][k];
      if (v === v) { let i = m++; while (i > 0 && buf[i - 1] > v) { buf[i] = buf[i - 1]; i--; } buf[i] = v; }
    }
    out[k] = m === 0 ? NaN : m % 2 ? buf[(m - 1) / 2] : 0.5 * (buf[m / 2 - 1] + buf[m / 2]);
  }
  return out;
}

// ---- 1. accuracy against Astropy -----------------------------------------------------------------
const data = JSON.parse(readFileSync(process.argv[2] ?? "_work/wise0855_d6.json", "utf8"));
const exps = data.exposures.map((e) => ({ ...e, w: makeWcs(e), pix: Float32Array.from(e.img, (v) => (v === null ? NaN : v)) }));
console.log(`1. Transform accuracy on ${exps.length} real headers, ${exps.length * 40} points`);
for (const refine of [0, 1, 2]) {
  let worst = 0; const p = [0, 0];
  for (const e of exps) for (let i = 0; i < e.test.ra.length; i++) {
    const s = skyVec(e.test.ra[i], e.test.dec[i]);
    vecToPix(e.w, s[0], s[1], s[2], refine, p);
    worst = Math.max(worst, Math.hypot(p[0] - e.test.x[i], p[1] - e.test.y[i]));
  }
  console.log(`   sky -> pixel, ${refine} refinement step(s): worst difference from Astropy ${worst.toExponential(1)} px`);
}
{
  let worst = 0;
  for (const e of exps) for (let i = 0; i < e.test.x.length; i++) {
    const [ra, dec] = pixToWorld(e.w, e.test.x[i], e.test.y[i]);
    worst = Math.max(worst, Math.hypot((ra - e.test.ra_back[i]) * Math.cos(dec * D2R), dec - e.test.dec_back[i]) * 3600);
  }
  console.log(`   pixel -> sky: worst difference from Astropy ${worst.toExponential(1)} arcsec`);
}

// ---- 2. the same visit stacks as the Python reference ---------------------------------------------
const grid = makeGrid(data.ra0, data.dec0, data.oh, data.scale);
function stacksFor(refine, step) {
  const frames = exps.map((e) => resample(grid, e.w, e.pix, e.size, e.x0, e.y0, refine, step)).filter(Boolean);
  let start = 0;
  return data.visit_sizes.map((n) => { const s = medianStack(frames.slice(start, start + n), grid.n * grid.n); start += n; return s; });
}
function worstDiff(stacks) {
  let worst = 0, peak = 0;
  stacks.forEach((s, v) => s.forEach((val, k) => { const ref = data.stacks[v][k]; if (ref !== null && val === val) { worst = Math.max(worst, Math.abs(val - ref)); peak = Math.max(peak, Math.abs(ref)); } }));
  return [worst, peak];
}
console.log(`2. Visit stacks of WISE 0855, band 6 (${exps.length} exposures, ${grid.n}x${grid.n} px)`);
{
  const [worst, peak] = worstDiff(stacksFor(2, 1));
  console.log(`   exact transform: worst difference from the Python stacks ${worst.toExponential(1)} MJy/sr (brightest stack pixel ${peak.toFixed(2)})`);
  let shift = 0;
  for (const e of exps) { const a = mapping(grid, e.w, 2, 1), b = mapping(grid, e.w, 1, 8); for (let k = 0; k < a.x.length; k++) shift = Math.max(shift, Math.hypot(a.x[k] - b.x[k], a.y[k] - b.y[k])); }
  const [worst8] = worstDiff(stacksFor(1, 8));
  console.log(`   transform every 8th pixel, interpolated: positions differ by at most ${shift.toExponential(1)} px, stacks by ${worst8.toExponential(1)} MJy/sr`);
}

// ---- 3. timing at realistic sizes (random pixels, real transforms, one thread) --------------------
function timeCase(label, fieldArcmin, nExposures, perStack, step) {
  const size = Math.round(fieldArcmin * 60 / 6.15), g = makeGrid(data.ra0, data.dec0, Math.round(fieldArcmin * 60 / 3.075 / 2), 3.075);
  const c = skyVec(data.ra0, data.dec0), p = [0, 0], jobs = [];
  for (let i = 0; i < nExposures; i++) {
    const e = exps[i % exps.length];
    vecToPix(e.w, c[0], c[1], c[2], 2, p);
    const img = new Float32Array(size * size);
    for (let k = 0; k < img.length; k++) img[k] = Math.random();
    jobs.push({ w: e.w, img, x0: Math.round(p[0]) - (size >> 1), y0: Math.round(p[1]) - (size >> 1) });
  }
  const runs = [];
  for (let rep = 0; rep < 5; rep++) {
    const t0 = performance.now();
    const frames = jobs.map((j) => resample(g, j.w, j.img, size, j.x0, j.y0, step === 1 ? 2 : 1, step));
    const t1 = performance.now();
    for (let s = 0; s < frames.length; s += perStack) medianStack(frames.slice(s, s + perStack), g.n * g.n);
    runs.push([performance.now() - t0, t1 - t0]);
  }
  runs.sort((a, b) => a[0] - b[0]);
  const [total, res] = runs[2];
  return `${String(Math.round(total)).padStart(5)} ms (resample ${Math.round(res)}, stack ${Math.round(total - res)})`;
}
console.log("3. Time to resample and stack, median of 5 runs:             exact transform                 | every 8th pixel");
for (const [label, field, nexp] of [["5' field, one band (default)", 5, 60], ["10' field, one band", 10, 60], ["20' field, one band", 20, 60], ["20' field, all six bands", 20, 360]]) {
  console.log(`   ${label.padEnd(30)} ${String(nexp).padStart(3)} exposures: ${timeCase(label, field, nexp, 20, 1)} | ${timeCase(label, field, nexp, 20, 8)}`);
}
