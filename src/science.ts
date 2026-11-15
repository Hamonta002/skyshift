namespace SkyShift {
  export interface ExposureHeader {
    size: number;
    x0: number;
    y0: number;
    crval: [number, number];
    crpix: [number, number];
    pc: [number, number, number, number];
    cdelt: [number, number];
    a: Record<string, number>;
    b: Record<string, number>;
    ap: Record<string, number>;
    bp: Record<string, number>;
    productKey?: string;
    mjd?: number;
    wavelength?: number;
    bandwidth?: number;
  }

  export interface PackedFixture {
    id: string;
    ra0: number;
    dec0: number;
    half: number;
    scale: number;
    dates: string[];
    visitSizes: number[];
    headers: ExposureHeader[];
    pixels: string;
  }

  export interface Exposure {
    header: ExposureHeader;
    wcs: Float64Array;
    pixels: Float32Array;
  }

  export interface Grid {
    side: number;
    sky: Float64Array;
  }

  export interface Sequence {
    grid: Grid;
    visits: Exposure[][];
  }

  export interface AlignedSeries {
    side: number;
    frames: Float32Array[];
    counts: number[];
  }

  export function combineFrames(reference: Float32Array, comparison: Float32Array, mode: "sum" | "difference"): Float32Array {
    if (reference.length !== comparison.length) throw new Error("Frames use different grids.");
    return comparison.map((value, i) => Number.isFinite(value) && Number.isFinite(reference[i])
      ? mode === "sum" ? value + reference[i] : value - reference[i] : NaN);
  }

  interface AlignmentBuffer {
    align(exposure: Exposure, frameIndex: number): boolean;
    stack(frameCount: number): Float32Array;
  }

  export type Engine = (grid: Grid, exposureCapacity: number, pixelCapacity: number) => AlignmentBuffer;
  export type EngineName = "typescript" | "rust";
  export type Scenario = "wise0855" | "5arcmin" | "20arcmin" | "sixbands";

  export const SCENARIOS: Record<Scenario, string> = {
    wise0855: "WISE 0855 · 45 real exposures",
    "5arcmin": "5′ · 60 synthetic exposures",
    "20arcmin": "20′ · 60 synthetic exposures",
    sixbands: "20′ · 360 synthetic exposures",
  };

  const RAD = Math.PI / 180;
  const SIP_KEYS = ["0_0", "1_0", "0_1", "2_0", "1_1", "0_2", "3_0", "2_1", "1_2", "0_3"];
  // Shared ABI: pointing/east/north vectors, inverse linear map, reference
  // pixel, then the four ten-element SIP coefficient sets.
  const WCS_LENGTH = 55;

  function skyBasis(ra: number, dec: number): number[] {
    const a = ra * RAD;
    const d = dec * RAD;
    return [
      Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d),
      -Math.sin(a), Math.cos(a), 0,
      -Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d),
    ];
  }

  export function packWcs(header: ExposureHeader): Float64Array {
    const [a, b, c, d] = [
      header.pc[0] * header.cdelt[0], header.pc[1] * header.cdelt[0],
      header.pc[2] * header.cdelt[1], header.pc[3] * header.cdelt[1],
    ];
    const determinant = a * d - b * c;
    const wcs = new Float64Array(WCS_LENGTH);
    wcs.set(skyBasis(...header.crval));
    wcs.set([d / determinant, -b / determinant, -c / determinant, a / determinant], 9);
    wcs.set([header.crpix[0] - 1, header.crpix[1] - 1], 13);
    for (const [index, coefficients] of [header.a, header.b, header.ap, header.bp].entries()) {
      wcs.set(SIP_KEYS.map((key) => coefficients[key] ?? 0), 15 + index * 10);
    }
    return wcs;
  }

  function sip(wcs: Float64Array, i: number, u: number, v: number): number {
    return wcs[i] + wcs[i + 1] * u + wcs[i + 2] * v
      + wcs[i + 3] * u * u + wcs[i + 4] * u * v + wcs[i + 5] * v * v
      + wcs[i + 6] * u * u * u + wcs[i + 7] * u * u * v
      + wcs[i + 8] * u * v * v + wcs[i + 9] * v * v * v;
  }

  export function worldToPixel(wcs: Float64Array, ra: number, dec: number): [number, number] {
    const a = ra * RAD, d = dec * RAD;
    const sx = Math.cos(d) * Math.cos(a), sy = Math.cos(d) * Math.sin(a), sz = Math.sin(d);
    const projection = sx * wcs[0] + sy * wcs[1] + sz * wcs[2];
    if (projection <= 0) throw new Error("Position is outside the image projection.");
    const xi = (sx * wcs[3] + sy * wcs[4] + sz * wcs[5]) / projection / RAD;
    const eta = (sx * wcs[6] + sy * wcs[7] + sz * wcs[8]) / projection / RAD;
    const u0 = wcs[9] * xi + wcs[10] * eta, v0 = wcs[11] * xi + wcs[12] * eta;
    let u = u0 + sip(wcs, 35, u0, v0), v = v0 + sip(wcs, 45, u0, v0);
    for (let k = 0; k < 2; k++) {
      const next = u0 - sip(wcs, 15, u, v);
      v = v0 - sip(wcs, 25, u, v);
      u = next;
    }
    return [u + wcs[13], v + wcs[14]];
  }

  function makeGrid(ra: number, dec: number, half: number, scale: number): Grid {
    const basis = skyBasis(ra, dec);
    const side = 2 * half + 1;
    const sky = new Float64Array(side * side * 3);
    for (let y = 0, i = 0; y < side; y++) {
      const north = (y - half) * scale / 3600 * RAD;
      for (let x = 0; x < side; x++, i += 3) {
        const east = (half - x) * scale / 3600 * RAD;
        const sx = basis[0] + east * basis[3] + north * basis[6];
        const sy = basis[1] + east * basis[4] + north * basis[7];
        const sz = basis[2] + east * basis[5] + north * basis[8];
        const length = Math.hypot(sx, sy, sz);
        sky[i] = sx / length;
        sky[i + 1] = sy / length;
        sky[i + 2] = sz / length;
      }
    }
    return { side, sky };
  }

  export function decodeFixture(fixture: PackedFixture): Exposure[] {
    const data = new DataView(Uint8Array.from(atob(fixture.pixels), (c) => c.charCodeAt(0)).buffer);
    let cursor = 0;
    const exposures = fixture.headers.map((header) => {
      const pixels = new Float32Array(header.size ** 2);
      for (let i = 0; i < pixels.length; i++, cursor += 4) {
        pixels[i] = data.getFloat32(cursor, true);
      }
      return { header, wcs: packWcs(header), pixels };
    });
    if (cursor !== data.byteLength) throw new Error("Unexpected fixture length.");
    return exposures;
  }

  export function makeSequence(fixture: PackedFixture, exposures: Exposure[], scenario: Scenario): Sequence {
    if (scenario === "wise0855") {
      let start = 0;
      const visits = fixture.visitSizes.map((size) => {
        const visit = exposures.slice(start, start + size);
        start += size;
        return visit;
      });
      return { grid: makeGrid(fixture.ra0, fixture.dec0, fixture.half, fixture.scale), visits };
    }
    const arcminutes = scenario === "5arcmin" ? 5 : 20;
    const side = Math.round(arcminutes * 60 / 6.15);
    const half = Math.round(arcminutes * 30 / fixture.scale);
    const visitCount = scenario === "sixbands" ? 18 : 3;
    let seed = 5987;
    const visits = Array.from({ length: visitCount }, (_, visit) => {
      return Array.from({ length: 20 }, (_, index) => {
        const base = exposures[(visit * 20 + index) % exposures.length];
        const offset = Math.floor(base.header.size / 2) - Math.floor(side / 2);
        const header = { ...base.header, size: side, x0: base.header.x0 + offset, y0: base.header.y0 + offset };
        const pixels = new Float32Array(side * side);
        for (let i = 0; i < pixels.length; i++) {
          seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
          pixels[i] = seed / 4294967296;
        }
        return { header, wcs: base.wcs, pixels };
      });
    });
    return { grid: makeGrid(fixture.ra0, fixture.dec0, half, fixture.scale), visits };
  }

  // Select a rank in-place. Both engines use the same median calculation
  // and ignore missing pixels, including NaN introduced during alignment.
  function select(values: Float32Array, length: number, rank: number): number {
    let low = 0;
    let high = length - 1;
    while (low < high) {
      const pivot = values[(low + high) >> 1];
      let i = low;
      let j = high;
      while (i <= j) {
        while (i <= high && values[i] < pivot) i++;
        while (j >= low && values[j] > pivot) j--;
        if (i <= j) {
          const saved = values[i];
          values[i++] = values[j];
          values[j--] = saved;
        }
      }
      if (rank <= j) high = j;
      else if (rank >= i) low = i;
      else break;
    }
    return values[rank];
  }

  function median(values: Float32Array, length: number): number {
    const upper = select(values, length, length >> 1);
    if (length % 2) return upper;
    return (upper + select(values, length, (length >> 1) - 1)) * 0.5;
  }

  export const typeScriptEngine: Engine = (grid, exposureCapacity) => {
    const length = grid.side ** 2;
    const frames = new Float32Array(length * exposureCapacity);
    const scratch = new Float32Array(Math.max(length, exposureCapacity));
    const sky = grid.sky;
    return {
      align({ header, wcs, pixels }, frameIndex) {
        const offset = frameIndex * length;
        const { x0, y0, size } = header;
        let finite = 0;
        for (let i = 0, j = 0; i < length; i++, j += 3) {
          const sx = sky[j], sy = sky[j + 1], sz = sky[j + 2];
          const projection = sx * wcs[0] + sy * wcs[1] + sz * wcs[2];
          let pixel = NaN;
          if (projection > 0) {
            const xi = (sx * wcs[3] + sy * wcs[4] + sz * wcs[5]) / projection / RAD;
            const eta = (sx * wcs[6] + sy * wcs[7] + sz * wcs[8]) / projection / RAD;
            const u0 = wcs[9] * xi + wcs[10] * eta;
            const v0 = wcs[11] * xi + wcs[12] * eta;
            let u = u0 + sip(wcs, 35, u0, v0), v = v0 + sip(wcs, 45, u0, v0);
            for (let k = 0; k < 2; k++) {
              const nextU = u0 - sip(wcs, 15, u, v);
              v = v0 - sip(wcs, 25, u, v);
              u = nextU;
            }
            const bx = u + wcs[13] - x0, by = v + wcs[14] - y0;
            if (bx >= 0 && by >= 0 && bx < size - 1 && by < size - 1) {
              const x = Math.floor(bx), y = Math.floor(by);
              const tx = bx - x, ty = by - y, o = y * size + x;
              pixel = pixels[o] * (1 - tx) * (1 - ty) + pixels[o + 1] * tx * (1 - ty)
                + pixels[o + size] * (1 - tx) * ty + pixels[o + size + 1] * tx * ty;
            }
          }
          frames[offset + i] = pixel;
          if (Number.isFinite(pixel)) scratch[finite++] = frames[offset + i];
        }
        if (finite * 2 < length) return false;
        const background = median(scratch, finite);
        for (let i = 0; i < length; i++) frames[offset + i] -= background;
        return true;
      },
      stack(frameCount) {
        const output = new Float32Array(length);
        for (let i = 0; i < length; i++) {
          let count = 0;
          for (let frame = 0; frame < frameCount; frame++) {
            const value = frames[frame * length + i];
            if (Number.isFinite(value)) scratch[count++] = value;
          }
          output[i] = count ? median(scratch, count) : NaN;
        }
        return output;
      },
    };
  };

  export function processSequence(
    sequence: Sequence,
    engine: Engine,
    progress?: (finished: number, total: number) => void,
    onFrame?: (index: number, total: number, frame: Float32Array, count: number, side: number) => void,
  ): AlignedSeries {
    const exposureCapacity = Math.max(...sequence.visits.map((visit) => visit.length));
    let pixelCapacity = 0;
    for (const visit of sequence.visits) {
      for (const exposure of visit) pixelCapacity = Math.max(pixelCapacity, exposure.pixels.length);
    }
    const buffer = engine(sequence.grid, exposureCapacity, pixelCapacity);
    const counts: number[] = [];
    const frames = sequence.visits.map((visit, index) => {
      let count = 0;
      for (const exposure of visit) {
        if (buffer.align(exposure, count)) count++;
      }
      counts.push(count);
      const frame = buffer.stack(count);
      progress?.(index + 1, sequence.visits.length);
      onFrame?.(index, sequence.visits.length, frame, count, sequence.grid.side);
      return frame;
    });
    return { side: sequence.grid.side, frames, counts };
  }

  export function compareSeries(a: AlignedSeries, b: AlignedSeries): { maxError: number; maskMismatch: number } {
    if (a.side !== b.side || a.frames.length !== b.frames.length) throw new Error("Different output dimensions.");
    if (a.counts.some((count, i) => count !== b.counts[i])) throw new Error("Different exposure counts.");
    let maxError = 0;
    let maskMismatch = 0;
    for (let i = 0; i < a.frames.length; i++) {
      const left = a.frames[i], right = b.frames[i];
      for (let j = 0; j < left.length; j++) {
        const leftFinite = Number.isFinite(left[j]), rightFinite = Number.isFinite(right[j]);
        if (leftFinite && rightFinite) maxError = Math.max(maxError, Math.abs(left[j] - right[j]));
        if (leftFinite !== rightFinite) maskMismatch++;
      }
    }
    return { maxError, maskMismatch };
  }
}
