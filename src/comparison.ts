/// <reference path="science.ts" />
/// <reference path="archive.ts" />
/// <reference path="spectrum.ts" />
namespace SkyShift {
  // Comparison-star (differential) photometry.
  //
  // The target and a reference star are measured in the same exposures with the
  // same quick-look photometry (measureApertureAt). Their ratio cancels effects
  // common to both stars in one exposure (calibration drifts, throughput), so a
  // change in the ratio between visits points to the target (or the reference)
  // really changing.

  export type StarMeasurementStatus =
    | "measured"      // clean 2.5 px aperture
    | "estimate"      // 3–6 px ring estimate for a blanked (saturated) core
    | "edge"          // aperture too close to the crop edge / off the image
    | "no-sky"        // fewer than 30 finite sky pixels
    | "blank-core"    // core blanked and too few finite wing pixels
    | "no-wavelength"; // photometry valid but wavelength metadata unavailable

  export interface StarMeasurement {
    exposure: number;
    visit: number;
    date: string;
    mjd: number | null;
    productKey: string | null;
    /** Proper-motion-propagated aperture centre for this exposure (degrees). */
    ra: number;
    dec: number;
    /** Full-detector pixel position of the aperture (for flag look-ups); null if not computable. */
    detectorX: number | null;
    detectorY: number | null;
    status: StarMeasurementStatus;
    /** Jy; null whenever no valid measurement exists. Never a 0 placeholder. */
    flux: number | null;
    error: number | null;
    snr: number | null;
    wavelength: number | null;
    bandwidth: number | null;
    /** Combined SPHEREx FLAGS value around the aperture when it was checked; undefined = not checked. */
    flags?: number | null;
  }

  /** Flag bits treated as contamination of a photometric measurement. SOURCE (21) only marks a known source and is ignored. */
  export const COMPARISON_REJECT_FLAG_BITS: Record<number, string> = {
    0: "TRANSIENT", 1: "OVERFLOW", 4: "PHANTOM", 6: "NONFUNC", 9: "MISSING_DATA", 10: "HOT", 11: "COLD",
    15: "NONLINEAR", 17: "PERSIST", 19: "OUTLIER", 20: "CROSSTALK", 22: "GHOST",
  };
  export const COMPARISON_REJECT_FLAG_MASK = Object.keys(COMPARISON_REJECT_FLAG_BITS)
    .reduce((mask, bit) => (mask | (1 << Number(bit))) >>> 0, 0);

  export function contaminationNames(flags: number, mask = COMPARISON_REJECT_FLAG_MASK): string[] {
    const names: string[] = [];
    for (let bit = 0; bit < 32; bit++) {
      if (((flags & mask) >>> bit) & 1) names.push(COMPARISON_REJECT_FLAG_BITS[bit] ?? `bit ${bit}`);
    }
    return names;
  }

  /** Measure one star in every exposure of a fixture, keeping a record (with a reason) for each exposure. */
  export async function measureStarSeries(
    fixture: PackedFixture,
    star: SpectrumTarget,
    signal: AbortSignal,
    exposures: Exposure[] = decodeFixture(fixture),
  ): Promise<StarMeasurement[]> {
    const out: StarMeasurement[] = [];
    let index = 0;
    for (let visit = 0; visit < fixture.visitSizes.length; visit++) {
      for (let i = 0; i < fixture.visitSizes[visit]; i++, index++) {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const exposure = exposures[index], h = exposure.header;
        const [ra, dec] = exposureSkyPosition(star, h.mjd);
        const [x, y] = worldToPixel(exposure.wcs, ra, dec);
        const finite = Number.isFinite(x) && Number.isFinite(y);
        const m = finite ? measureApertureAt(exposure.pixels, h.size, x - h.x0, y - h.y0) : null;
        const record: StarMeasurement = {
          exposure: index, visit,
          date: fixture.dates[visit] ?? `Visit ${visit + 1}`,
          mjd: h.mjd ?? null, productKey: h.productKey ?? null,
          ra, dec,
          detectorX: finite ? (m ? m.x : x - h.x0) + h.x0 : null,
          detectorY: finite ? (m ? m.y : y - h.y0) + h.y0 : null,
          status: !m ? "edge" : m.status === "aperture" ? "measured" : m.status === "ring" ? "estimate" : m.status,
          flux: m?.flux ?? null, error: m?.error ?? null, snr: m?.snr ?? null,
          wavelength: null, bandwidth: null,
        };
        if (m && (m.status === "aperture" || m.status === "ring")) {
          try {
            const [wavelength, bandwidth] = await fetchWavelength(h, m.x + h.x0, m.y + h.y0, signal);
            if (Number.isFinite(wavelength) && Number.isFinite(bandwidth) && bandwidth > 0) {
              record.wavelength = wavelength; record.bandwidth = bandwidth;
            } else record.status = "no-wavelength";
          } catch (error) {
            if (signal.aborted) throw error;
            record.status = "no-wavelength";
          }
        }
        out.push(record);
      }
    }
    return out;
  }

