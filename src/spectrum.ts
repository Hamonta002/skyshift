namespace SkyShift {
  // SPHEREx image bit assignments documented by IRSA; unknown bits stay visible.
  export function decodeQualityFlags(value: number): string[] {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error("Enter an unsigned 32-bit flag value.");
    const known: Record<number, string> = { 0:"TRANSIENT", 1:"OVERFLOW (near saturation)", 2:"SUR_ERROR", 4:"PHANTOM", 5:"REFERENCE", 6:"NONFUNC", 7:"DICHROIC", 9:"MISSING_DATA", 10:"HOT", 11:"COLD", 12:"FULLSAMPLE", 14:"PHANMISS", 15:"NONLINEAR", 17:"PERSIST", 19:"OUTLIER", 20:"CROSSTALK", 21:"SOURCE (known source)", 22:"GHOST" };
    const names: string[] = [];
    for (let bit = 0; bit < 32; bit++) if ((value >>> bit) & 1) names.push(known[bit] ?? `Unknown bit ${bit}`);
    return names;
  }
  export async function filterWavelength(fixture: PackedFixture, min: number, max: number, signal: AbortSignal): Promise<{ fixture: PackedFixture; unavailable: number }> {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0.7 || max > 5.1 || min >= max) throw new Error("Enter an increasing wavelength range between 0.7 and 5.1 μm.");
    const exposures = decodeFixture(fixture);
    const selected: Exposure[] = [], dates: string[] = [], visitSizes: number[] = [];
    let offset = 0, unavailable = 0;
    for (let visit = 0; visit < fixture.visitSizes.length; visit++) {
      let count = 0;
      for (let i = 0; i < fixture.visitSizes[visit]; i++) {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const exposure = exposures[offset++];
        try {
          const [x, y] = worldToPixel(exposure.wcs, fixture.ra0, fixture.dec0);
          const [wavelength, bandwidth] = await fetchWavelength(exposure.header, x, y, signal);
          if (!Number.isFinite(wavelength) || !Number.isFinite(bandwidth) || bandwidth <= 0) throw new Error("Invalid wavelength metadata.");
          if (wavelength + bandwidth / 2 >= min && wavelength - bandwidth / 2 <= max) { selected.push(exposure); count++; }
        } catch (error) { if (signal.aborted) throw error; unavailable++; }
      }
      if (count) { dates.push(fixture.dates[visit]); visitSizes.push(count); }
    }
    if (!selected.length) throw new Error(unavailable ? "No matching exposures with usable wavelength metadata." : "No exposures overlap this wavelength range.");
    const length = selected.reduce((n, item) => n + item.pixels.byteLength, 0);
    const bytes = new Uint8Array(length); const view = new DataView(bytes.buffer);
    let cursor = 0;
    for (const exposure of selected) for (const value of exposure.pixels) { view.setFloat32(cursor, value, true); cursor += 4; }
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { fixture: { ...fixture, id: `${fixture.id}:wave:${min}:${max}`, dates, visitSizes, headers: selected.map((item) => item.header), pixels: btoa(binary) }, unavailable };
  }
  export interface SpectrumPoint {
    wavelength: number;
    bandwidth: number;
    flux: number;
    error: number;
    visit: number;
    date: string;
    mjd: number | null;
    productKey: string | null;
    saturated: boolean;
    mode: "aperture" | "ring";
  }

  export interface SpectrumTarget {
    label?: string;
    ra: number;
    dec: number;
    raJ2000?: number;
    decJ2000?: number;
    pmra?: number;
    pmdec?: number;
    epoch?: number;
  }

  export interface SpectrumBinComparison {
    minWave: number;
    maxWave: number;
    visits: { visit: number; date: string; medianFlux: number | null; count: number }[];
    ratioMaxMin: number | null;
    deltaMag: number | null;
  }

  export interface SpectrumComparison {
    mode: "aperture" | "ring";
    bins: SpectrumBinComparison[];
    medianDeltaMag: number | null;
    maxDeltaMag: number | null;
    summary: string;
  }

  function arrayMedian(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function arrayQuantile(sorted: number[], q: number): number {
    if (!sorted.length) return NaN;
    const pos = Math.max(0, Math.min(sorted.length - 1, q * (sorted.length - 1)));
    const lo = Math.floor(pos), hi = Math.ceil(pos), t = pos - lo;
    return sorted[lo] * (1 - t) + sorted[hi] * t;
  }

  export function resolveSpectrumTarget(
    fixture: PackedFixture,
    currentTargetId?: string,
    tracked?: {
      start: { ra: number; dec: number; frame: number };
      points: { frame: number; ra: number; dec: number; mjd: number | null }[];
      motion?: { significant: boolean; east: number; north: number } | null;
      id?: {
        simbad: { matches: { name: string; pmra: number | null; pmdec: number | null }[] };
        gaia: { matches: { pmra: number | null; pmdec: number | null }[] };
      } | null;
    } | null,
    selected?: { ra: number; dec: number; label?: string; pmra?: number; pmdec?: number; epoch?: number } | null,
  ): SpectrumTarget {
    if (tracked && tracked.points.length) {
      const at = tracked.points.find((p) => p.frame === tracked.start.frame) ?? tracked.points[0];
      const known = findTargetAt(at.ra, at.dec, 0.005);
      if (known) return known;
      const gaia = tracked.id?.gaia.matches[0];
      const simbad = tracked.id?.simbad.matches[0];
      const pmra = gaia?.pmra ?? simbad?.pmra ?? (tracked.motion?.significant ? tracked.motion.east * 1000 : 0);
      const pmdec = gaia?.pmdec ?? simbad?.pmdec ?? (tracked.motion?.significant ? tracked.motion.north * 1000 : 0);
      const epoch = at.mjd !== null ? mjdToJulianYear(at.mjd) : 2026.0;
      return {
        label: simbad?.name ?? "tracked source",
        ra: at.ra,
        dec: at.dec,
        pmra,
        pmdec,
        epoch,
      };
    }
    if (selected) {
      const known = findTargetAt(selected.ra, selected.dec, 0.005);
      if (known) return known;
      return {
        label: selected.label ?? `${selected.ra.toFixed(5)}°, ${selected.dec.toFixed(5)}°`,
        ra: selected.ra,
        dec: selected.dec,
        pmra: selected.pmra,
        pmdec: selected.pmdec,
        epoch: selected.epoch,
      };
    }
    const named = (currentTargetId ? TARGETS.find((item) => item.id === currentTargetId) : undefined)
      ?? findTargetAt(fixture.ra0, fixture.dec0);
    if (named) return named;
    return { label: "field centre", ra: fixture.ra0, dec: fixture.dec0 };
  }

  export async function quickSpectrum(fixture: PackedFixture, signal: AbortSignal, target?: SpectrumTarget): Promise<SpectrumPoint[]> {
    const exposures = decodeFixture(fixture);
    const result: SpectrumPoint[] = [];
    const astrometry = target ?? findTargetAt(fixture.ra0, fixture.dec0);
    const solidAngle = 37.86 * (Math.PI / 648000) ** 2;
    let index = 0;
    for (let visit = 0; visit < fixture.visitSizes.length; visit++) {
      for (let i = 0; i < fixture.visitSizes[visit]; i++, index++) {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const exposure = exposures[index], h = exposure.header;
        let ra = target?.ra ?? fixture.ra0, dec = target?.dec ?? fixture.dec0;
        if (h.mjd !== undefined && astrometry && astrometry.pmra !== undefined && astrometry.pmdec !== undefined) {
          [ra, dec] = targetPosition({
            ra,
            dec,
            raJ2000: astrometry.raJ2000,
            decJ2000: astrometry.decJ2000,
            pmra: astrometry.pmra,
            pmdec: astrometry.pmdec,
            epoch: astrometry.epoch,
          }, h.mjd);
        }
        const [x, y] = worldToPixel(exposure.wcs, ra, dec);
        const cx = x - h.x0, cy = y - h.y0;
        if (cx < 4 || cy < 4 || cx >= h.size - 4 || cy >= h.size - 4) continue;
        const sky: number[] = [];
        let nanCore = 0;
        for (let py = 0; py < h.size; py++) for (let px = 0; px < h.size; px++) {
          const radius = Math.hypot(px - cx, py - cy);
          const value = exposure.pixels[py * h.size + px];
          if (radius <= 2.5 && !Number.isFinite(value)) nanCore++;
          else if (radius > 8 && radius < 14 && Number.isFinite(value)) sky.push(value);
        }
        if (sky.length < 30) continue;
        const background = arrayMedian(sky);
        const mad = Math.max(1.4826 * arrayMedian(sky.map((v) => Math.abs(v - background))), 1e-9);
        let mx = cx, my = cy;
        let flux = NaN, error = NaN, saturated = false, mode: "aperture" | "ring" = "aperture";
        if (nanCore === 0) {
          let tx = cx, ty = cy;
          for (let iter = 0; iter < 8; iter++) {
            let wSum = 0, wx = 0, wy = 0;
            for (let py = 0; py < h.size; py++) for (let px = 0; px < h.size; px++) {
              if (Math.hypot(px - tx, py - ty) <= 2.5) {
                const value = exposure.pixels[py * h.size + px];
                if (Number.isFinite(value) && value - background > 0) {
                  const w = value - background;
                  wSum += w; wx += px * w; wy += py * w;
                }
              }
            }
            if (wSum <= 0) break;
            tx = wx / wSum; ty = wy / wSum;
          }
          // Only adopt the refined centroid when signal-to-noise is solid and the core stays finite.
          const evalAperture = (ax: number, ay: number) => {
            const vals: number[] = [];
            let hasNan = false;
            for (let py = 0; py < h.size; py++) for (let px = 0; px < h.size; px++) {
              if (Math.hypot(px - ax, py - ay) <= 2.5) {
                const value = exposure.pixels[py * h.size + px];
                if (!Number.isFinite(value)) hasNan = true;
                else vals.push(value - background);
              }
            }
            const sum = vals.reduce((a, b) => a + b, 0);
            const snr = vals.length ? sum / (mad * Math.sqrt(vals.length)) : 0;
            return { vals, hasNan, sum, snr };
          };
          const refined = Math.hypot(tx - cx, ty - cy) <= 2.0 ? evalAperture(tx, ty) : null;
          const chosen = refined && !refined.hasNan && refined.snr >= 5 ? ((mx = tx), (my = ty), refined) : evalAperture(cx, cy);
          if (!chosen.hasNan && chosen.vals.length >= 10) {
            flux = chosen.sum * solidAngle * 1e6;
            error = mad * Math.sqrt(chosen.vals.length) * solidAngle * 1e6;
            saturated = false;
            mode = "aperture";
          } else {
            nanCore = 1;
          }
        }
        if (nanCore > 0) {
          // Saturated/blanked core fallback: 3-6 px PSF wing annulus (matching reference/measure_frames.py --wing).
          let wingTotal = 0, wingValid = 0, wingSum = 0;
          for (let py = 0; py < h.size; py++) for (let px = 0; px < h.size; px++) {
            const radius = Math.hypot(px - cx, py - cy);
            if (radius > 3 && radius <= 6) {
              wingTotal++;
              const value = exposure.pixels[py * h.size + px];
              if (Number.isFinite(value)) {
                wingSum += value - background;
                wingValid++;
              }
            }
          }
          if (wingTotal < 10 || wingValid <= 0.7 * wingTotal) continue;
          flux = (wingSum / wingValid) * wingTotal * solidAngle * 1e6;
          error = mad * Math.sqrt(wingTotal) * solidAngle * 1e6;
          saturated = true;
          mode = "ring";
        }
        if (!Number.isFinite(flux)) continue;
        let wavelength: number, bandwidth: number;
        try { [wavelength, bandwidth] = await fetchWavelength(h, mx + h.x0, my + h.y0, signal); }
        catch (err) { if (signal.aborted) throw err; continue; }
        if (!Number.isFinite(wavelength)) continue;
        result.push({
          wavelength,
          bandwidth,
          flux,
          error,
          visit,
          date: fixture.dates[visit] ?? `Visit ${visit + 1}`,
          mjd: h.mjd ?? null,
          productKey: h.productKey ?? null,
          saturated,
          mode,
        });
      }
    }
    return result.sort((a, b) => a.wavelength - b.wavelength);
  }

  export function compareSpectrumVisits(points: SpectrumPoint[], dates: string[]): SpectrumComparison {
    const clean = points.filter((p) => p.mode === "aperture");
    const ring = points.filter((p) => p.mode === "ring");
    const useRing = clean.length < 6 && ring.length > clean.length;
    const mode: "aperture" | "ring" = useRing ? "ring" : "aperture";
    const subset = useRing ? ring : (clean.length ? clean : points);
    if (subset.length < 3 || dates.length < 2) {
      return { mode, bins: [], medianDeltaMag: null, maxDeltaMag: null, summary: "" };
    }
    const waves = subset.map((p) => p.wavelength).sort((a, b) => a - b);
    const edges = [0, 1 / 3, 2 / 3, 1].map((q) => arrayQuantile(waves, q));
    const bins: SpectrumBinComparison[] = [];
    for (let i = 0; i < 3; i++) {
      const minWave = edges[i], maxWave = edges[i + 1];
      const visits = dates.map((date, visit) => {
        const vals = subset
          .filter((p) => p.visit === visit && p.wavelength >= minWave && p.wavelength <= maxWave)
          .map((p) => p.flux);
        return { visit, date, medianFlux: vals.length ? arrayMedian(vals) : null, count: vals.length };
      });
      const pos = visits.map((v) => v.medianFlux).filter((v): v is number => v !== null && v > 0);
      const ratioMaxMin = pos.length >= 2 ? Math.max(...pos) / Math.min(...pos) : null;
      const deltaMag = ratioMaxMin !== null ? 2.5 * Math.log10(ratioMaxMin) : null;
      bins.push({ minWave, maxWave, visits, ratioMaxMin, deltaMag });
    }
    const validDeltas = bins.map((b) => b.deltaMag).filter((d): d is number => d !== null && Number.isFinite(d));
    const medianDeltaMag = validDeltas.length ? arrayMedian(validDeltas) : null;
    const maxDeltaMag = validDeltas.length ? Math.max(...validDeltas) : null;
    const formatFlux = (v: number) => Math.abs(v) >= 0.1 ? v.toFixed(2) : (v * 1e3).toFixed(2) + " m";
    const binText = bins.map((b) => {
      const seriesText = b.visits.map((v) => v.medianFlux !== null ? `${formatFlux(v.medianFlux)}[${v.count}]` : "–").join(" → ");
      return `${b.minWave.toFixed(2)}–${b.maxWave.toFixed(2)} μm: ${seriesText}`;
    }).join(" · ");
    const summary = validDeltas.length
      ? `Matched-wavelength visit medians (${mode === "ring" ? "3–6 px ring Jy" : "2.5 px aperture Jy"}): ${binText} (median Δm = ${medianDeltaMag!.toFixed(2)} mag).`
      : `Matched-wavelength visit medians: ${binText}.`;
    return { mode, bins, medianDeltaMag, maxDeltaMag, summary };
  }
}
