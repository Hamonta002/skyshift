namespace SkyShift {
  export interface Observation {
    id: string;
    collection?: string;
    productKey: string;
    detector: number;
    startMjd: number;
    endMjd: number;
  }

  type Header = Record<string, string | number>;
  const bucket = "https://nasa-irsa-spherex.s3.amazonaws.com/";
  const cropCache = new Map<string, { header: ExposureHeader; pixels: Float32Array }>();
  const cropInflight = new Map<string, Promise<{ header: ExposureHeader; pixels: Float32Array }>>();
  interface WaveGrid { nx: number; ny: number; xs: number[]; ys: number[]; values: Float32Array; }
  const waveCache = new Map<string, WaveGrid>();
  const waveInflight = new Map<string, Promise<WaveGrid>>();
  const cropStore = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("skyshift-crops", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("crops", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Crop cache is blocked."));
  }).catch(() => undefined);
  const fixtureStore = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("skyshift-live-fixtures", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("fixtures", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Fixture cache is blocked."));
  }).catch(() => undefined);

  async function cachedCrop(key: string): Promise<{ header: ExposureHeader; pixels: Float32Array } | undefined> {
    try {
      const db = await cropStore;
      if (!db) return;
      return await new Promise((resolve) => {
        const transaction = db.transaction("crops", "readonly");
        const request = transaction.objectStore("crops").get(key);
        request.onsuccess = () => {
          const row = request.result;
          if (!row || !(row.expires > Date.now()) || !row.header || !row.pixels) {
            resolve(undefined);
            return;
          }
          resolve({
            header: row.header as ExposureHeader,
            pixels: row.pixels instanceof Float32Array ? row.pixels : new Float32Array(row.pixels),
          });
        };
        request.onerror = () => resolve(undefined);
      });
    } catch { return undefined; }
  }

  async function saveCrop(key: string, crop: { header: ExposureHeader; pixels: Float32Array }): Promise<void> {
    try {
      const budget = 48 * 1024 * 1024;
      const size = crop.pixels.byteLength + 1024;
      if (size > budget) return;
      const db = await cropStore;
      if (!db) return;
      await new Promise<void>((resolve) => {
        const transaction = db.transaction("crops", "readwrite");
        const store = transaction.objectStore("crops");
        const existing: { key: IDBValidKey; size: number; saved: number }[] = [];
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (row) {
            if (row.key !== key) existing.push({ key: row.key, size: row.value.size ?? size, saved: row.value.saved ?? 0 });
            row.continue();
            return;
          }
          existing.sort((a, b) => a.saved - b.saved);
          let total = existing.reduce((sum, entry) => sum + entry.size, size);
          for (const entry of existing) {
            if (total <= budget) break;
            store.delete(entry.key);
            total -= entry.size;
          }
          store.put({ key, header: crop.header, pixels: crop.pixels, size, saved: Date.now(), expires: Date.now() + 14 * 86400000 });
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
        transaction.onabort = () => resolve();
      });
    } catch { /* Storage quota should not prevent viewing. */ }
  }

  async function cachedFixture(key: string): Promise<PackedFixture | undefined> {
    try {
      const db = await fixtureStore;
      if (!db) return;
      return await new Promise((resolve) => {
        const transaction = db.transaction("fixtures", "readonly");
        const request = transaction.objectStore("fixtures").get(key);
        request.onsuccess = () => resolve(request.result?.expires > Date.now() ? request.result.fixture : undefined);
        request.onerror = () => resolve(undefined);
      });
    } catch { return undefined; }
  }

  async function saveFixture(key: string, fixture: PackedFixture): Promise<void> {
    try {
      const budget = 32 * 1024 * 1024;
      const size = fixture.pixels.length * 2 + JSON.stringify(fixture.headers).length * 2;
      if (size > budget) return;
      const db = await fixtureStore;
      if (!db) return;
      await new Promise<void>((resolve) => {
        const transaction = db.transaction("fixtures", "readwrite");
        const store = transaction.objectStore("fixtures");
        const existing: { key: IDBValidKey; size: number; saved: number }[] = [];
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (row) {
            if (row.key !== key) existing.push({ key: row.key, size: row.value.size ?? budget, saved: row.value.saved ?? 0 });
            row.continue();
            return;
          }
          existing.sort((a, b) => a.saved - b.saved);
          let total = existing.reduce((sum, entry) => sum + entry.size, size);
          for (const entry of existing) {
            if (total <= budget) break;
            store.delete(entry.key); total -= entry.size;
          }
          store.put({ key, fixture, size, saved: Date.now(), expires: Date.now() + 86400000 });
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
        transaction.onabort = () => resolve();
      });
    } catch { /* Storage quota should not prevent viewing. */ }
  }

  export interface CacheStats {
    memoryCrops: number;
    memoryCropBytes: number;
    waveGrids: number;
    persistentCrops: number;
    persistentCropBytes: number;
    liveFixtures: number;
    liveFixtureBytes: number;
    totalBytes: number;
  }

  export async function cacheDiagnostics(): Promise<CacheStats> {
    let memoryCropBytes = 0;
    for (const item of cropCache.values()) memoryCropBytes += item.pixels.byteLength + 1024;
    let persistentCrops = 0, persistentCropBytes = 0;
    try {
      const db = await cropStore;
      if (db) await new Promise<void>((resolve) => {
        const tx = db.transaction("crops", "readonly");
        const cursor = tx.objectStore("crops").openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) { resolve(); return; }
          persistentCrops++;
          persistentCropBytes += Number(row.value?.size ?? 0);
          row.continue();
        };
        cursor.onerror = () => resolve();
      });
    } catch { /* ignore */ }
    let liveFixtures = 0, liveFixtureBytes = 0;
    try {
      const db = await fixtureStore;
      if (db) await new Promise<void>((resolve) => {
        const tx = db.transaction("fixtures", "readonly");
        const cursor = tx.objectStore("fixtures").openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) { resolve(); return; }
          liveFixtures++;
          liveFixtureBytes += Number(row.value?.size ?? 0);
          row.continue();
        };
        cursor.onerror = () => resolve();
      });
    } catch { /* ignore */ }
    return {
      memoryCrops: cropCache.size,
      memoryCropBytes,
      waveGrids: waveCache.size,
      persistentCrops,
      persistentCropBytes,
      liveFixtures,
      liveFixtureBytes,
      totalBytes: Math.max(memoryCropBytes, persistentCropBytes) + liveFixtureBytes,
    };
  }

  export async function clearBrowserCaches(): Promise<void> {
    cropCache.clear();
    cropInflight.clear();
    waveCache.clear();
    waveInflight.clear();
    const cdb = await cropStore;
    if (cdb) await new Promise<void>((resolve, reject) => {
      const tx = cdb.transaction("crops", "readwrite"); tx.objectStore("crops").clear();
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    const db = await fixtureStore;
    if (db) await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("fixtures", "readwrite"); tx.objectStore("fixtures").clear();
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("skyshift-comparison");
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Cache is open in another tab. Close it and retry."));
    });
  }

  export function parseRetryAfterMs(headerValue: string | null | undefined, fallbackMs: number, nowMs = Date.now()): number {
    if (!headerValue) return fallbackMs;
    const trimmed = headerValue.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.min(15000, Math.max(0, Math.round(Number(trimmed) * 1000)));
    const parsedDate = Date.parse(trimmed);
    if (Number.isFinite(parsedDate)) return Math.min(15000, Math.max(0, parsedDate - nowMs));
    return fallbackMs;
  }

  async function fetchRangeResponse(key: string, rangeHeader: string, signal: AbortSignal): Promise<Response> {
    if (!/^[a-z0-9_]+\/level2\/[a-zA-Z0-9_./-]+\.fits$/.test(key) || key.includes("..")) {
      throw new Error("Invalid archive product key.");
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const response = await fetch(bucket + key, { headers: { Range: rangeHeader }, signal });
      if ((response.status === 429 || response.status === 503) && attempt < 2) {
        const delayMs = parseRetryAfterMs(response.headers?.get("Retry-After"), 1000 * (attempt + 1));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      return response;
    }
    throw new Error("Archive is busy. Try again.");
  }

  async function range(key: string, start: number, end: number, signal: AbortSignal): Promise<ArrayBuffer> {
    const response = await fetchRangeResponse(key, `bytes=${start}-${end}`, signal);
    if (response.status === 429 || response.status === 503) throw new Error("Archive is busy. Try again.");
    if (response.status !== 206) throw new Error(`Archive range request failed: ${response.status}`);
    const contentRange = response.headers.get("Content-Range");
    if (contentRange && !contentRange.startsWith(`bytes ${start}-${end}/`)) throw new Error("Archive returned the wrong byte range.");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== end - start + 1) throw new Error("Archive returned an incomplete range.");
    return bytes;
  }

  function fitsHeader(bytes: Uint8Array, start: number): { values: Header; end: number } {
    const decoder = new TextDecoder("ascii");
    const values: Header = {};
    for (let offset = start; offset + 80 <= bytes.length; offset += 80) {
      const card = decoder.decode(bytes.subarray(offset, offset + 80));
      const key = card.slice(0, 8).trim();
      if (key === "END") return { values, end: Math.ceil((offset + 80) / 2880) * 2880 };
      if (card[8] !== "=") continue;
      const raw = card.slice(10).trim();
      if (raw.startsWith("'")) {
        const match = raw.match(/^'((?:[^']|'')*)'/);
        if (match) values[key] = match[1].replaceAll("''", "'").trim();
      }
      else {
        const number = Number(raw.split("/")[0].trim().replace("D", "E"));
        if (Number.isFinite(number)) values[key] = number;
      }
    }
    throw new Error("FITS header is incomplete.");
  }

  function coefficients(values: Header, prefix: string): Record<string, number> {
    const result: Record<string, number> = {};
    for (let p = 0; p <= 3; p++) for (let q = 0; q <= 3 - p; q++) {
      const value = values[`${prefix}_${p}_${q}`];
      if (typeof value === "number") result[`${p}_${q}`] = value;
    }
    return result;
  }

  export async function fetchExposure(item: Observation, ra: number, dec: number, fov: number, signal: AbortSignal, useCache = true): Promise<{
    header: ExposureHeader; pixels: Float32Array;
  }> {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const cacheKey = `${item.productKey}:${ra}:${dec}:${fov}`;
    if (useCache) {
      const cached = cropCache.get(cacheKey);
      if (cached) return cached;
      const persisted = await cachedCrop(cacheKey);
      if (persisted) {
        if (cropCache.size >= 120) cropCache.delete(cropCache.keys().next().value!);
        cropCache.set(cacheKey, persisted);
        return persisted;
      }
    }
    let pending = cropInflight.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        let image: { values: Header; end: number } | undefined;
        for (let length = 28800; length <= 144000; length += 28800) {
          const bytes = new Uint8Array(await range(item.productKey, 0, length - 1, signal));
          try {
            const primary = fitsHeader(bytes, 0);
            if (primary.values.NAXIS !== 0) throw new Error("Unsupported FITS primary HDU.");
            image = fitsHeader(bytes, primary.end);
            break;
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "FITS header is incomplete.") throw error;
          }
        }
        if (!image) throw new Error("FITS headers exceed the supported size.");
        const h = image.values;
        if (h.EXTNAME !== "IMAGE" || h.BITPIX !== -32 || h.NAXIS1 !== 2040 || h.NAXIS2 !== 2040) {
          throw new Error("Unsupported SPHEREx image layout.");
        }
        if ((h.CTYPE1 !== undefined && h.CTYPE1 !== "RA---TAN-SIP" && h.CTYPE1 !== "RA---TAN")
          || (h.CTYPE2 !== undefined && h.CTYPE2 !== "DEC--TAN-SIP" && h.CTYPE2 !== "DEC--TAN")
          || ["A_ORDER", "B_ORDER", "AP_ORDER", "BP_ORDER"].some((key) => typeof h[key] === "number" && Number(h[key]) > 3)) {
          throw new Error("Unsupported FITS sky projection or SIP order.");
        }
        const n = (key: string, fallback?: number): number => {
          const value = h[key];
          if (typeof value === "number") return value;
          if (fallback !== undefined) return fallback;
          throw new Error(`FITS header missing ${key}.`);
        };
        const half = Math.ceil(fov * 60 / 6.15 * Math.SQRT2 / 2) + 3;
        const header: ExposureHeader = {
          size: 2 * half + 1, x0: 0, y0: 0,
          productKey: item.productKey,
          mjd: n("MJD-AVG", (item.startMjd + item.endMjd) / 2),
          crval: [n("CRVAL1"), n("CRVAL2")], crpix: [n("CRPIX1"), n("CRPIX2")],
          pc: [n("PC1_1", 1), n("PC1_2", 0), n("PC2_1", 0), n("PC2_2", 1)],
          cdelt: [n("CDELT1"), n("CDELT2")],
          a: coefficients(h, "A"), b: coefficients(h, "B"), ap: coefficients(h, "AP"), bp: coefficients(h, "BP"),
        };
        const determinant = header.pc[0] * header.pc[3] - header.pc[1] * header.pc[2];
        if (!header.cdelt[0] || !header.cdelt[1] || !Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
          throw new Error("FITS celestial transform is singular.");
        }
        const [x, y] = worldToPixel(packWcs(header), ra, dec);
        header.x0 = Math.round(x) - half;
        header.y0 = Math.round(y) - half;
        const x0 = Math.max(0, header.x0), y0 = Math.max(0, header.y0);
        const x1 = Math.min(2039, header.x0 + header.size - 1), y1 = Math.min(2039, header.y0 + header.size - 1);
        const pixels = new Float32Array(header.size ** 2).fill(NaN);
        if (x0 > x1 || y0 > y1) return { header, pixels };
        const first = image.end + 4 * (y0 * 2040 + x0);
        const last = image.end + 4 * (y1 * 2040 + x1) + 3;
        const raw = new DataView(await range(item.productKey, first, last, signal));
        const scale = n("BSCALE", 1), zero = n("BZERO", 0);
        for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
          const source = 4 * ((py - y0) * 2040 + px - x0);
          pixels[(py - header.y0) * header.size + px - header.x0] = raw.getFloat32(source, false) * scale + zero;
        }
        const result = { header, pixels };
        if (useCache) {
          if (cropCache.size >= 120) cropCache.delete(cropCache.keys().next().value!);
          cropCache.set(cacheKey, result);
          await saveCrop(cacheKey, result);
        }
        return result;
      })().finally(() => cropInflight.delete(cacheKey));
      cropInflight.set(cacheKey, pending);
    }
    const resolved = await pending;
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    return resolved;
  }

  function waveCacheKey(productKey: string): string {
    const release = /^([a-z0-9_]+)\/level2\//.exec(productKey)?.[1];
    const detMatch = /(?:\/([1-6])\/[^/]+|_D([1-6])_)[^/]*\.fits$/.exec(productKey);
    const detector = detMatch?.[1] ?? detMatch?.[2];
    return release && detector ? `${release}:D${detector}` : productKey;
  }

  async function loadWaveGrid(productKey: string, signal: AbortSignal): Promise<WaveGrid> {
    if (!/^[a-z0-9_]+\/level2\/[a-zA-Z0-9_./-]+\.fits$/.test(productKey) || productKey.includes("..")) {
      throw new Error("Invalid archive product key.");
    }
    const key = waveCacheKey(productKey);
    const cached = waveCache.get(key);
    if (cached) return cached;
    let pending = waveInflight.get(key);
    if (!pending) {
      pending = (async () => {
        const response = await fetchRangeResponse(productKey, "bytes=-5760", signal);
        if (response.status !== 206) throw new Error("Wavelength lookup could not be downloaded.");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== 5760) throw new Error("Unexpected wavelength lookup size.");
        const table = fitsHeader(bytes, 0);
        if (table.values.EXTNAME !== "WCS-WAVE") throw new Error("Unsupported wavelength lookup layout.");
        const nx = parseInt(String(table.values.TFORM1), 10), ny = parseInt(String(table.values.TFORM2), 10);
        if (!(nx >= 2 && ny >= 2 && 4 * (nx + ny) + 8 * nx * ny <= bytes.length - table.end)) {
          throw new Error("Invalid wavelength lookup dimensions.");
        }
        const data = new DataView(bytes.buffer, bytes.byteOffset + table.end);
        const xs = Array.from({ length: nx }, (_, i) => data.getInt32(i * 4, false));
        const ys = Array.from({ length: ny }, (_, i) => data.getInt32((nx + i) * 4, false));
        const base = 4 * (nx + ny);
        const values = new Float32Array(2 * nx * ny);
        for (let i = 0; i < values.length; i++) values[i] = data.getFloat32(base + i * 4, false);
        const grid: WaveGrid = { nx, ny, xs, ys, values };
        waveCache.set(key, grid);
        return grid;
      })().finally(() => waveInflight.delete(key));
      waveInflight.set(key, pending);
    }
    return pending;
  }

  export async function fetchWavelength(header: ExposureHeader, x: number, y: number, signal: AbortSignal): Promise<[number, number]> {
    if (header.wavelength !== undefined && header.bandwidth !== undefined) return [header.wavelength, header.bandwidth];
    if (!header.productKey) throw new Error("Wavelength metadata is unavailable.");
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const grid = await loadWaveGrid(header.productKey, signal);
    const { nx, xs, ys, values } = grid;
    const find = (axis: number[], position: number) => Math.max(0, Math.min(axis.length - 2, axis.findIndex((value) => value >= position) - 1 < 0
      ? (position > axis[axis.length - 1] ? axis.length - 2 : 0) : axis.findIndex((value) => value >= position) - 1));
    const ix = find(xs, x + 1), iy = find(ys, y + 1);
    const tx = (x + 1 - xs[ix]) / (xs[ix + 1] - xs[ix]);
    const ty = (y + 1 - ys[iy]) / (ys[iy + 1] - ys[iy]);
    const v = (px: number, py: number, column: number) => values[2 * (py * nx + px) + column];
    const interpolate = (column: number) => v(ix, iy, column) * (1 - tx) * (1 - ty)
      + v(ix + 1, iy, column) * tx * (1 - ty) + v(ix, iy + 1, column) * (1 - tx) * ty
      + v(ix + 1, iy + 1, column) * tx * ty;
    return [interpolate(0), interpolate(1)];
  }

  const BAND_PASSBANDS: Record<number, [number, number]> = {
    1: [0.75, 1.12],
    2: [1.10, 1.65],
    3: [1.63, 2.43],
    4: [2.40, 3.85],
    5: [3.81, 4.43],
    6: [4.41, 5.01],
  };

  export function frameWavelengthSpan(
    fixture: PackedFixture,
    frame: number,
    frameMode: "visits" | "exposures",
    band?: number,
  ): { min: number; max: number; exact: boolean } | null {
    let headers: ExposureHeader[] = [];
    if (frameMode === "exposures") {
      const h = fixture.headers[frame];
      if (h) headers = [h];
    } else {
      const start = fixture.visitSizes.slice(0, frame).reduce((a, b) => a + b, 0);
      const count = fixture.visitSizes[frame] ?? 0;
      headers = fixture.headers.slice(start, start + count);
    }
    const mins: number[] = [], maxs: number[] = [];
    for (const h of headers) {
      if (h.wavelength !== undefined && Number.isFinite(h.wavelength)) {
        const halfBw = h.bandwidth !== undefined && Number.isFinite(h.bandwidth) ? h.bandwidth / 2 : 0;
        mins.push(h.wavelength - halfBw);
        maxs.push(h.wavelength + halfBw);
      }
    }
    if (mins.length && maxs.length) {
      return { min: Math.min(...mins), max: Math.max(...maxs), exact: true };
    }
    if (band !== undefined && BAND_PASSBANDS[band]) {
      const [min, max] = BAND_PASSBANDS[band];
      return { min, max, exact: false };
    }
    return null;
  }

  function selectLiveVisits(observations: Observation[], fov: number): {
    visits: Observation[][];
    selected: Observation[][];
    perExposureBytes: number;
    maximum: number;
  } {
    // A given exposure can be returned in several collections or reprocessed.
    // Prefer a known newer processing version/date; keep unknown versions distinct.
    const chosen = new Map<string, Observation>();
    for (const item of observations) {
      const match = item.productKey.match(/l2b(?:_retry)?-v(\d+)-(\d{4}-\d{3})/);
      const identity = match && item.id ? `${item.id}:${item.detector}` : item.productKey;
      const previous = chosen.get(identity);
      const old = previous?.productKey.match(/l2b(?:_retry)?-v(\d+)-(\d{4}-\d{3})/);
      if (!previous || (match && old && (Number(match[1]) > Number(old[1])
        || (match[1] === old[1] && match[2] > old[2])))) chosen.set(identity, item);
    }
    const ordered = [...chosen.values()].sort((a, b) => a.startMjd - b.startMjd || a.productKey.localeCompare(b.productKey));
    const visits: Observation[][] = [];
    for (const observation of ordered) {
      const current = visits[visits.length - 1];
      const month = (item: Observation) => new Date((item.startMjd - 40587) * 86400000).toISOString().slice(0, 7);
      const last = current?.[current.length - 1];
      const deepMonthChanged = !!last && (observation.collection?.endsWith("_deep") || last.collection?.endsWith("_deep")) && month(observation) !== month(last);
      if (!current || observation.startMjd - current[current.length - 1].startMjd > 40 || deepMonthChanged) visits.push([observation]);
      else current.push(observation);
    }
    const perExposureBytes = 28800 + Math.ceil(fov * 60 / 6.15 * Math.SQRT2 + 6) * 8160;
    const maximum = Math.max(1, Math.min(60, Math.floor(32 * 1024 * 1024 / perExposureBytes)));
    if (!visits.length) return { visits: [], selected: [], perExposureBytes, maximum };
    const keptVisits = visits.length <= maximum
      ? visits
      : maximum === 1
        ? [visits[0]]
        : Array.from({ length: maximum }, (_, i) => visits[Math.round(i * (visits.length - 1) / (maximum - 1))]);
    const perVisit = Math.max(1, Math.floor(maximum / keptVisits.length));
    const selected = keptVisits.map((visit) => visit.filter((_, i) => i % Math.max(1, Math.ceil(visit.length / perVisit)) === 0).slice(0, perVisit));
    return { visits, selected, perExposureBytes, maximum };
  }

  export function estimateDownloadBytes(observations: Observation[], fov: number): {
    perExposureBytes: number;
    selectedExposures: number;
    totalVisits: number;
    keptVisits: number;
    totalBytes: number;
    maximumExposures: number;
  } {
    const { visits, selected, perExposureBytes, maximum } = selectLiveVisits(observations, fov);
    if (!observations.length) {
      const typicalExposures = Math.min(30, maximum);
      return {
        perExposureBytes,
        selectedExposures: typicalExposures,
        totalVisits: 3,
        keptVisits: Math.min(3, maximum),
        totalBytes: typicalExposures * perExposureBytes,
        maximumExposures: maximum,
      };
    }
    const selectedExposures = selected.reduce((sum, visit) => sum + visit.length, 0);
    return {
      perExposureBytes,
      selectedExposures,
      totalVisits: visits.length,
      keptVisits: selected.length,
      totalBytes: selectedExposures * perExposureBytes,
      maximumExposures: maximum,
    };
  }

  export async function makeLiveFixture(
    observations: Observation[], ra: number, dec: number, fov: number,
    signal: AbortSignal, progress: (done: number, total: number) => void, useCache = true,
  ): Promise<PackedFixture> {
    const { visits, selected } = selectLiveVisits(observations, fov);
    if (!visits.length) throw new Error("No observations cover this field.");
    const cacheKey = JSON.stringify({ version: 1, ra, dec, fov, inputs: selected.map((visit) => visit.map((item) => item.productKey)) });
    const saved = useCache ? await cachedFixture(cacheKey) : undefined;
    if (saved) return saved;
    const total = selected.reduce((sum, visit) => sum + visit.length, 0);
    const results: { header: ExposureHeader; pixels: Float32Array }[][] = selected.map((visit) => new Array(visit.length));
    const jobs = selected.flatMap((visit, visitIndex) => visit.map((item, frameIndex) => ({ item, visitIndex, frameIndex })));
    let done = 0;
    let next = 0;
    const download = async () => {
      while (next < jobs.length) {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const job = jobs[next++];
        results[job.visitIndex][job.frameIndex] = await fetchExposure(job.item, ra, dec, fov, signal, useCache);
        progress(++done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, download));
    if (results.some((visit) => visit.length === 0)) throw new Error("A visit could not be downloaded. Try again.");
    const flat = results.flat();
    const bytes = new Uint8Array(flat.reduce((sum, item) => sum + item.pixels.byteLength, 0));
    const data = new DataView(bytes.buffer);
    let offset = 0;
    for (const item of flat) for (const pixel of item.pixels) { data.setFloat32(offset, pixel, true); offset += 4; }
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    const dates = selected.map((visit) => new Date((visit[0].startMjd - 40587) * 86400000).toISOString().slice(0, 10));
    const metadata = new TextEncoder().encode(JSON.stringify({ ra, dec, fov, selected: selected.map((visit) => visit.map((item) => item.productKey)) }));
    const hashInput = new Uint8Array(metadata.length + bytes.length);
    hashInput.set(metadata);
    hashInput.set(bytes, metadata.length);
    const digest = await crypto.subtle.digest("SHA-256", hashInput);
    const id = Array.from(new Uint8Array(digest).slice(0, 12), (v) => v.toString(16).padStart(2, "0")).join("");
    const fixture = { id, ra0: ra, dec0: dec, half: Math.ceil(fov * 30 / 3.075), scale: 3.075, dates,
      visitSizes: results.map((visit) => visit.length), headers: flat.map((item) => item.header), pixels: btoa(binary) };
    if (useCache) await saveFixture(cacheKey, fixture);
    return fixture;
  }
}