  export interface ComparisonOptions {
    /** Max |λ_target − λ_reference| as a fraction of the narrower channel width. */
    maxWaveOffsetFraction?: number;
    /** Minimum reference S/N for a pair to be used. */
    minReferenceSnr?: number;
    /** Flag bits that reject a pair when set at either aperture. */
    rejectFlagMask?: number;
    /** Significance (σ) needed to call a matched-wavelength change real. */
    significance?: number;
  }

  export interface ComparisonPair {
    exposure: number;
    visit: number;
    date: string;
    mjd: number | null;
    wavelength: number | null;
    waveOffset: number | null;
    target: StarMeasurement;
    reference: StarMeasurement;
    mode: "measured" | "estimate" | null;
    ratio: number | null;
    ratioError: number | null;
    usable: boolean;
    reason: string | null;
  }

  export interface WeightedValue { value: number; error: number }

  export interface VisitComparison {
    visit: number;
    date: string;
    mjd: number | null;
    pairs: number;
    waveMin: number | null;
    waveMax: number | null;
    target: WeightedValue | null;
    reference: WeightedValue | null;
    ratio: WeightedValue | null;
    /** −2.5 log10(ratio / median visit ratio); positive = target fainter relative to the reference. */
    deltaMag: WeightedValue | null;
  }

  export interface MatchedBinComparison {
    minWave: number;
    maxWave: number;
    visits: { visit: number; date: string; pairs: number; ratio: WeightedValue | null }[];
    /** Brightest minus faintest visit ratio, in magnitudes (≥ 0), with its 1σ error. */
    deltaMag: number | null;
    deltaMagError: number | null;
    sigma: number | null;
    significant: boolean;
  }

  export interface ReferenceAssessment {
    severity: "ok" | "warning" | "reject";
    suitable: boolean;
    reasons: string[];
  }

  export interface StarComparison {
    mode: "measured" | "estimate" | null;
    pairs: ComparisonPair[];
    visits: VisitComparison[];
    bins: MatchedBinComparison[];
    assessment: ReferenceAssessment;
    usablePairs: number;
    chi2: number | null;
    dof: number;
    amplitudeMag: number | null;
    verdict: "variable" | "constant" | "insufficient" | "unsuitable-reference";
    verdictText: string;
    assumptions: string[];
  }

