/// <reference path="science.ts" />
/// <reference path="coordinates.ts" />
/// <reference path="catalogue.ts" />
/// <reference path="map.ts" />
namespace SkyShift {
  // Object tracking, motion fitting, mover detection and classification on
  // aligned grids. Grid pixels are zero-based with x increasing west and y
  // increasing north, as produced by the alignment kernel.

  export interface Measurement { x: number; y: number; flux: number; snr: number; peak: number; height: number; saturated?: boolean }
  export interface TrackPoint extends Measurement { frame: number; ra: number; dec: number; mjd: number | null }
  export interface Motion {
    east: number; north: number; total: number; error: number; angle: number;
    significant: boolean; spanYears: number; points: number; residual: number;
  }
  export interface Brightness { deltaMag: (number | null)[]; amplitude: number; variable: boolean; chi2: number }

  const PSF_ARCSEC = 6.2; // Approximate SPHEREx image quality, used for centroid errors.

  function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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
          height: best - sky.background, saturated: true };
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
    field: FieldGeometry, mjds: (number | null)[], motionHint?: { pmra?: number; pmdec?: number }): TrackPoint[] | null {
    const detect = (pixels: Float32Array, x: number, y: number, search: number) => {
      const found = measureSource(pixels, side, x, y, search);
      return found && found.snr >= 4 && found.peak >= 3 ? found : null;
    };
    const first = detect(frames[start], x0, y0, 3);
    if (!first) return null;
    const [firstRa, firstDec] = gridToSky(field, first.x, first.y);
    const known = (motionHint && motionHint.pmra !== undefined && motionHint.pmdec !== undefined)
      ? motionHint
      : findTargetAt(firstRa, firstDec, 0.005);
    const result: (Measurement | null)[] = frames.map(() => null);
    result[start] = first;
    for (const direction of [1, -1]) {
      let seed = first, seedFrame = start;
      let prev: Measurement | null = null, prevFrame = -1;
      for (let frame = start + direction; frame >= 0 && frame < frames.length; frame += direction) {
        let found = detect(frames[frame], seed.x, seed.y, 3.5);
        if (!found) {
          const mjdSeed = mjds[seedFrame] ?? null, mjdNow = mjds[frame] ?? null;
          if (known && known.pmra !== undefined && known.pmdec !== undefined && mjdSeed !== null && mjdNow !== null) {
            const dtYears = (mjdNow - mjdSeed) / 365.25;
            const [seedRa, seedDec] = gridToSky(field, seed.x, seed.y);
            const cosDec = Math.max(1e-6, Math.cos((seedDec * Math.PI) / 180));
            const predRa = (((seedRa + (known.pmra * dtYears) / (3_600_000 * cosDec)) % 360) + 360) % 360;
            const predDec = Math.max(-90, Math.min(90, seedDec + (known.pmdec * dtYears) / 3_600_000));
            const [predX, predY] = fieldPixel(field, predRa, predDec);
            found = detect(frames[frame], predX, predY, 3.5);
          } else if (prev && prevFrame >= 0 && mjds[prevFrame] !== null && mjdSeed !== null && mjdNow !== null && Math.abs(mjdSeed - mjds[prevFrame]!) >= 10) {
            const dtPrev = mjdSeed - mjds[prevFrame]!;
            const dtNext = mjdNow - mjdSeed;
            const predX = seed.x + ((seed.x - prev.x) / dtPrev) * dtNext;
            const predY = seed.y + ((seed.y - prev.y) / dtPrev) * dtNext;
            found = detect(frames[frame], predX, predY, 3.5);
          }
        }
        result[frame] = found;
        if (found) {
          prev = seed;
          prevFrame = seedFrame;
          seed = found;
          seedFrame = frame;
        }
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
    x: number; y: number; from: [number, number]; to: [number, number];
    score: number; shift: number; relative: number;
  }

  /**
   * Looks for the signature of a moving source in B − A: a negative residual
   * where it was in A next to a positive one where it is in B, of similar
   * amplitude and a sizeable fraction of the source's own peak (which rejects
   * small misregistration of bright stars). Strong unpaired residuals are
   * reported as brightness changes.
   */
  export function findMovers(a: Float32Array, b: Float32Array, side: number, options = { threshold: 5, maxShift: 8 }): MoverCandidate[] {
    const d = combineFrames(a, b, "difference");
    const finite = Array.from(d).filter(Number.isFinite);
    if (finite.length < 50) return [];
    const centre = median(finite);
    const sigma = Math.max(median(finite.map((v) => Math.abs(v - centre))) * 1.4826, 1e-12);
    const extrema: { x: number; y: number; v: number }[] = [];
    for (let y = 3; y < side - 3; y++) for (let x = 3; x < side - 3; x++) {
      const v = d[y * side + x] - centre;
      if (!Number.isFinite(v) || Math.abs(v) < options.threshold * sigma) continue;
      let extreme = true;
      for (let dy = -1; dy <= 1 && extreme; dy++) for (let dx = -1; dx <= 1; dx++) {
        const n = d[(y + dy) * side + x + dx] - centre;
        if (!Number.isFinite(n)) { extreme = false; break; }
        if ((dx || dy) && (v > 0 ? n > v : n < v)) { extreme = false; break; }
      }
      if (extreme) extrema.push({ x, y, v });
    }
    extrema.sort((p, q) => Math.abs(q.v) - Math.abs(p.v));
    const positives = extrema.filter((e) => e.v > 0).slice(0, 200), negatives = extrema.filter((e) => e.v < 0).slice(0, 200);
    const used = new Set<typeof negatives[number]>();
    const sourcePeak = (pixels: Float32Array, x: number, y: number) => measureSource(pixels, side, x, y, 1.5);
    const candidates: MoverCandidate[] = [];
    const pairedPositive = new Set<typeof positives[number]>();
    for (const pos of positives) {
      let partner: typeof negatives[number] | undefined, best = Infinity;
      for (const neg of negatives) {
        if (used.has(neg)) continue;
        const distance = Math.hypot(neg.x - pos.x, neg.y - pos.y);
        const balance = pos.v / -neg.v;
        if (distance <= options.maxShift && distance < best && balance >= 1 / 3 && balance <= 3) { partner = neg; best = distance; }
      }
      if (!partner) continue;
      const before = sourcePeak(a, partner.x, partner.y), after = sourcePeak(b, pos.x, pos.y);
      const height = Math.max(before?.height ?? 0, after?.height ?? 0);
      const amplitude = Math.min(pos.v, -partner.v);
      // A stationary star misregistered by a fraction of a pixel leaves a weak
      // dipole relative to its own peak; a real mover leaves a strong one.
      const relative = amplitude / Math.max(height, sigma);
      if (relative < 0.25) continue;
      used.add(partner); pairedPositive.add(pos);
      // Refine both ends with centroids for a sub-pixel shift.
      const fromC = before ? [before.x, before.y] as [number, number] : [partner.x, partner.y] as [number, number];
      const toC = after ? [after.x, after.y] as [number, number] : [pos.x, pos.y] as [number, number];
      candidates.push({ kind: "mover", x: (fromC[0] + toC[0]) / 2, y: (fromC[1] + toC[1]) / 2, from: fromC, to: toC,
        score: amplitude / sigma, shift: Math.hypot(toC[0] - fromC[0], toC[1] - fromC[1]), relative });
    }
    for (const e of extrema) {
      if (Math.abs(e.v) < 1.6 * options.threshold * sigma || pairedPositive.has(e) || used.has(e)) continue;
      if (candidates.some((c) => Math.hypot(c.x - e.x, c.y - e.y) < 4)) continue;
      candidates.push({ kind: e.v > 0 ? "brighter" : "fainter", x: e.x, y: e.y, from: [e.x, e.y], to: [e.x, e.y], score: Math.abs(e.v) / sigma, shift: 0, relative: 0 });
    }
    const rank = (c: MoverCandidate) => (c.kind === "mover" ? 1000 : 0) + c.score;
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
