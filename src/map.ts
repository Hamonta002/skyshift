namespace SkyShift {
  /**
   * Sky-map camera. `z` is log2(CSS px per grid pixel of the loaded field), so
   * whole-number levels keep the SPHEREx pixel edges on whole CSS pixels.
   */
  export interface Camera { ra: number; dec: number; z: number }

  export const MAP_DEFAULT_ZOOM = 3;
  // Keep a loaded cutout legible even when the user zooms well away from it.
  // At z=-1 the field still occupies half its native pixel dimensions.
  export const MAP_MIN_ZOOM = -1;
  export const MAP_MAX_ZOOM = 6;
  const DEG = Math.PI / 180;
  const ARCSEC = Math.PI / 648000;

  export function clampZoom(z: number): number {
    return Math.min(MAP_MAX_ZOOM, Math.max(MAP_MIN_ZOOM, z));
  }

  /** CSS px per arcsecond for zoom level `z` on a grid of `gridScale` arcsec/px. */
  export function pxPerArcsec(z: number, gridScale: number): number {
    return 2 ** z / gridScale;
  }

  export function normalizeRa(ra: number): number {
    const value = ra % 360;
    return value < 0 ? value + 360 : value;
  }

  /**
   * Gnomonic projection about the camera centre: north up, east left, in CSS px
   * offsets from the centre of the visible map. Returns null behind the plane.
   */
  export function project(camera: Camera, ra: number, dec: number, k: number): [number, number] | null {
    const d0 = camera.dec * DEG, d = dec * DEG, da = (ra - camera.ra) * DEG;
    const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da);
    if (cosc <= 1e-9) return null;
    const xi = Math.cos(d) * Math.sin(da) / cosc;
    const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) / cosc;
    return [-xi / ARCSEC * k, -eta / ARCSEC * k];
  }

  export function unproject(camera: Camera, dx: number, dy: number, k: number): [number, number] {
    const xi = -dx / k * ARCSEC, eta = -dy / k * ARCSEC;
    const rho = Math.hypot(xi, eta);
    if (rho === 0) return [normalizeRa(camera.ra), camera.dec];
    const c = Math.atan(rho), d0 = camera.dec * DEG;
    const dec = Math.asin(Math.max(-1, Math.min(1, Math.cos(c) * Math.sin(d0) + eta * Math.sin(c) * Math.cos(d0) / rho)));
    const ra = camera.ra * DEG + Math.atan2(xi * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - eta * Math.sin(d0) * Math.sin(c));
    return [normalizeRa(ra / DEG), dec / DEG];
  }

  /** Moves the sky with a drag of (dx, dy) CSS px. */
  export function panBy(camera: Camera, dx: number, dy: number, k: number): Camera {
    const [ra, dec] = unproject(camera, -dx, -dy, k);
    return { ra, dec, z: camera.z };
  }

  /**
   * Moves the camera so that sky position (ra, dec) appears at screen offset
   * (ax, ay); drags use this to keep the grabbed point under the pointer.
   * Solves the inverse gnomonic equations for the camera centre directly:
   * sin δ = cos c · sin δ0 + (η/ρ) sin c · cos δ0 gives δ0 (taking the root
   * nearest the current camera), then α0 follows. With north kept up, a point
   * near a pole cannot always be placed; the nearest valid centre is used.
   */
  export function placeAt(camera: Camera, ra: number, dec: number, ax: number, ay: number, k: number): Camera {
    const xi = -ax / k * ARCSEC, eta = -ay / k * ARCSEC;
    const rho = Math.hypot(xi, eta);
    if (rho === 0) return { ra: normalizeRa(ra), dec, z: camera.z };
    const c = Math.atan(rho), A = Math.cos(c), B = eta / rho * Math.sin(c);
    const R = Math.hypot(A, B), phi = Math.atan2(B, A);
    const s = Math.asin(Math.max(-1, Math.min(1, Math.sin(dec * DEG) / R)));
    const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
    const roots = [wrap(s - phi), wrap(Math.PI - s - phi)].filter((root) => Math.abs(root) <= Math.PI / 2 + 1e-12);
    const current = camera.dec * DEG;
    const d0 = roots.length
      ? roots.reduce((best, root) => Math.abs(root - current) < Math.abs(best - current) ? root : best)
      : Math.max(-Math.PI / 2, Math.min(Math.PI / 2, wrap(s - phi)));
    const ra0 = ra * DEG - Math.atan2(xi * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - eta * Math.sin(d0) * Math.sin(c));
    return { ra: normalizeRa(ra0 / DEG), dec: Math.max(-90, Math.min(90, d0 / DEG)), z: camera.z };
  }

  /** Changes zoom while the sky under the screen offset (ax, ay) stays put. */
  export function zoomAt(camera: Camera, z: number, ax: number, ay: number, gridScale: number): Camera {
    const target = clampZoom(z);
    const [ra, dec] = unproject(camera, ax, ay, pxPerArcsec(camera.z, gridScale));
    return placeAt({ ...camera, z: target }, ra, dec, ax, ay, pxPerArcsec(target, gridScale));
  }

  /** Angular distance in arcseconds. */
  export function separation(ra1: number, dec1: number, ra2: number, dec2: number): number {
    const a = Math.sin((dec2 - dec1) * DEG / 2) ** 2
      + Math.cos(dec1 * DEG) * Math.cos(dec2 * DEG) * Math.sin((ra2 - ra1) * DEG / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / ARCSEC;
  }

  export interface FieldGeometry { ra0: number; dec0: number; half: number; scale: number }

  /**
   * Affine canvas transform [a, b, c, d, e, f] that maps field-bitmap pixel
   * coordinates (north up, east left, as painted) to screen offsets from the
   * map centre. Derived from the field's own TAN plane, so it stays correct for
   * an off-centre camera and at high declination.
   */
  export function fieldTransform(camera: Camera, field: FieldGeometry, k: number): [number, number, number, number, number, number] | null {
    const plane: Camera = { ra: field.ra0, dec: field.dec0, z: 0 };
    const centre = field.half + 0.5;
    // Bitmap (u, v) -> field-plane offset in px of 1″ so unproject gets arcsec.
    const at = (u: number, v: number) => {
      const east = (centre - u) * field.scale, north = (centre - v) * field.scale;
      const [ra, dec] = unproject(plane, -east, -north, 1);
      return project(camera, ra, dec, k);
    };
    const step = Math.max(1, field.half);
    const o = at(centre, centre), du = at(centre + step, centre), dv = at(centre, centre + step);
    if (!o || !du || !dv) return null;
    const a = (du[0] - o[0]) / step, b = (du[1] - o[1]) / step;
    const c = (dv[0] - o[0]) / step, d = (dv[1] - o[1]) / step;
    return [a, b, c, d, o[0] - a * centre - c * centre, o[1] - b * centre - d * centre];
  }

  const DEC_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000, 36000];
  const RA_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
  export const GRID_MIN_SPACING = 80;

  /** Grid steps: declination in arcsec, right ascension in seconds of time. */
  export function graticuleSteps(k: number, dec: number): { dec: number; ra: number } {
    const cos = Math.max(Math.cos(dec * DEG), 1e-3);
    const decStep = DEC_STEPS.find((s) => s * k >= GRID_MIN_SPACING) ?? DEC_STEPS.at(-1)!;
    const raStep = RA_STEPS.find((s) => s * 15 * cos * k >= GRID_MIN_SPACING) ?? RA_STEPS.at(-1)!;
    return { dec: decStep, ra: raStep };
  }

  /** Nice scale-bar length in arcsec whose bar is at most `maxPx` wide. */
  export function scaleBar(k: number, maxPx = 110): { arcsec: number; px: number; label: string } {
    const choices = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000];
    const arcsec = [...choices].reverse().find((s) => s * k <= maxPx) ?? choices[0];
    const label = arcsec >= 3600 ? `${arcsec / 3600}°` : arcsec >= 60 ? `${arcsec / 60}′` : `${arcsec}″`;
    return { arcsec, px: arcsec * k, label };
  }

  function sexagesimal(value: number, decimals: number): [number, number, number] {
    const factor = 10 ** decimals;
    const total = Math.round(Math.abs(value) * 3600 * factor) / factor;
    const units = Math.floor(total / 3600);
    const minutes = Math.floor((total - units * 3600) / 60);
    return [units, minutes, Math.round((total - units * 3600 - minutes * 60) * factor) / factor];
  }
  const pad = (n: number, decimals = 0) => n.toFixed(decimals).padStart(decimals ? decimals + 3 : 2, "0");

  /** RA in hours; `stepSeconds` (time) trims the label to the grid precision. */
  export function formatRa(ra: number, stepSeconds = 0.1): string {
    const decimals = stepSeconds >= 1 ? 0 : stepSeconds >= 0.1 ? 1 : 2;
    const [h, m, s] = sexagesimal(normalizeRa(ra) / 15, decimals);
    const hours = h % 24;
    if (stepSeconds >= 3600 && m === 0 && s === 0) return `${hours}h`;
    if (stepSeconds >= 60 && s === 0) return `${hours}h${pad(m)}m`;
    return `${hours}h${pad(m)}m${pad(s, decimals)}s`;
  }

  /** Declination; `stepArcsec` trims the label to the grid precision. */
  export function formatDec(dec: number, stepArcsec = 1): string {
    const decimals = stepArcsec >= 1 ? 0 : 1;
    const [d, m, s] = sexagesimal(dec, decimals);
    const sign = dec < 0 && (d || m || s) ? "−" : "+";
    if (stepArcsec >= 3600 && m === 0 && s === 0) return `${sign}${d}°`;
    if (stepArcsec >= 60 && s === 0) return `${sign}${d}°${pad(m)}′`;
    return `${sign}${d}°${pad(m)}′${pad(s, decimals)}″`;
  }

  /** Google-Maps-style `at=ra,dec,z` view parameter. */
  export function parseAt(value: string | null): Camera | null {
    if (!value) return null;
    const parts = value.split(",").map(Number);
    if (parts.length !== 3 || !parts.every(Number.isFinite)) return null;
    const [ra, dec, z] = parts;
    if (ra < 0 || ra > 360 || dec < -90 || dec > 90) return null;
    return { ra: normalizeRa(ra), dec, z: clampZoom(z) };
  }

  export function formatAt(camera: Camera): string {
    return `${camera.ra.toFixed(6)},${camera.dec.toFixed(6)},${(Math.round(camera.z * 100) / 100).toString()}`;
  }

  export interface SearchOptionsState {
    band: number;
    fov: number;
    from: string;
    to: string;
  }

  export function searchOptionsDiffer(a: SearchOptionsState, b: SearchOptionsState): boolean {
    return a.band !== b.band || a.fov !== b.fov || a.from !== b.from || a.to !== b.to;
  }

  export function searchTimeBounds(
    from = "",
    to = "",
    asof?: string,
    endMjd?: number,
    nowMs = Date.now(),
  ): { fromMjd: number; toMjd: number; cutoffMs: number } {
    const cutoffMs = asof ? Date.parse(asof) : nowMs;
    if (!Number.isFinite(cutoffMs) || cutoffMs > nowMs + 86400000) throw new Error("The shared cutoff date is invalid.");
    const startMs = from ? Date.parse(`${from}T00:00:00Z`) : (60789 - 40587) * 86400000;
    const endMs = endMjd !== undefined ? Math.min((endMjd - 40587) * 86400000, cutoffMs)
      : to ? Math.min(Date.parse(`${to}T23:59:59Z`), cutoffMs) : cutoffMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
      throw new Error("The date range starts after the observation cutoff.");
    }
    return {
      fromMjd: startMs / 86400000 + 40587,
      toMjd: endMs / 86400000 + 40587,
      cutoffMs,
    };
  }

  export function parseWaveRange(minRaw: string | null, maxRaw: string | null): [number, number] | null {
    if (minRaw === null || maxRaw === null || minRaw.trim() === "" || maxRaw.trim() === "") return null;
    const min = Number(minRaw), max = Number(maxRaw);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    return [min, max];
  }

  /** Legacy `zoom=1|2|4` (Fit multipliers) maps onto map levels. */
  export function legacyZoom(value: string | null): number | null {
    const zoom = Number(value);
    return [1, 2, 4].includes(zoom) ? MAP_DEFAULT_ZOOM + Math.log2(zoom) : null;
  }
}