  const median = (values: number[]) => {
    const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  /** Inverse-variance weighted mean. Error = max(formal, scatter/√n) so unmodelled scatter is not hidden. */
  export function weightedMean(values: { value: number; error: number }[]): WeightedValue | null {
    const valid = values.filter((v) => Number.isFinite(v.value) && Number.isFinite(v.error) && v.error > 0);
    if (!valid.length) return null;
    let sw = 0, swx = 0;
    for (const v of valid) { const w = 1 / v.error ** 2; sw += w; swx += w * v.value; }
    const mean = swx / sw;
    let error = Math.sqrt(1 / sw);
    if (valid.length >= 3) {
      const scatter = Math.sqrt(valid.reduce((s, v) => s + (v.value - mean) ** 2, 0) / (valid.length - 1));
      error = Math.max(error, scatter / Math.sqrt(valid.length));
    }
    return { value: mean, error };
  }

  /** Ratio and propagated 1σ error, or null if either flux is unusable. */
  export function fluxRatio(target: number | null, targetError: number | null, reference: number | null, referenceError: number | null): WeightedValue | null {
    if (target === null || reference === null || targetError === null || referenceError === null) return null;
    if (![target, reference, targetError, referenceError].every(Number.isFinite) || reference <= 0 || targetError <= 0 || referenceError <= 0) return null;
    const value = target / reference;
    const error = Math.sqrt((targetError / reference) ** 2 + (target * referenceError / reference ** 2) ** 2);
    return { value, error };
  }

  /** Magnitude difference −2.5 log10(a/b) with first-order error; null for non-positive ratios. */
  export function magnitudeDifference(a: WeightedValue, b: WeightedValue): WeightedValue | null {
    if (!(a.value > 0) || !(b.value > 0)) return null;
    return {
      value: -2.5 * Math.log10(a.value / b.value),
      error: 1.0857362 * Math.sqrt((a.error / a.value) ** 2 + (b.error / b.value) ** 2),
    };
  }

  function pairUp(t: StarMeasurement, r: StarMeasurement, opts: Required<ComparisonOptions>): ComparisonPair {
    const pair: ComparisonPair = {
      exposure: t.exposure, visit: t.visit, date: t.date, mjd: t.mjd,
      wavelength: t.wavelength !== null && r.wavelength !== null ? (t.wavelength + r.wavelength) / 2 : (t.wavelength ?? r.wavelength),
      waveOffset: t.wavelength !== null && r.wavelength !== null ? t.wavelength - r.wavelength : null,
      target: t, reference: r, mode: null, ratio: null, ratioError: null, usable: false, reason: null,
    };
    const bad = (who: string, m: StarMeasurement) => {
      switch (m.status) {
        case "edge": return `${who} outside the image`;
        case "no-sky": return `${who} has too few sky pixels`;
        case "blank-core": return `${who} core blanked, no usable wing`;
        case "no-wavelength": return `${who} wavelength unavailable`;
        default: return null;
      }
    };
    pair.reason = bad("target", t) ?? bad("reference", r);
    if (pair.reason) return pair;
    if (t.status !== r.status) {
      pair.reason = t.status === "estimate" ? "target saturated (ring estimate) vs clean reference aperture" : "reference saturated (ring estimate)";
      return pair;
    }
    pair.mode = t.status === "estimate" ? "estimate" : "measured";
    for (const [who, m] of [["target", t], ["reference", r]] as const) {
      if (typeof m.flags === "number" && (m.flags & opts.rejectFlagMask)) {
        pair.reason = `${who} flagged: ${contaminationNames(m.flags, opts.rejectFlagMask).join(", ")}`;
        return pair;
      }
    }
    if (pair.waveOffset === null || t.bandwidth === null || r.bandwidth === null) { pair.reason = "wavelength unavailable"; return pair; }
    if (Math.abs(pair.waveOffset) > opts.maxWaveOffsetFraction * Math.min(t.bandwidth, r.bandwidth)) {
      pair.reason = `wavelength mismatch (${(pair.waveOffset * 1000).toFixed(0)} nm)`;
      return pair;
    }
    if (r.flux === null || r.error === null || !(r.flux > 0) || r.flux / r.error < opts.minReferenceSnr) {
      pair.reason = `reference S/N below ${opts.minReferenceSnr}`;
      return pair;
    }
    const ratio = fluxRatio(t.flux, t.error, r.flux, r.error);
    if (!ratio) { pair.reason = "missing uncertainty"; return pair; }
    pair.ratio = ratio.value; pair.ratioError = ratio.error; pair.usable = true;
    return pair;
  }

  export function assessReference(
    target: StarMeasurement[],
    reference: StarMeasurement[],
    pairs: ComparisonPair[],
    separationArcsec: number,
    visitCount: number,
  ): ReferenceAssessment {
    const reject: string[] = [], warn: string[] = [];
    if (!Number.isFinite(separationArcsec) || separationArcsec < 1) reject.push("Reference and target are the same position.");
    else if (separationArcsec < 31) reject.push(`Apertures overlap (separation ${separationArcsec.toFixed(1)}″ < 31″, two 2.5 px radii).`);
    else if (separationArcsec < 87) warn.push(`Separation ${separationArcsec.toFixed(0)}″ puts one star inside the other's 8–14 px sky annulus; backgrounds may be biased.`);
    const refMeasured = reference.filter((m) => m.status === "measured" || m.status === "estimate");
    const refSat = refMeasured.filter((m) => m.status === "estimate").length;
    if (refMeasured.length && refSat / refMeasured.length > 0.5) reject.push(`Reference core is saturated in ${refSat} of ${refMeasured.length} exposures.`);
    else if (refSat) warn.push(`Reference core is saturated in ${refSat} exposure(s); those pairs are excluded unless the target is also saturated.`);
    const usable = pairs.filter((p) => p.usable);
    if (usable.length < 3) reject.push(`Only ${usable.length} usable paired exposure(s); at least 3 are needed.`);
    else if (usable.length < 0.5 * pairs.length) warn.push(`Only ${usable.length} of ${pairs.length} exposures give a usable pair.`);
    const refSnr = refMeasured.filter((m) => m.status === "measured" && m.snr !== null).map((m) => m.snr!);
    if (refSnr.length && median(refSnr) < 20) warn.push(`Reference is faint (median S/N ${median(refSnr).toFixed(0)}); it adds noise to the ratio.`);
    const flagged = pairs.filter((p) => p.reason?.includes("flagged")).length;
    if (flagged && flagged > 0.3 * pairs.length) warn.push(`${flagged} exposure(s) rejected for contamination flags.`);
    const mismatched = pairs.filter((p) => p.reason?.startsWith("wavelength mismatch")).length;
    if (mismatched) warn.push(`${mismatched} exposure(s) excluded because the two stars sample different wavelengths.`);
    const visitsWithTarget = new Set(target.filter((m) => m.status === "measured" || m.status === "estimate").map((m) => m.visit));
    const visitsWithPairs = new Set(usable.map((p) => p.visit));
    const lost = [...visitsWithTarget].filter((v) => !visitsWithPairs.has(v));
    if (lost.length && visitCount > 1) warn.push(`No usable pair in visit(s) ${lost.map((v) => v + 1).join(", ")} where the target was measured.`);
    const severity = reject.length ? "reject" : warn.length ? "warning" : "ok";
    return { severity, suitable: !reject.length, reasons: [...reject, ...warn] };
  }

  /**
   * Pair target and reference exposure by exposure, then summarise per visit and
   * in matched-wavelength bins. Pure function: no I/O.
   */
  export function compareStars(
    target: StarMeasurement[],
    reference: StarMeasurement[],
    dates: string[],
    separationArcsec: number,
    options: ComparisonOptions = {},
  ): StarComparison {
    const opts: Required<ComparisonOptions> = {
      maxWaveOffsetFraction: options.maxWaveOffsetFraction ?? 0.5,
      minReferenceSnr: options.minReferenceSnr ?? 5,
      rejectFlagMask: options.rejectFlagMask ?? COMPARISON_REJECT_FLAG_MASK,
      significance: options.significance ?? 3,
    };
    const byExposure = new Map(reference.map((m) => [m.exposure, m]));
    const pairs = target.flatMap((t) => { const r = byExposure.get(t.exposure); return r ? [pairUp(t, r, opts)] : []; });
    // Never mix clean apertures with ring estimates in one series.
    const measured = pairs.filter((p) => p.usable && p.mode === "measured");
    const estimates = pairs.filter((p) => p.usable && p.mode === "estimate");
    const mode: StarComparison["mode"] = measured.length >= 3 || measured.length >= estimates.length ? (measured.length ? "measured" : null) : "estimate";
    for (const p of pairs) if (p.usable && p.mode !== mode) { p.usable = false; p.reason = p.mode === "estimate" ? "ring estimate (series uses clean apertures)" : "clean aperture (series uses ring estimates)"; }
    const usable = pairs.filter((p) => p.usable);
    const assessment = assessReference(target, reference, pairs, separationArcsec, dates.length);

    const visits: VisitComparison[] = dates.map((date, visit) => {
      const vp = usable.filter((p) => p.visit === visit);
      const mjds = vp.map((p) => p.mjd).filter((m): m is number => m !== null);
      const waves = vp.map((p) => p.wavelength).filter((w): w is number => w !== null);
      return {
        visit, date, pairs: vp.length,
        mjd: mjds.length ? mjds.reduce((a, b) => a + b, 0) / mjds.length : null,
        waveMin: waves.length ? Math.min(...waves) : null,
        waveMax: waves.length ? Math.max(...waves) : null,
        target: weightedMean(vp.map((p) => ({ value: p.target.flux!, error: p.target.error! }))),
        reference: weightedMean(vp.map((p) => ({ value: p.reference.flux!, error: p.reference.error! }))),
        ratio: weightedMean(vp.map((p) => ({ value: p.ratio!, error: p.ratioError! }))),
        deltaMag: null,
      };
    });
    const ratios = visits.filter((v) => v.ratio && v.ratio.value > 0).map((v) => v.ratio!);
    if (ratios.length) {
      const ref = { value: median(ratios.map((r) => r.value)), error: 0 };
      for (const v of visits) if (v.ratio) {
        const dm = magnitudeDifference(v.ratio, { value: ref.value, error: 0 });
        v.deltaMag = dm;
      }
    }
    let chi2: number | null = null;
    const dof = Math.max(0, ratios.length - 1);
    if (ratios.length >= 2) {
      const mean = weightedMean(ratios)!.value;
      chi2 = ratios.reduce((s, r) => s + ((r.value - mean) / r.error) ** 2, 0);
    }
    const dms = visits.map((v) => v.deltaMag?.value).filter((d): d is number => d !== undefined && Number.isFinite(d));
    const amplitudeMag = dms.length >= 2 ? Math.max(...dms) - Math.min(...dms) : null;

    // Matched-wavelength bins: tertiles of the usable pair wavelengths, as in compareSpectrumVisits.
    const bins: MatchedBinComparison[] = [];
    const waves = usable.map((p) => p.wavelength).filter((w): w is number => w !== null).sort((a, b) => a - b);
    if (waves.length >= 6 && dates.length >= 2) {
      const q = (f: number) => { const pos = f * (waves.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos); return waves[lo] + (waves[hi] - waves[lo]) * (pos - lo); };
      const edges = [0, 1 / 3, 2 / 3, 1].map(q);
      for (let i = 0; i < 3; i++) {
        const lo = edges[i], hi = edges[i + 1];
        const inBin = usable.filter((p) => p.wavelength !== null && p.wavelength >= lo && (i === 2 ? p.wavelength <= hi : p.wavelength < hi));
        const bv = dates.map((date, visit) => {
          const vp = inBin.filter((p) => p.visit === visit);
          return { visit, date, pairs: vp.length, ratio: weightedMean(vp.map((p) => ({ value: p.ratio!, error: p.ratioError! }))) };
        });
        const pos = bv.filter((v) => v.ratio && v.ratio.value > 0).map((v) => v.ratio!);
        let deltaMag: number | null = null, deltaMagError: number | null = null, sigma: number | null = null;
        if (pos.length >= 2) {
          const hiR = pos.reduce((a, b) => (b.value > a.value ? b : a)), loR = pos.reduce((a, b) => (b.value < a.value ? b : a));
          const dm = magnitudeDifference(loR, hiR)!;
          deltaMag = dm.value; deltaMagError = dm.error; sigma = dm.error > 0 ? dm.value / dm.error : null;
        }
        bins.push({ minWave: lo, maxWave: hi, visits: bv, deltaMag, deltaMagError, sigma, significant: sigma !== null && sigma >= opts.significance });
      }
    }

    let verdict: StarComparison["verdict"], verdictText: string;
    const binsWithData = bins.filter((b) => b.sigma !== null);
    const visitsWithData = visits.filter((v) => v.ratio).length;
    if (!assessment.suitable) {
      verdict = "unsuitable-reference";
      verdictText = "Comparison star unsuitable: " + assessment.reasons[0];
    } else if (visitsWithData < 2) {
      verdict = "insufficient";
      verdictText = "Fewer than two visits have usable pairs; differential variability cannot be assessed.";
    } else if (binsWithData.length ? binsWithData.some((b) => b.significant) : (chi2 !== null && dof > 0 && chi2 / dof > opts.significance ** 2)) {
      verdict = "variable";
      const best = binsWithData.length ? binsWithData.reduce((a, b) => ((b.sigma ?? 0) > (a.sigma ?? 0) ? b : a)) : null;
      verdictText = best
        ? `Target/reference ratio changes by ${best.deltaMag!.toFixed(3)} ± ${best.deltaMagError!.toFixed(3)} mag (${best.sigma!.toFixed(1)}σ) at matched wavelength ${best.minWave.toFixed(2)}–${best.maxWave.toFixed(2)} μm.`
        : `Visit ratios scatter beyond their errors (χ²/dof = ${(chi2! / dof).toFixed(1)}), but no matched-wavelength bin has data from two visits.`;
    } else {
      verdict = "constant";
      const limit = binsWithData.length ? Math.max(...binsWithData.map((b) => opts.significance * b.deltaMagError!)) : null;
      verdictText = limit !== null
        ? `No significant change in the target/reference ratio at matched wavelengths (3σ limit ≈ ${limit.toFixed(3)} mag).`
        : "No significant change in the target/reference ratio between visits.";
    }
    if (mode === "estimate" && verdict !== "unsuitable-reference") verdictText += " Based on ring estimates of saturated cores (approximate).";

    const assumptions = [
      "Both stars are measured in the same exposures with the same 2.5 px aperture, 8–14 px median sky and no aperture correction; the aperture correction largely cancels in the ratio for point sources.",
      "Ratio errors propagate the per-exposure sky-noise errors; visit errors take the larger of the formal and scatter-based errors.",
      `Pairs are used only when the two stars' wavelengths differ by ≤ ${opts.maxWaveOffsetFraction} × the narrower channel width.`,
      "Visit-to-visit changes are only claimed within matched-wavelength bins, because SPHEREx samples different wavelengths in each visit and the two stars can have different colours.",
      "A change in the ratio can come from either star. The reference is assumed constant; its own variability cannot be tested with one reference.",
      "Clean apertures and ring (saturated-core) estimates are never mixed in one series.",
    ];
    return { mode, pairs, visits, bins, assessment, usablePairs: usable.length, chi2, dof, amplitudeMag, verdict, verdictText, assumptions };
  }
}
