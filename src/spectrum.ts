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
  export interface SpectrumPoint { wavelength: number; bandwidth: number; flux: number; surfaceBrightness: number; date: string; mjd: number | null; productKey: string | null; }

  export async function quickSpectrum(fixture: PackedFixture, signal: AbortSignal, position?: { ra: number; dec: number }): Promise<SpectrumPoint[]> {
    const exposures = decodeFixture(fixture);
    const result: SpectrumPoint[] = [];
    let index = 0;
    for (let visit = 0; visit < fixture.visitSizes.length; visit++) {
      for (let i = 0; i < fixture.visitSizes[visit]; i++, index++) {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const exposure = exposures[index], h = exposure.header;
        let ra = position?.ra ?? fixture.ra0, dec = position?.dec ?? fixture.dec0;
        if (!position && Math.abs(ra - 133.759765) < 1e-5 && Math.abs(dec + 7.242186) < 1e-5 && h.mjd !== undefined) {
          const year = 2000 + (h.mjd - 51544.5) / 365.25;
          ra += (year - 2026) * -8123.7 / 3600000 / Math.cos(dec * Math.PI / 180);
          dec += (year - 2026) * 673.2 / 3600000;
        }
        const [x, y] = worldToPixel(exposure.wcs, ra, dec);
        const cx = x - h.x0, cy = y - h.y0;
        const sky: number[] = [], aperture: number[] = [];
        let incomplete = false;
        for (let py = 0; py < h.size; py++) for (let px = 0; px < h.size; px++) {
          const radius = Math.hypot(px - cx, py - cy);
          const value = exposure.pixels[py * h.size + px];
          if (radius <= 2.5) {
            if (!Number.isFinite(value)) incomplete = true;
            else aperture.push(value);
          } else if (radius > 8 && radius < 14 && Number.isFinite(value)) sky.push(value);
        }
        if (incomplete || aperture.length < 10 || sky.length < 30 || cx < 14 || cy < 14 || cx >= h.size - 14 || cy >= h.size - 14) continue;
        sky.sort((a, b) => a - b);
        const background = sky[Math.floor(sky.length / 2)];
        let wavelength: number, bandwidth: number;
        try { [wavelength, bandwidth] = await fetchWavelength(h, x, y, signal); }
        catch (error) { if (signal.aborted) throw error; continue; }
        if (!Number.isFinite(wavelength)) continue;
        const solidAngle = 37.86 * (Math.PI / 648000) ** 2;
        const surfaceBrightness = aperture.reduce((sum, value) => sum + value - background, 0) / aperture.length;
        const flux = aperture.reduce((sum, value) => sum + value - background, 0) * solidAngle * 1e6;
        result.push({ wavelength, bandwidth, flux, surfaceBrightness, date: fixture.dates[visit], mjd: h.mjd ?? null, productKey: h.productKey ?? null });
      }
    }
    return result.sort((a, b) => a.wavelength - b.wavelength);
  }
}
