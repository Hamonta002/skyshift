namespace SkyShift {
  // Object tracking, motion fitting, mover detection and classification on
  // aligned grids. Grid pixels are zero-based with x increasing west and y
  // increasing north, as produced by the alignment kernel.

  export interface Measurement { x: number; y: number; flux: number; snr: number; peak: number; height: number; saturated?: boolean; masked?: number }
  export interface TrackPoint extends Measurement { frame: number; ra: number; dec: number; mjd: number | null }
  export interface Motion {
    east: number; north: number; total: number; error: number; angle: number;
    significant: boolean; spanYears: number; points: number; residual: number;
  }
  export interface Brightness { deltaMag: (number | null)[]; amplitude: number; variable: boolean; chi2: number }

  const PSF_ARCSEC = 6.2; // Approximate SPHEREx image quality, used for centroid errors.

  function median(values: number[]): number {
    const sorted = Float64Array.from(values).sort();
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  /** Robust standard deviation (scaled median absolute deviation). */
  function spread(values: number[], centre = median(values)): number {
    return median(values.map((value) => Math.abs(value - centre))) * 1.4826;
  }

  /** Grid pixel to sky position, the inverse of `fieldPixel`. */
  export function gridToSky(field: FieldGeometry, x: number, y: number): [number, number] {
    const east = (field.half - x) * field.scale, north = (y - field.half) * field.scale;
    return unproject({ ra: field.ra0, dec: field.dec0, z: 0 }, -east, -north, 1);
  }

  /**
   * Finds the brightest pixel within `search` px of (sx, sy), then measures a
   * background-subtracted, flux-weighted centroid around it. Returns null when
   * there is no usable signal or the local background cannot be estimated.
   */
  export function measureSource(pixels: Float32Array, side: number, sx: number, sy: number, search: number): Measurement | null {
    let best = -Infinity, px = -1, py = -1;
    for (let y = Math.max(0, Math.floor(sy - search)); y <= Math.min(side - 1, Math.ceil(sy + search)); y++) {
      for (let x = Math.max(0, Math.floor(sx - search)); x <= Math.min(side - 1, Math.ceil(sx + search)); x++) {
        if (Math.hypot(x - sx, y - sy) > search) continue;
        const value = pixels[y * side + x];
        if (Number.isFinite(value) && value > best) { best = value; px = x; py = y; }
      }
    }
    if (px < 0) return null;
    const stats = (cx: number, cy: number, inner: number, outer: number) => {
      const ring: number[] = [];
      for (let dy = -Math.ceil(outer); dy <= outer; dy++) for (let dx = -Math.ceil(outer); dx <= outer; dx++) {
        const r = Math.hypot(dx, dy), x = Math.round(cx) + dx, y = Math.round(cy) + dy;
        if (r < inner || r > outer || x < 0 || y < 0 || x >= side || y >= side) continue;
        const value = pixels[y * side + x];
        if (Number.isFinite(value)) ring.push(value);
      }
      if (ring.length < 12) return null;
      const background = median(ring);
      return { background, noise: Math.max(median(ring.map((value) => Math.abs(value - background))) * 1.4826, 1e-9) };
    };
    // A saturated core is masked (NaN) by the pipeline: a hole ringed by bright
    // pixels. Its centre is the source position; the flux is a lower limit.
    const hole: [number, number][] = [], seen = new Set<number>(), queue: number[] = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = px + dx, y = py + dy;
      if (x >= 0 && y >= 0 && x < side && y < side && !Number.isFinite(pixels[y * side + x])) queue.push(y * side + x);
    }
    let touchesEdge = false;
    while (queue.length && hole.length < 400) {
      const index = queue.pop()!;
      if (seen.has(index) || Number.isFinite(pixels[index])) continue;
      seen.add(index);
      const x = index % side, y = Math.floor(index / side);
      if (x === 0 || y === 0 || x === side - 1 || y === side - 1) touchesEdge = true;
      hole.push([x, y]);
      if (x > 0) queue.push(index - 1); if (x < side - 1) queue.push(index + 1);
      if (y > 0) queue.push(index - side); if (y < side - 1) queue.push(index + side);
    }
    if (hole.length >= 3 && !touchesEdge && hole.length < 400) {
      const cx = hole.reduce((s, p) => s + p[0], 0) / hole.length, cy = hole.reduce((s, p) => s + p[1], 0) / hole.length;
      const extent = Math.sqrt(hole.length / Math.PI);
      const sky = stats(cx, cy, extent + 6, extent + 10);
      if (sky && (best - sky.background) / sky.noise >= 30) {
        let flux = 0, count = 0;
        for (let dy = -Math.ceil(extent + 3); dy <= extent + 3; dy++) for (let dx = -Math.ceil(extent + 3); dx <= extent + 3; dx++) {
          const x = Math.round(cx) + dx, y = Math.round(cy) + dy;
          if (Math.hypot(dx, dy) > extent + 3 || x < 0 || y < 0 || x >= side || y >= side) continue;
          const value = pixels[y * side + x];
          if (Number.isFinite(value)) { flux += value - sky.background; count++; }
        }
        return { x: cx, y: cy, flux, snr: flux / (sky.noise * Math.sqrt(Math.max(count, 1))), peak: (best - sky.background) / sky.noise,
          height: best - sky.background, saturated: true, masked: hole.length };
      }
    }
    const local = stats(px, py, 5, 9);
    if (!local) return null;
    const { background, noise } = local;
    let weight = 0, wx = 0, wy = 0, flux = 0, count = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const x = px + dx, y = py + dy;
      if (Math.hypot(dx, dy) > 2.5 || x < 0 || y < 0 || x >= side || y >= side) continue;
      const value = pixels[y * side + x];
      if (!Number.isFinite(value)) continue;
      const excess = value - background;
      flux += excess; count++;
      if (excess > 0) { weight += excess; wx += excess * x; wy += excess * y; }
    }
    if (weight <= 0 || count < 9) return null;
    return { x: wx / weight, y: wy / weight, flux, snr: flux / (noise * Math.sqrt(count)), peak: (best - background) / noise, height: best - background };
  }

  /**
   * Follows one source through a sequence of aligned frames, starting from a
   * click in `start` and stepping outwards in time from each previous position.
   * Frames where the source is not detected keep a null entry.
   */
  export function trackSource(frames: Float32Array[], side: number, start: number, x0: number, y0: number,
    field: FieldGeometry, mjds: (number | null)[]): TrackPoint[] | null {
    const detect = (pixels: Float32Array, x: number, y: number, search: number) => {
      const found = measureSource(pixels, side, x, y, search);
      return found && found.snr >= 4 && found.peak >= 3 ? found : null;
    };
    const first = detect(frames[start], x0, y0, 3);
    if (!first) return null;
    const result: (Measurement | null)[] = frames.map(() => null);
    result[start] = first;
    for (const direction of [1, -1]) {
      let seed = first;
      for (let frame = start + direction; frame >= 0 && frame < frames.length; frame += direction) {
        const found = detect(frames[frame], seed.x, seed.y, 3.5);
        result[frame] = found;
        if (found) seed = found;
      }
    }
    return result.flatMap((m, frame) => {
      if (!m) return [];
      const [ra, dec] = gridToSky(field, m.x, m.y);
      return [{ ...m, frame, ra, dec, mjd: mjds[frame] ?? null }];
    });
  }

  const yearOf = (mjd: number) => 2000 + (mjd - 51544.5) / 365.25;

  /** Least-squares linear motion in arcsec per year (east and north). */
  export function fitMotion(points: TrackPoint[]): Motion | null {
    const usable = points.filter((p) => p.mjd !== null);
    if (usable.length < 2) return null;
    const ra0 = usable.reduce((s, p) => s + p.ra, 0) / usable.length, dec0 = usable.reduce((s, p) => s + p.dec, 0) / usable.length;
    const plane: Camera = { ra: ra0, dec: dec0, z: 0 };
    const rows = usable.map((p) => {
      const [dx, dy] = project(plane, p.ra, p.dec, 1) ?? [0, 0];
      return { t: yearOf(p.mjd!), east: -dx, north: -dy, sigma: Math.max(0.15, PSF_ARCSEC / Math.max(p.snr, 1)) };
    });
    const tMean = rows.reduce((s, r) => s + r.t, 0) / rows.length;
    const stt = rows.reduce((s, r) => s + (r.t - tMean) ** 2, 0);
    const spanYears = Math.max(...rows.map((r) => r.t)) - Math.min(...rows.map((r) => r.t));
    if (stt <= 0 || spanYears < 0.05) return null;
    const slope = (key: "east" | "north") => {
      const mean = rows.reduce((s, r) => s + r[key], 0) / rows.length;
      return { mean, slope: rows.reduce((s, r) => s + (r.t - tMean) * (r[key] - mean), 0) / stt };
    };
    const e = slope("east"), n = slope("north");
    const residuals = rows.map((r) => Math.hypot(r.east - e.mean - e.slope * (r.t - tMean), r.north - n.mean - n.slope * (r.t - tMean)));
    const residual = Math.sqrt(residuals.reduce((s, v) => s + v * v, 0) / Math.max(1, rows.length - 2));
    const centroid = Math.sqrt(rows.reduce((s, r) => s + r.sigma ** 2, 0) / rows.length);
    const scatter = rows.length > 2 ? Math.max(residual, centroid) : centroid;
    const error = scatter / Math.sqrt(stt);
    const total = Math.hypot(e.slope, n.slope);
    const angle = (Math.atan2(e.slope, n.slope) * 180 / Math.PI + 360) % 360;
    // Significant only if it is several sigma and moved a visible fraction of a pixel.
    const significant = total >= 3 * error && total * spanYears >= 1.2;
    return { east: e.slope, north: n.slope, total, error, angle, significant, spanYears, points: rows.length, residual };
  }

  /**
   * Brightness per frame relative to the median, with a simple variability
   * test. Low-S/N frames (such as a shallow visit) are shown but not used for
   * the test, and a 5% systematic error allows for the different wavelengths
   * SPHEREx samples within a band from visit to visit.
   */
  export function brightness(points: TrackPoint[], frames: number): Brightness {
    const fluxes = points.filter((p) => p.flux > 0);
    const deltaMag: (number | null)[] = Array.from({ length: frames }, () => null);
    if (fluxes.length < 2) return { deltaMag, amplitude: 0, variable: false, chi2: 0 };
    const reference = median(fluxes.map((p) => p.flux));
    for (const p of fluxes) deltaMag[p.frame] = -2.5 * Math.log10(p.flux / reference);
    const solid = fluxes.filter((p) => p.snr >= 10 && !p.saturated);
    if (solid.length < 2) return { deltaMag, amplitude: 0, variable: false, chi2: 0 };
    const mags = solid.map((p) => deltaMag[p.frame]!);
    const amplitude = Math.max(...mags) - Math.min(...mags);
    const level = median(solid.map((p) => p.flux));
    const chi2 = solid.reduce((s, p) => s + (p.flux - level) ** 2 / ((p.flux / p.snr) ** 2 + (0.05 * p.flux) ** 2), 0) / (solid.length - 1);
    return { deltaMag, amplitude, variable: amplitude >= 0.2 && chi2 >= 9, chi2 };
  }

  export interface MoverCandidate {
    kind: "mover" | "brighter" | "fainter";
    /** Grid position, and where it was in the earlier and later of `frames`. */
    x: number; y: number; from: [number, number]; to: [number, number];
    /** Significance in standard deviations, after allowing for the field's own scatter. */
    score: number;
    /** Grid pixels moved between the two visits in `frames`. */
    shift: number;
    /** The two visits that show it best, earlier first. */
    frames: [number, number];
    /** Motion in grid pixels per year (movers only). */
    speed: number;
    /** Magnitudes from the earlier to the later visit in `frames`; negative is brighter. */
    change: number;
    /** Visits it was measured in. */
    visits: number;
    /** Seen in one visit only: it appeared or vanished. */
    single: boolean;
    /** Too bright to measure: the brightness is a lower limit. */
    saturated: boolean;
  }

  const EDGE = 6;
  const CENTROID = 1.2; // Centroid error × S/N for this PSF, in grid pixels.
  // A mover must cross about one image width (6″). Smaller shifts also come
  // from blends and from the PSF changing between visits, and are hard to see.
  const MIN_SHIFT = 2;

  /** Background-subtracted flux in a fixed aperture, or null without full coverage. */
  function aperture(pixels: Float32Array, side: number, x: number, y: number): { flux: number; error: number } | null {
    const cx = Math.round(x), cy = Math.round(y), ring: number[] = [];
    let flux = 0, count = 0;
    for (let dy = -9; dy <= 9; dy++) for (let dx = -9; dx <= 9; dx++) {
      const px = cx + dx, py = cy + dy, r = Math.hypot(px - x, py - y);
      const inside = px >= 0 && py >= 0 && px < side && py < side;
      if (r <= 2.5) {
        const value = inside ? pixels[py * side + px] : NaN;
        if (!Number.isFinite(value)) return null;
        flux += value; count++;
      } else if (inside && r >= 5 && r <= 9 && Number.isFinite(pixels[py * side + px])) ring.push(pixels[py * side + px]);
    }
    if (ring.length < 12) return null;
    const background = median(ring);
    return { flux: flux - background * count, error: Math.max(spread(ring, background), 1e-12) * Math.sqrt(count) };
  }

  /** Sources in a frame: peaks of a lightly smoothed copy, measured on the original. */
  function detectSources(pixels: Float32Array, side: number, threshold: number, limit: number): Measurement[] {
    const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
    const smooth = new Float32Array(pixels.length).fill(NaN), values: number[] = [];
    for (let y = 1; y < side - 1; y++) for (let x = 1; x < side - 1; x++) {
      let sum = 0, weight = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const value = pixels[(y + j) * side + x + i];
        if (Number.isFinite(value)) { const w = kernel[(j + 1) * 3 + i + 1]; sum += w * value; weight += w; }
      }
      if (weight >= 8) { smooth[y * side + x] = sum / weight; values.push(sum / weight); }
    }
    if (values.length < 50) return [];
    // The background level and noise of an evenly spread sample of 20,000 pixels.
    const step = Math.max(1, Math.floor(values.length / 20000));
    const sample = step > 1 ? values.filter((_, i) => i % step === 0) : values;
    const level = median(sample), sigma = Math.max(spread(sample, level), 1e-12);
    const peaks: [number, number, number][] = [];
    for (let y = EDGE; y < side - EDGE; y++) for (let x = EDGE; x < side - EDGE; x++) {
      const value = smooth[y * side + x];
      if (!(value - level >= threshold * sigma)) continue;
      let top = true;
      for (let j = -1; j <= 1 && top; j++) for (let i = -1; i <= 1; i++) {
        if ((i || j) && smooth[(y + j) * side + x + i] > value) { top = false; break; }
      }
      if (top) peaks.push([x, y, value]);
    }
    // Brightest first; a masked saturated core is found from the peaks on its rim.
    peaks.sort((p, q) => q[2] - p[2]);
    const found: Measurement[] = [];
    for (const [x, y] of peaks.slice(0, 3 * limit)) {
      const m = measureSource(pixels, side, x, y, 1.5);
      if (!m || m.snr < 5 || m.peak < 3 || m.flux <= 0 || found.some((s) => Math.hypot(s.x - m.x, s.y - m.y) < 2)) continue;
      found.push(m);
      if (found.length >= limit) break;
    }
    return found;
  }

  /**
   * The source at the brightest pixel within `radius` of (x, y), ignoring
   * pixels within 2 px of `avoid` (sources already claimed), so that a faint
   * source does not jump to a brighter neighbour.
   */
  function claimSource(pixels: Float32Array, side: number, x: number, y: number, radius: number, avoid: [number, number][]): Measurement | null {
    let best = -Infinity, bx = -1, by = -1;
    // A masked saturated core can fill the whole radius: widen it to reach the bright rim.
    for (let r = radius; bx < 0 && r <= radius + 6; r += 3) {
      const near = avoid.filter(([ax, ay]) => Math.hypot(ax - x, ay - y) < r + 2);
      for (let py = Math.max(0, Math.floor(y - r)); py <= Math.min(side - 1, Math.ceil(y + r)); py++) {
        for (let px = Math.max(0, Math.floor(x - r)); px <= Math.min(side - 1, Math.ceil(x + r)); px++) {
          const value = pixels[py * side + px];
          if (!(value > best) || Math.hypot(px - x, py - y) > r || near.some(([ax, ay]) => Math.hypot(px - ax, py - ay) < 2)) continue;
          best = value; bx = px; by = py;
        }
      }
      if (bx >= 0 && r > radius && !measureSource(pixels, side, bx, by, 0.5)?.saturated) bx = -1;
    }
    if (bx < 0) return null;
    const m = measureSource(pixels, side, bx, by, 0.5);
    return m && m.snr >= 4 && m.peak >= 3 ? m : null;
  }

  /** Mean of finite values per pixel, weighted by the exposures in each frame. */
  function meanStack(frames: Float32Array[], weights: number[]): Float32Array {
    const out = new Float32Array(frames[0].length);
    for (let i = 0; i < out.length; i++) {
      let sum = 0, weight = 0;
      frames.forEach((frame, k) => { if (Number.isFinite(frame[i])) { sum += frame[i] * weights[k]; weight += weights[k]; } });
      out[i] = weight ? sum / weight : NaN;
    }
    return out;
  }

  /** Bisection for a monotonic, increasing `value(x)`: x where it reaches `goal`. */
  function solve(value: (x: number) => number, goal: number, lo: number, hi: number): number {
    if (value(lo) >= goal) return lo;
    for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (value(mid) < goal) lo = mid; else hi = mid; }
    return hi;
  }
  /** Median of a chi-square distribution with `dof` degrees of freedom (Wilson–Hilferty). */
  const chiMedian = (dof: number) => dof * (1 - 2 / (9 * dof)) ** 3;

  /**
   * Finds sources that moved or changed brightness across all visits.
   *
   * Every source is measured in every visit. Its motion is a straight-line fit
   * through all visits, and the errors are calibrated on the field's own stars:
   * a registration offset for each visit, a systematic floor from the bright
   * stars and a centroid error for each visit from the faint ones. A source is
   * a mover only if its motion is `threshold` times that error, it moved at
   * least two pixels (6″), the fit is consistent with a straight line and its
   * brightness stayed similar. Brightness changes use forced photometry with a
   * zero point for each visit, between visits with a fair number of exposures,
   * and must be at least 0.3 mag; much of the remaining scatter is the
   * different wavelengths SPHEREx samples in each visit.
   */
  export function findMovers(frames: Float32Array[], side: number, mjds: (number | null)[], counts: number[],
    options = { threshold: 5 }): MoverCandidate[] {
    const threshold = options.threshold, n = frames.length;
    let use = frames.map((_, f) => f).filter((f) => counts[f] >= 2);
    if (use.length < 2) use = frames.map((_, f) => f);
    if (use.length < 2) return [];
    const most = Math.max(...use.map((f) => counts[f]));
    const deep = frames.map((_, f) => use.includes(f) && counts[f] >= Math.max(Math.min(3, most), most / 2));
    const epoch = mjds.find((m): m is number => m !== null && Number.isFinite(m));
    const t = mjds.map((m) => (m !== null && Number.isFinite(m) && epoch !== undefined ? (m - epoch) / 365.25 : NaN));
    const timed = use.filter((f) => Number.isFinite(t[f]));
    const byDepth = [...use].sort((p, q) => counts[q] - counts[p] || q - p);

    // Seeds from the mean of all visits, then from each deep visit for sources seen once.
    const seeds = detectSources(meanStack(use.map((f) => frames[f]), use.map((f) => Math.max(1, counts[f]))), side, 4, 400);
    for (const f of byDepth.filter((g) => deep[g]).slice(0, 8)) {
      for (const m of detectSources(frames[f], side, 4, 400)) if (!seeds.some((s) => Math.hypot(s.x - m.x, s.y - m.y) < 2.5)) seeds.push(m);
    }
    // The fastest star, Barnard's Star, moves 3.4 px a year; allow for a little more.
    const reach = (from: number, to: number) => Number.isFinite(t[from]) && Number.isFinite(t[to]) ? Math.min(4, 1.5 + 4 * Math.abs(t[to] - t[from])) : 3.5;
    type Track = { points: (Measurement | null)[]; mover?: boolean };
    const tracks: Track[] = [];
    for (const seed of seeds) {
      let first: Measurement | null = null, at = -1;
      const claimed = (f: number) => tracks.flatMap((other) => other.points[f] ? [[other.points[f]!.x, other.points[f]!.y] as [number, number]] : []);
      for (const f of byDepth) {
        const m = claimSource(frames[f], side, seed.x, seed.y, 2.5, claimed(f));
        if (m && Math.hypot(m.x - seed.x, m.y - seed.y) <= 2.5) { first = m; at = f; break; }
      }
      if (!first) continue;
      // Follow it outwards in time, as Track & identify does.
      const points: (Measurement | null)[] = frames.map(() => null);
      points[at] = first;
      for (const direction of [1, -1]) {
        let previous = first, seen = at;
        for (let f = at + direction; f >= 0 && f < n; f += direction) {
          if (!use.includes(f)) continue;
          const m = claimSource(frames[f], side, previous.x, previous.y, reach(seen, f), claimed(f));
          points[f] = m;
          if (m) { previous = m; seen = f; }
        }
      }
      // Several seeds can lead to the same source.
      if (tracks.some((other) => points.some((p, f) => p && other.points[f] && Math.hypot(p.x - other.points[f]!.x, p.y - other.points[f]!.y) < 1.5))) continue;
      tracks.push({ points });
    }
    const measured = (track: Track, list = use) => list.filter((f) => track.points[f]);
    const everywhere = (track: Track) => use.every((f) => track.points[f] && !track.points[f]!.saturated);

    // Registration offset of each visit from stars measured well everywhere.
    const solid = tracks.filter((track) => everywhere(track) && use.every((f) => track.points[f]!.snr >= 10));
    const offset = frames.map((): [number, number] => [0, 0]);
    if (solid.length >= 5) for (const f of use) {
      offset[f] = [0, 1].map((axis) => median(solid.map((track) => {
        const value = (g: number) => axis ? track.points[g]!.y : track.points[g]!.x;
        return value(f) - use.reduce((sum, g) => sum + value(g), 0) / use.length;
      }))) as [number, number];
    }
    const pos = (track: Track, f: number): [number, number] => [track.points[f]!.x - offset[f][0], track.points[f]!.y - offset[f][1]];

    // Position error of one measurement: centroid noise plus a systematic floor
    // that grows in shallower visits; saturated cores are less certain.
    const centroid = frames.map((_, f) => CENTROID * Math.sqrt(Math.max(1, 5 / Math.max(counts[f], 1))));
    let floor = 0.15;
    const floorAt = (f: number, base = floor) => base * Math.sqrt(most / Math.max(counts[f], 1));
    const variance = (m: Measurement, f: number, base = floor) => (centroid[f] / m.snr) ** 2 + floorAt(f, base) ** 2 + (m.saturated ? 0.09 : 0);
    const fit = (track: Track, base = floor) => {
      const fs = measured(track, timed);
      const w = fs.map((f) => 1 / variance(track.points[f]!, f, base)), total = w.reduce((a, b) => a + b, 0);
      const tMean = fs.reduce((sum, f, i) => sum + w[i] * t[f], 0) / total;
      const stt = fs.reduce((sum, f, i) => sum + w[i] * (t[f] - tMean) ** 2, 0);
      let still = 0, line = 0;
      const rate = [0, 1].map((axis) => {
        const v = fs.map((f) => pos(track, f)[axis]);
        const mean = v.reduce((sum, value, i) => sum + w[i] * value, 0) / total;
        const slope = stt > 0 ? v.reduce((sum, value, i) => sum + w[i] * (t[fs[i]] - tMean) * (value - mean), 0) / stt : 0;
        v.forEach((value, i) => { still += w[i] * (value - mean) ** 2; line += w[i] * (value - mean - slope * (t[fs[i]] - tMean)) ** 2; });
        return slope;
      });
      const speed = Math.hypot(rate[0], rate[1]);
      const span = fs.length ? t[fs[fs.length - 1]] - t[fs[0]] : 0;
      return { fs, speed, z: stt > 0 ? speed * Math.sqrt(stt) : 0, still, line, span };
    };
    // Floor: bright stationary stars should scatter as expected (the median keeps movers from mattering).
    const bright = tracks.filter((track) => timed.length >= 2 && timed.every((f) => track.points[f] && !track.points[f]!.saturated)
      && timed.filter((f) => track.points[f]!.snr >= 20).length >= Math.min(3, timed.length));
    if (bright.length >= 6) {
      floor = Math.max(0.05, solve((base) => -median(bright.map((track) => { const r = fit(track, base); return r.still / chiMedian(2 * r.fs.length - 2); })), -1, 0.02, 3));
    }
    // Centroid error of each visit from faint stars, each visit against the mean of the others.
    const faint = tracks.filter((track) => timed.length >= 3 && timed.every((f) => track.points[f] && !track.points[f]!.saturated) && !bright.includes(track)).slice(0, 150);
    if (faint.length >= 8) for (let pass = 0; pass < 3; pass++) for (const f of timed) {
      const others = timed.filter((g) => g !== f);
      const scatter = (k: number) => median(faint.map((track) => {
        const [x, y] = pos(track, f);
        const mx = others.reduce((sum, g) => sum + pos(track, g)[0], 0) / others.length;
        const my = others.reduce((sum, g) => sum + pos(track, g)[1], 0) / others.length;
        const own = (k / track.points[f]!.snr) ** 2 + floorAt(f) ** 2;
        const rest = others.reduce((sum, g) => sum + variance(track.points[g]!, g), 0) / others.length ** 2;
        return ((x - mx) ** 2 + (y - my) ** 2) / (own + rest);
      }));
      centroid[f] = solve((k) => -scatter(k), -chiMedian(2), CENTROID, 30);
    }

    // Bright saturated stars leave residuals in their wings; nothing near one is reported.
    const glare = tracks.flatMap((track) => {
      const p = track.points.find((m) => m?.saturated);
      return p ? [{ track, x: p.x, y: p.y, radius: 2 * Math.sqrt((p.masked ?? 0) / Math.PI) + 8 }] : [];
    });
    const inGlare = (track: Track, x: number, y: number) => glare.some((g) => g.track !== track && Math.hypot(x - g.x, y - g.y) < g.radius);

    const candidates: MoverCandidate[] = [];
    for (const track of tracks) {
      if (timed.length < 2) break;
      const r = fit(track);
      const dof = 2 * r.fs.length - 4;
      const fluxes = r.fs.map((f) => track.points[f]!).filter((m) => !m.saturated).map((m) => m.flux);
      const steady = fluxes.length < 2 || Math.max(...fluxes) <= 3 * Math.min(...fluxes);
      if (r.fs.length < Math.min(3, timed.length) || r.z < threshold || r.speed * r.span < MIN_SHIFT || (dof > 0 && r.line > 3 * dof + 8) || !steady) continue;
      const a = r.fs[0], b = r.fs[r.fs.length - 1], from = track.points[a]!, to = track.points[b]!;
      if (inGlare(track, from.x, from.y)) continue;
      track.mover = true;
      candidates.push({
        kind: "mover", x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, from: [from.x, from.y], to: [to.x, to.y], score: r.z,
        shift: Math.hypot(to.x - from.x, to.y - from.y), frames: [a, b], speed: r.speed, change: 0, visits: r.fs.length,
        single: false, saturated: !!(from.saturated || to.saturated),
      });
    }

    // Brightness: forced photometry at each source's mean position in every deep visit.
    const photometryVisits = use.filter((f) => deep[f]);
    type Flux = { flux: number; error: number; masked?: number };
    const centre = (track: Track): [number, number] => {
      const fs = measured(track);
      return [0, 1].map((axis) => fs.reduce((sum, f) => sum + pos(track, f)[axis], 0) / fs.length) as [number, number];
    };
    const photometry = new Map<Track, (Flux | null)[]>();
    for (const track of tracks) {
      if (track.mover) continue;
      const [x, y] = centre(track), saturated = track.points.some((m) => m?.saturated);
      photometry.set(track, frames.map((_, f) => {
        if (!deep[f]) return null;
        const m = track.points[f];
        // A masked core has no complete aperture: use the lower limit around the hole.
        if (saturated) return m ? { flux: m.flux, error: m.flux / m.snr, masked: m.masked ?? 0 } : null;
        return aperture(frames[f], side, x + offset[f][0], y + offset[f][1]);
      }));
    }
    const zero = frames.map(() => 0);
    let systematic = 0.05, noise = 2; // Resampling correlates neighbouring pixels, so apertures look less noisy than they are.
    const ensemble = [...photometry].filter(([track, p]) => !track.points.some((m) => m?.saturated)
      && photometryVisits.every((f) => p[f] && p[f]!.flux > 5 * p[f]!.error)).map(([, p]) => p as Flux[]);
    if (photometryVisits.length >= 2 && ensemble.length >= 5) {
      const mags = (p: Flux[]) => photometryVisits.map((f) => -2.5 * Math.log10(p[f].flux));
      const solidSet = ensemble.filter((p) => photometryVisits.every((f) => p[f].flux > 15 * p[f].error));
      if (solidSet.length >= 5) photometryVisits.forEach((f, i) => {
        zero[f] = median(solidSet.map((p) => { const m = mags(p); return m[i] - m.reduce((a, b) => a + b, 0) / m.length; }));
      });
      // Leave-one-out residual of each visit against the mean of the others.
      const residuals = (p: Flux[]) => {
        const m = photometryVisits.map((f) => -2.5 * Math.log10(p[f].flux) - zero[f]), k = m.length;
        return m.map((value, i) => ({ f: photometryVisits[i], r: value - (m.reduce((a, b) => a + b, 0) - value) / (k - 1) }));
      };
      const brightSet = ensemble.filter((p) => photometryVisits.every((f) => p[f].flux > 40 * p[f].error));
      const k = photometryVisits.length;
      if (brightSet.length >= 5) systematic = Math.max(0.03, spread(brightSet.flatMap((p) => residuals(p).map((e) => e.r)), 0) / Math.sqrt(k / (k - 1)));
      const faintSet = ensemble.filter((p) => !brightSet.includes(p)).slice(0, 150);
      if (faintSet.length >= 8) {
        const stat = (p: Flux[], f: number, scale: number) => (1.0857 * scale * p[f].error / p[f].flux) ** 2 + systematic ** 2;
        noise = solve((scale) => -median(faintSet.flatMap((p) => residuals(p).map(({ f, r }) =>
          r * r / (stat(p, f, scale) + photometryVisits.filter((g) => g !== f).reduce((sum, g) => sum + stat(p, g, scale), 0) / (k - 1) ** 2)))),
        -chiMedian(1), 1, 10);
      }
    }
    for (const [track, p] of photometry) {
      const values = photometryVisits.filter((f) => p[f]).map((f) => {
        const gain = 10 ** (0.4 * zero[f]);
        return { f, flux: p[f]!.flux * gain, error: noise * p[f]!.error * gain, masked: p[f]!.masked };
      });
      if (values.length < 2) continue;
      const hi = values.reduce((a, b) => (b.flux > a.flux ? b : a)), lo = values.reduce((a, b) => (b.flux < a.flux ? b : a));
      const saturated = hi.masked !== undefined;
      const sys = saturated ? Math.hypot(systematic, 0.05) : systematic;
      const z = (hi.flux - lo.flux) / Math.hypot(hi.error, lo.error, sys * hi.flux, sys * Math.max(lo.flux, 0));
      const ratio = Math.max(lo.flux, 0) / hi.flux, seen = values.filter((v) => v.flux > 5 * v.error).length;
      if (z < threshold || ratio > 10 ** (-0.4 * 0.3)) continue;
      if (seen < 2 && hi.flux < 10 * hi.error) continue;
      // A brighter saturated star masks more pixels; disagreement means the lower limits mislead.
      if (saturated && lo.masked !== undefined && hi.masked! < lo.masked) continue;
      const [x, y] = centre(track);
      if (inGlare(track, x, y)) continue;
      const [a, b] = hi.f < lo.f ? [hi.f, lo.f] : [lo.f, hi.f];
      const later = hi.f > lo.f ? hi : lo, earlier = hi.f > lo.f ? lo : hi;
      candidates.push({
        kind: hi.f > lo.f ? "brighter" : "fainter", x, y, from: [x, y], to: [x, y], score: z, shift: 0, frames: [a, b], speed: 0,
        change: -2.5 * Math.log10(Math.max(later.flux, 0.01 * hi.flux) / Math.max(earlier.flux, 0.01 * hi.flux)),
        visits: seen, single: seen < 2, saturated,
      });
    }
    const rank = (c: MoverCandidate) => (c.kind === "mover" ? 1e6 : 0) + c.score;
    return candidates.sort((p, q) => rank(q) - rank(p)).slice(0, 20);
  }

  /** Median of finite values per pixel across frames: a deep stack. */
  export function deepStack(frames: Float32Array[]): Float32Array {
    const out = new Float32Array(frames[0]?.length ?? 0);
    const values: number[] = [];
    for (let i = 0; i < out.length; i++) {
      values.length = 0;
      for (const frame of frames) if (Number.isFinite(frame[i])) values.push(frame[i]);
      out[i] = values.length ? median(values) : NaN;
    }
    return out;
  }

  /** Centre crop of a square grid that shares the same centre and scale. */
  export function cropGrid(pixels: Float32Array, from: number, to: number): Float32Array {
    if (from === to) return pixels;
    if (to > from || (from - to) % 2) throw new Error("Colour bands use an incompatible grid.");
    const offset = (from - to) / 2, out = new Float32Array(to * to);
    for (let y = 0; y < to; y++) out.set(pixels.subarray((y + offset) * from + offset, (y + offset) * from + offset + to), y * to);
    return out;
  }

  export interface CatalogueMatch {
    name: string; type: string; description: string; separation: number;
    pmra: number | null; pmdec: number | null; parallax: number | null; spectralType?: string | null; magnitude?: number | null; colour?: number | null;
  }
  export interface SolarSystemMatch { name: string; number: string | null; kind: string; magnitude: number | null; separation: number; mjd: number }
  export interface Identification {
    simbad: { status: string; matches: CatalogueMatch[] };
    gaia: { status: string; matches: CatalogueMatch[] };
    skybot: { status: string; matches: SolarSystemMatch[] };
  }
  export interface Verdict { label: string; tone: "known" | "candidate" | "neutral"; reasons: string[] }

  /**
   * Plain-language verdict from catalogue matches and measured behaviour.
   * These are rules of thumb, and the reasons say what they were based on.
   */
  export function classifyObject(track: TrackPoint[], frames: number, motion: Motion | null, light: Brightness, id: Identification | null): Verdict {
    const reasons: string[] = [];
    const moving = !!motion?.significant;
    if (motion) reasons.push(moving
      ? `Moves ${motion.total.toFixed(2)} ± ${motion.error.toFixed(2)}″/yr toward PA ${motion.angle.toFixed(0)}° across ${motion.points} visits.`
      : `No significant motion (${motion.total.toFixed(2)} ± ${motion.error.toFixed(2)}″/yr).`);
    if (track.length === 1 && frames > 1) reasons.push("Detected in only one frame.");
    if (light.variable) reasons.push(`Brightness changes by ${light.amplitude.toFixed(2)} mag between frames; part of this can come from the different wavelengths SPHEREx samples in each visit.`);
    const star = id?.simbad.matches.find((m) => m.type !== "Pl") ?? id?.simbad.matches[0];
    const asteroid = id?.skybot.matches[0];
    const gaia = id?.gaia.matches[0];
    if (asteroid && (track.length <= 1 || !star)) {
      reasons.push(`SkyBoT: ${asteroid.name} (${asteroid.kind}) passed ${asteroid.separation.toFixed(0)}″ away.`);
      return { label: `Known solar-system object: ${asteroid.name}`, tone: "known", reasons };
    }
    if (star) {
      const pm = star.pmra !== null && star.pmdec !== null ? Math.hypot(star.pmra, star.pmdec) / 1000 : null;
      reasons.push(`SIMBAD: ${star.name}, ${star.description}${star.spectralType ? ` (${star.spectralType})` : ""}, ${star.separation.toFixed(1)}″ away at this epoch.`);
      if (moving && pm !== null) reasons.push(Math.abs(motion!.total - pm) <= Math.max(3 * motion!.error, 0.3 * pm)
        ? `Measured motion agrees with the catalogue's ${pm.toFixed(2)}″/yr.`
        : `Measured motion differs from the catalogue's ${pm.toFixed(2)}″/yr.`);
      return { label: `${star.description}: ${star.name}`, tone: "known", reasons };
    }
    if (gaia) {
      reasons.push(`Gaia DR3 ${gaia.name}${gaia.magnitude !== null && gaia.magnitude !== undefined ? `, G = ${gaia.magnitude.toFixed(1)}` : ""}${gaia.parallax && gaia.parallax > 0 ? `, about ${(1000 / gaia.parallax).toFixed(0)} pc away` : ""}.`);
      return { label: moving ? "Moving star (Gaia DR3 source)" : "Star (Gaia DR3 source)", tone: "known", reasons };
    }
    const transient = track.length === 1 && frames > 1;
    if (!id) {
      // Without a catalogue check nothing can be called unidentified.
      reasons.push("Catalogues have not been checked.");
      return { label: moving ? "Moving source" : transient ? "Seen in one frame only" : light.variable ? "Variable source" : "Source", tone: "neutral", reasons };
    }
    if (moving) return { label: "Unidentified moving source: candidate", tone: "candidate", reasons };
    if (transient) return { label: "Transient: possibly an asteroid, comet or artefact", tone: "candidate", reasons };
    if (light.variable) return { label: "Unidentified variable source: candidate", tone: "candidate", reasons };
    reasons.push("No catalogue match within the search radius.");
    return { label: "Unidentified source", tone: "neutral", reasons };
  }
}
