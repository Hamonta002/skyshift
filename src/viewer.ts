declare const ASSETS: {
  fixture: SkyShift.PackedFixture;
  wasm: string;
  worker: string;
  toolchain: string;
  examples: string[];
};

(() => {
  const get = <T extends HTMLElement>(id: string) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing viewer control: ${id}`);
    return node as T;
  };
  const engineSelect = get<HTMLSelectElement>("engine");
  const cacheSelect = get<HTMLSelectElement>("cache");
  const modeSelect = get<HTMLSelectElement>("mode");
  const referenceSelect = get<HTMLSelectElement>("reference-frame");
  const comparisonSelect = get<HTMLSelectElement>("comparison-frame");
  const blink = get<HTMLButtonElement>("blink");
  const difference = get<HTMLButtonElement>("difference");
  const mapCanvas = get<HTMLCanvasElement>("map");
  const mapContext = mapCanvas.getContext("2d")!;
  const fieldCanvas = document.createElement("canvas");
  const fieldContext = fieldCanvas.getContext("2d")!;
  const panel = get("panel");
  const menuButton = get<HTMLButtonElement>("menu");
  const query = get<HTMLInputElement>("query");
  const bandSelect = get<HTMLSelectElement>("band");
  const fovSelect = get<HTMLSelectElement>("fov");
  const gridToggle = get<HTMLInputElement>("grid");
  const observation = get("observation");
  const marker = get<HTMLInputElement>("marker");
  const status = get("status");
  const toast = get("toast");
  const cancel = get<HTMLButtonElement>("cancel");
  const next = get<HTMLButtonElement>("next");
  const previous = get<HTMLButtonElement>("previous");
  const play = get<HTMLButtonElement>("play");
  const hint = get("hint");
  const shortcuts = get<HTMLDialogElement>("shortcuts");
  let visits = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-visit]"));
  const benchmark = get("benchmark");
  const benchmarkOutput = get("benchmark-output");
  const run = get<HTMLButtonElement>("run-benchmark");
  const scenarioSelect = get<HTMLSelectElement>("scenario");
  const stretchInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="stretch"]'));
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let series: SkyShift.AlignedSeries | undefined;
  let stretch = { low: 0, high: 1 };
  let frame = 0;
  let timer: number | undefined;
  let playback: "visits" | "blink" | undefined;
  let pairSequence: string | undefined;
  let busy = false;
  let worker: Worker | undefined;
  let interrupt: (() => void) | undefined;
  let workerURL: string | undefined;
  let fixture = ASSETS.fixture;
  let fullBandFixture = ASSETS.fixture;
  let wavelengthSelection: { min: number; max: number } | null = null;
  let searchController: AbortController | undefined;
  let isBundled = true;
  let currentSelection: { ra: number; dec: number; band: number; fov: number; from?: string; to?: string; asof?: string } | undefined;
  let currentPixels: Float32Array | undefined;
  let currentTargetId: string | undefined = "wise0855";
  type CatalogueSource = SkyShift.CatalogueSource;
  const catalogues: Record<string, CatalogueSource[]> = {};

  // Map camera and screen geometry. The projection centre is the middle of the
  // viewport; `visible` is the part of the map not covered by floating chrome.
  let camera: SkyShift.Camera = { ra: fixture.ra0, dec: fixture.dec0, z: SkyShift.MAP_DEFAULT_ZOOM };
  let cameraIsDefault = true;
  const screen = { width: innerWidth, height: innerHeight, dpr: 1 };
  const visible = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  let pointerAt: [number, number] | null = null;
  let selected: { ra: number; dec: number } | null = null;
  let zoomAnimation = 0;
  let zoomGoal: number | null = null; // target level of a running zoom animation
  function stopZoomAnimation(): void {
    cancelAnimationFrame(zoomAnimation);
    zoomGoal = null;
  }

  const params = new URLSearchParams(location.search);
  const requestedEngine = params.get("engine");
  if (requestedEngine === "rust" || requestedEngine === "typescript") engineSelect.value = requestedEngine;
  const requestedCache = params.get("cache");
  if (requestedCache === "results" || requestedCache === "inputs" || requestedCache === "none") {
    cacheSelect.value = requestedCache;
  }
  const initialFrame = Number(params.get("frame") ?? (params.has("ra") ? 1 : 2)) - 1;
  frame = Number.isInteger(initialFrame) && initialFrame >= 0 ? initialFrame : 0;
  const requestedMode = params.get("view") === "diff" ? "difference" : params.get("view");
  if (requestedMode && ["stack", "sum", "difference", "exposures", "blink"].includes(requestedMode)) modeSelect.value = requestedMode;
  const stretchValue = () => stretchInputs.find((input) => input.checked)?.value ?? "balanced";
  const requestedStretch = params.get("stretch");
  if (requestedStretch && ["balanced", "faint", "linear"].includes(requestedStretch)) {
    for (const input of stretchInputs) input.checked = input.value === requestedStretch;
  }
  const restoredCamera = SkyShift.parseAt(params.get("at"));
  const legacyLevel = SkyShift.legacyZoom(params.get("zoom"));
  const embed = params.get("embed") === "1";
  if (embed) document.body.classList.add("embed");
  const sharedView = ["ra", "a", "b", "view", "frame", "at", "zoom", "waveMin"].some((key) => params.has(key));

  function canCompare(): boolean {
    return !!series && series.frames.length > 1 && referenceSelect.value !== comparisonSelect.value;
  }

  let lastBusy = false;
  let routineStatus = "";
  function updateControls(): void {
    const unavailable = busy || !series;
    for (const button of [next, previous, play]) button.disabled = unavailable || (series?.frames.length ?? 0) < 2;
    for (const button of visits) button.disabled = unavailable;
    for (const select of [referenceSelect, comparisonSelect]) select.disabled = unavailable || (series?.frames.length ?? 0) < 2;
    modeSelect.disabled = unavailable;
    blink.disabled = unavailable || !canCompare() || modeSelect.value === "exposures";
    difference.disabled = blink.disabled;
    get("compare-hint").textContent = modeSelect.value === "exposures" ? "Switch to visit stacks to compare visits." : canCompare() ? ""
      : (series?.frames.length ?? 0) < 2 ? "Two observations are needed to compare." : "Choose two different observations.";
    engineSelect.disabled = busy;
    cacheSelect.disabled = busy;
    run.disabled = busy;
    scenarioSelect.disabled = busy;
    cancel.hidden = !busy;
    if (busy !== lastBusy) { lastBusy = busy; showToast(); }
    updateSearchArea();
  }

  // URL writes wait for the first load, so a shared link survives a reload mid-load.
  let ready = false;
  function saveState(): void {
    if (!ready) return;
    const url = new URL(location.href);
    url.searchParams.set("engine", engineSelect.value);
    url.searchParams.set("cache", cacheSelect.value);
    url.searchParams.set("frame", String(frame + 1));
    url.searchParams.set("view", modeSelect.value);
    if (referenceSelect.value !== "") url.searchParams.set("a", String(Number(referenceSelect.value) + 1));
    if (comparisonSelect.value !== "") url.searchParams.set("b", String(Number(comparisonSelect.value) + 1));
    url.searchParams.delete("reference");
    url.searchParams.delete("zoom");
    if (cameraIsDefault) url.searchParams.delete("at");
    else url.searchParams.set("at", SkyShift.formatAt(camera));
    url.searchParams.set("stretch", stretchValue());
    if (wavelengthSelection) {
      url.searchParams.set("waveMin", String(wavelengthSelection.min));
      url.searchParams.set("waveMax", String(wavelengthSelection.max));
    } else { url.searchParams.delete("waveMin"); url.searchParams.delete("waveMax"); }
    if (currentSelection) {
      url.searchParams.delete("from"); url.searchParams.delete("to");
      for (const [key, value] of Object.entries(currentSelection)) url.searchParams.set(key, String(value));
    } else for (const key of ["ra", "dec", "band", "fov", "from", "to", "asof"]) url.searchParams.delete(key);
    // Keep the map position readable, Google-Maps style: at=ra,dec,zoom.
    url.search = url.searchParams.toString().replace(/(^|&)at=([^&]*)/, (_, lead: string, value: string) => `${lead}at=${decodeURIComponent(value)}`);
    try { history.replaceState(null, "", url); } catch { /* File previews can restrict history. */ }
  }
  let saveTimer: number | undefined;
  function scheduleSave(): void {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveState, 400);
  }

  function updateStretch(data: SkyShift.AlignedSeries): void {
    const pixels = data.frames.flatMap((image) => Array.from(image).filter(Number.isFinite)).sort((a, b) => a - b);
    if (pixels.length) {
      stretch = {
        low: pixels[Math.floor((pixels.length - 1) * 0.08)],
        high: pixels[Math.floor((pixels.length - 1) * 0.997)],
      };
    }
  }

  function paint(target: HTMLCanvasElement, ctx: CanvasRenderingContext2D, pixels: Float32Array, side: number, view: string): number {
    if (target.width !== side || target.height !== side) target.width = target.height = side;
    const bitmap = ctx.createImageData(side, side);
    let limit = 1e-6;
    if (view === "difference") {
      for (const value of pixels) if (Number.isFinite(value)) limit = Math.max(limit, Math.abs(value));
    }
    const displayFactor = view === "sum" ? 2 : 1;
    const span = Math.max((stretch.high - stretch.low) * displayFactor, 1e-6);
    const preset = stretchValue();
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const value = pixels[(side - y - 1) * side + x];
        const index = (y * side + x) * 4;
        if (!Number.isFinite(value)) {
          const hatch = (x + y) % 4 === 0 ? 29 : 17;
          bitmap.data[index] = hatch;
          bitmap.data[index + 1] = hatch + 3;
          bitmap.data[index + 2] = hatch + 8;
        } else {
          if (view === "difference") {
            const mix = Math.min(1, Math.abs(value) / limit);
            const end = value < 0 ? [102, 172, 255] : [255, 154, 117];
            for (let c = 0; c < 3; c++) bitmap.data[index + c] = Math.round(25 + (end[c] - 25) * mix);
          } else {
            const x = Math.max(0, Math.min(1, (value - stretch.low * displayFactor) / span));
            const gain = preset === "faint" ? 64 : 16;
            const light = Math.round((preset === "linear" ? x : Math.asinh(x * gain) / Math.asinh(gain)) * 242);
            bitmap.data[index] = light;
            bitmap.data[index + 1] = light;
            bitmap.data[index + 2] = Math.min(255, light + 4);
          }
        }
        bitmap.data[index + 3] = 255;
      }
    }
    ctx.putImageData(bitmap, 0, 0);
    return limit;
  }

  const fieldSide = () => 2 * fixture.half + 1;
  const fieldName = () => get("target").textContent ?? "Field";
  function arithmeticView(): boolean {
    return canCompare() && (modeSelect.value === "sum" || modeSelect.value === "difference");
  }
  function frameMjd(): number | undefined {
    const index = modeSelect.value === "exposures" ? frame : fixture.visitSizes.slice(0, frame).reduce((a, b) => a + b, 0);
    return fixture.headers[index]?.mjd;
  }

  function draw(): void {
    if (!series || !series.frames.length) return;
    const side = series.side;
    const a = Number(referenceSelect.value), b = Number(comparisonSelect.value);
    const view = canCompare() ? modeSelect.value : "stack";
    const arithmetic = view === "sum" || view === "difference";
    const pixels = arithmetic ? SkyShift.combineFrames(series.frames[a], series.frames[b], view) : series.frames[frame];
    currentPixels = pixels;
    const limit = paint(fieldCanvas, fieldContext, pixels, side, view);
    const differenceScale = get("difference-scale");
    differenceScale.hidden = view !== "difference";
    if (view === "difference") {
      get("difference-negative").textContent = `−${limit.toPrecision(2)}`;
      get("difference-positive").textContent = `+${limit.toPrecision(2)}`;
    }
    difference.setAttribute("aria-pressed", String(view === "difference"));
    const count = series.counts[frame];
    const shallow = count < 5 && modeSelect.value !== "exposures";
    observation.textContent = arithmetic
      ? `${view === "difference" ? "Visual difference B − A" : "Visual sum A + B"} · A ${labelFor(a)} · B ${labelFor(b)}`
      : `${labelFor(frame)} · ${count} ${count === 1 ? "exposure" : "exposures"}${shallow ? " · Shallow frame" : ""}`;
    const slot = get("active-slot");
    slot.textContent = view === "blink" ? (frame === a ? "A" : frame === b ? "B" : "") : "";
    slot.hidden = slot.textContent === "";
    fieldDateText = arithmetic
      ? (view === "difference" ? `B − A · ${labelFor(b)} − ${labelFor(a)}` : `A + B · ${labelFor(a)} + ${labelFor(b)}`)
      : `${labelFor(frame)} · ${count} exp${shallow ? " · shallow" : ""}`;
    get("inspect-frame").textContent = observation.textContent;
    get("bundled-provenance").hidden = !isBundled;
    get("attribution-provenance").hidden = !isBundled;
    mapCanvas.setAttribute("aria-label", `Sky map showing ${fieldName()}, north up, east left. ${observation.textContent}`);
    visits.forEach((button, index) => {
      button.setAttribute("aria-pressed", String(!arithmetic && index === frame));
      button.tabIndex = index === Math.min(frame, visits.length - 1) ? 0 : -1;
    });
    refreshHere();
    render();
  }

  function commitView(): void {
    draw();
    updateControls();
    saveState();
  }

  // ---------------------------------------------------------------- map ----
  const scaleNow = () => SkyShift.pxPerArcsec(camera.z, fixture.scale);
  const visibleCentre = (): [number, number] => [(visible.left + visible.right) / 2, (visible.top + visible.bottom) / 2];
  function toScreen(ra: number, dec: number, k = scaleNow()): [number, number] | null {
    const p = SkyShift.project(camera, ra, dec, k);
    return p && [p[0] + screen.width / 2, p[1] + screen.height / 2];
  }
  function toSky(x: number, y: number, k = scaleNow()): [number, number] {
    return SkyShift.unproject(camera, x - screen.width / 2, y - screen.height / 2, k);
  }
  function formatAngle(arcsec: number): string {
    return arcsec >= 3600 ? `${(arcsec / 3600).toFixed(arcsec >= 36000 ? 0 : 1)}°` : arcsec >= 60 ? `${(arcsec / 60).toFixed(arcsec >= 600 ? 0 : 1)}′` : `${arcsec.toFixed(0)}″`;
  }

  let renderQueued = 0;
  function render(): void {
    if (renderQueued) return;
    renderQueued = requestAnimationFrame(() => { renderQueued = 0; renderNow(); });
  }

  function renderNow(): void {
    const { width: W, height: H, dpr } = screen;
    const k = scaleNow();
    const ctx = mapContext;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#05080f";
    ctx.fillRect(0, 0, W, H);
    if (gridToggle.checked) drawGraticule(ctx, W, H, k);
    const corners = drawField(ctx, k);
    drawMarkers(ctx, k);
    placeFieldChrome(corners);
    const bar = SkyShift.scaleBar(k);
    get("scale-line").style.width = `${bar.px}px`;
    get("scale-label").textContent = bar.label;
    updateReadout();
  }

  function strokeLine(ctx: CanvasRenderingContext2D, points: ([number, number] | null)[]): void {
    ctx.beginPath();
    let open = false;
    for (const point of points) {
      if (!point) { open = false; continue; }
      if (open) ctx.lineTo(point[0], point[1]); else ctx.moveTo(point[0], point[1]);
      open = true;
    }
    ctx.stroke();
  }
  /** Where a sampled line crosses a screen coordinate (x when `axis` is 0). */
  function crossing(points: ([number, number] | null)[], axis: 0 | 1, at: number): [number, number] | null {
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1], q = points[i];
      if (!p || !q || (p[axis] - at) * (q[axis] - at) > 0 || p[axis] === q[axis]) continue;
      const t = (at - p[axis]) / (q[axis] - p[axis]);
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    }
    return null;
  }

  function drawGraticule(ctx: CanvasRenderingContext2D, W: number, H: number, k: number): void {
    const steps = SkyShift.graticuleSteps(k, camera.dec);
    let decMin = 90, decMax = -90, offMin = 180, offMax = -180;
    const n = 12;
    for (let i = 0; i <= n; i++) {
      for (const [x, y] of [[W * i / n, 0], [W * i / n, H], [0, H * i / n], [W, H * i / n]]) {
        const [ra, dec] = toSky(x, y, k);
        decMin = Math.min(decMin, dec); decMax = Math.max(decMax, dec);
        const offset = ((ra - camera.ra + 540) % 360) - 180;
        offMin = Math.min(offMin, offset); offMax = Math.max(offMax, offset);
      }
    }
    const inside = (p: [number, number] | null) => !!p && p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H;
    const pole = inside(toScreen(0, 90, k)) ? 1 : inside(toScreen(0, -90, k)) ? -1 : 0;
    if (pole === 1) { decMax = 90; offMin = -180; offMax = 180; }
    if (pole === -1) { decMin = -90; offMin = -180; offMax = 180; }
    const decStep = steps.dec / 3600, raStep = steps.ra / 240;
    const samples = pole ? 120 : 40;
    const labelX = visible.left + 10, labelY = visible.top + 8;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(128, 156, 205, 0.17)";
    ctx.fillStyle = "rgba(176, 194, 228, 0.66)";
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    const d0 = Math.ceil(decMin / decStep), d1 = Math.floor(decMax / decStep);
    if (d1 - d0 <= 300) for (let i = d0; i <= d1; i++) {
      const dec = i * decStep;
      if (Math.abs(dec) >= 90) continue;
      const points = Array.from({ length: samples + 1 }, (_, s) => toScreen(camera.ra + offMin + (offMax - offMin) * s / samples, dec, k));
      strokeLine(ctx, points);
      const at = crossing(points, 0, labelX);
      if (at && at[1] > visible.top + 22 && at[1] < visible.bottom - 30) {
        ctx.textAlign = "left"; ctx.textBaseline = "bottom";
        ctx.fillText(SkyShift.formatDec(dec, steps.dec), labelX, at[1] - 3);
      }
    }
    const r0 = Math.ceil((camera.ra + offMin) / raStep), r1 = Math.floor((camera.ra + offMax) / raStep);
    const top = Math.min(decMax, 89.9999), bottom = Math.max(decMin, -89.9999);
    if (r1 - r0 <= 300) for (let i = r0; i <= r1; i++) {
      const ra = i * raStep;
      if (pole && i - r0 >= Math.round(360 / raStep)) break;
      const points = Array.from({ length: samples + 1 }, (_, s) => toScreen(ra, bottom + (top - bottom) * s / samples, k));
      strokeLine(ctx, points);
      const at = crossing(points, 1, labelY);
      if (at && at[0] > visible.left + 70 && at[0] < visible.right - 60) {
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.fillText(SkyShift.formatRa(ra, steps.ra), at[0] + 4, labelY);
      }
    }
  }

  function drawField(ctx: CanvasRenderingContext2D, k: number): [number, number][] | null {
    const t = SkyShift.fieldTransform(camera, fixture, k);
    if (!t) return null;
    const { width: W, height: H, dpr } = screen;
    const [a, b, c, d, e, f] = t;
    const ox = W / 2, oy = H / 2, side = fieldSide();
    const corners = ([[0, 0], [side, 0], [side, side], [0, side]] as const)
      .map(([u, v]) => [a * u + c * v + e + ox, b * u + d * v + f + oy] as [number, number]);
    const size = Math.hypot(a, b) * side;
    if (series && fieldCanvas.width === side) {
      ctx.save();
      ctx.setTransform(dpr * a, dpr * b, dpr * c, dpr * d, dpr * (e + ox), dpr * (f + oy));
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(fieldCanvas, 0, 0);
      ctx.restore();
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(166, 232, 220, 0.38)";
    ctx.beginPath();
    corners.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.closePath();
    ctx.stroke();
    if (size >= 24) {
      // Corner ticks, as on a photographic plate.
      ctx.strokeStyle = "#a6e8dc";
      ctx.lineWidth = 1.5;
      const tick = Math.min(14, size / 5);
      corners.forEach((corner, i) => {
        const toward = [corners[(i + 1) % 4], corners[(i + 3) % 4]];
        ctx.beginPath();
        for (const target of toward) {
          const length = Math.hypot(target[0] - corner[0], target[1] - corner[1]) || 1;
          ctx.moveTo(corner[0], corner[1]);
          ctx.lineTo(corner[0] + (target[0] - corner[0]) / length * tick, corner[1] + (target[1] - corner[1]) / length * tick);
        }
        ctx.stroke();
      });
    } else {
      // Too small to read: show a pin so the field stays findable.
      const cx = (corners[0][0] + corners[2][0]) / 2, cy = (corners[0][1] + corners[2][1]) / 2;
      ctx.fillStyle = "#a6e8dc";
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = "rgba(166, 232, 220, 0.45)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, 11, 0, 2 * Math.PI); ctx.stroke();
    }
    return corners;
  }

  function drawMarkers(ctx: CanvasRenderingContext2D, k: number): void {
    const pixelPx = 2 ** camera.z;
    if (playback !== "blink" && !arithmeticView()) {
      const mjd = frameMjd();
      const year = mjd === undefined ? null : 2000 + (mjd - 51544.5) / 365.25;
      const radius = Math.max(5, Math.min(40, 1.4 * pixelPx));
      for (const [name, sources] of Object.entries(catalogues)) {
        if (!get<HTMLInputElement>(name).checked) continue;
        ctx.strokeStyle = name === "gaia" ? "#f3c97a" : "#80bfff";
        ctx.lineWidth = 1.2;
        for (const source of sources) {
          const [ra, dec] = SkyShift.cataloguePosition(source, year);
          const p = toScreen(ra, dec, k);
          if (!p || p[0] < -radius || p[1] < -radius || p[0] > screen.width + radius || p[1] > screen.height + radius) continue;
          ctx.beginPath(); ctx.arc(p[0], p[1], radius, 0, 2 * Math.PI); ctx.stroke();
        }
      }
      if (marker.checked && isBundled && mjd !== undefined) {
        // Linear proper-motion prediction relative to the 2026.0 field centre.
        const time = 2000 + (mjd - 51544.5) / 365.25 - 2026;
        const [ra, dec] = SkyShift.unproject({ ra: fixture.ra0, dec: fixture.dec0, z: 0 }, 8.1237 * time, -0.6732 * time, 1);
        const p = toScreen(ra, dec, k);
        if (p) {
          const gap = Math.max(13, 1.6 * pixelPx);
          ctx.strokeStyle = "#a3deca";
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(p[0] - gap - 17, p[1]); ctx.lineTo(p[0] - gap, p[1]);
          ctx.moveTo(p[0], p[1] - gap - 17); ctx.lineTo(p[0], p[1] - gap);
          ctx.stroke();
        }
      }
    }
    if (selected) {
      const p = toScreen(selected.ra, selected.dec, k);
      if (p) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, 2 * Math.PI); ctx.stroke();
        ctx.strokeStyle = "#05080f";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p[0], p[1], 9, 0, 2 * Math.PI); ctx.stroke();
      }
    }
  }

  let fieldDateText = "";
  const fieldLabel = get("field-label");
  const offscreen = get<HTMLButtonElement>("offscreen");
  function placeFieldChrome(corners: [number, number][] | null): void {
    const xs = corners?.map((p) => p[0]) ?? [], ys = corners?.map((p) => p[1]) ?? [];
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const onScreen = !!corners && maxX > visible.left && minX < visible.right && maxY > visible.top && minY < visible.bottom;
    const small = !!corners && Math.max(maxX - minX, maxY - minY) < 24;
    fieldLabel.hidden = !onScreen || !series;
    if (onScreen) {
      const cx = (minX + maxX) / 2;
      fieldLabel.style.transform = `translate(${cx}px, ${small ? (minY + maxY) / 2 - 14 : minY - 6}px) translate(-50%, -100%)`;
      fieldLabel.dataset.small = String(small);
      get("field-date").textContent = small ? fieldName() : fieldDateText;
    }
    offscreen.hidden = onScreen || !series;
    if (!onScreen && series) {
      const [vx, vy] = visibleCentre();
      const target = toScreen(fixture.ra0, fixture.dec0);
      const sky = toSky(vx, vy);
      // Behind the projection plane: point along the great circle's initial direction.
      const [dx, dy] = target ? [target[0] - vx, target[1] - vy] : [-(fixture.ra0 - sky[0]), -(fixture.dec0 - sky[1])];
      const length = Math.hypot(dx, dy) || 1;
      const halfW = (visible.right - visible.left) / 2 - 100, halfH = (visible.bottom - visible.top) / 2 - 30;
      const t = Math.min(Math.abs(halfW / (dx / length || 1e-9)), Math.abs(halfH / (dy / length || 1e-9)));
      offscreen.style.left = `${vx + dx / length * t}px`;
      offscreen.style.top = `${vy + dy / length * t}px`;
      get("offscreen-arrow").style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
      const distance = formatAngle(SkyShift.separation(sky[0], sky[1], fixture.ra0, fixture.dec0));
      get("offscreen-text").textContent = `${fieldName()} · ${distance}`;
      offscreen.setAttribute("aria-label", `Return to ${fieldName()}, ${distance} away`);
    }
  }

  function pixelAt(ra: number, dec: number): { inside: boolean; value: number } {
    const [x, y] = SkyShift.fieldPixel(fixture, ra, dec);
    const ix = Math.round(x), iy = Math.round(y), side = fieldSide();
    if (!(ix >= 0 && iy >= 0 && ix < side && iy < side)) return { inside: false, value: NaN };
    return { inside: true, value: currentPixels?.[iy * side + ix] ?? NaN };
  }
  function valueText(value: number): string {
    return Number.isFinite(value) ? `${value.toPrecision(3)} MJy/sr` : "no data";
  }
  const readout = get("readout");
  function updateReadout(): void {
    const [x, y] = pointerAt ?? visibleCentre();
    const [ra, dec] = toSky(x, y);
    const pixel = pixelAt(ra, dec);
    readout.textContent = `${pointerAt ? "" : "Centre "}${SkyShift.formatRa(ra, 0.01)} ${SkyShift.formatDec(dec, 0.1)}${pixel.inside ? ` · ${valueText(pixel.value)}` : ""}`;
  }

  function cameraChanged(): void {
    render();
    updateSearchArea();
    scheduleSave();
  }
  function setCamera(next: SkyShift.Camera): void {
    camera = next;
    cameraIsDefault = false;
    cameraChanged();
  }
  function panScreen(dx: number, dy: number): void {
    setCamera(SkyShift.panBy(camera, dx, dy, scaleNow()));
  }
  /** Largest whole zoom level up to the default at which the field fits the visible map. */
  function fitLevel(): number {
    const room = Math.min(visible.right - visible.left, visible.bottom - visible.top) - 4;
    return SkyShift.clampZoom(Math.min(SkyShift.MAP_DEFAULT_ZOOM, Math.floor(Math.log2(Math.max(room, 1) / fieldSide()))));
  }
  function frameField(z = fitLevel()): void {
    stopZoomAnimation();
    const k = SkyShift.pxPerArcsec(z, fixture.scale);
    const [vx, vy] = visibleCentre();
    camera = SkyShift.panBy({ ra: fixture.ra0, dec: fixture.dec0, z }, vx - screen.width / 2, vy - screen.height / 2, k);
    cameraIsDefault = z === fitLevel();
    cameraChanged();
  }
  function zoomTo(z: number, ax?: number, ay?: number): void {
    const [vx, vy] = visibleCentre();
    const x = (ax ?? vx) - screen.width / 2, y = (ay ?? vy) - screen.height / 2;
    const start = camera, target = SkyShift.clampZoom(z);
    stopZoomAnimation();
    if (reducedMotion.matches || Math.abs(target - start.z) < 0.01) {
      setCamera(SkyShift.zoomAt(start, target, x, y, fixture.scale));
      return;
    }
    zoomGoal = target;
    // The clock starts on the first frame: a frame timestamp can precede the
    // request, and a negative progress would ease the zoom the wrong way.
    let began: number | undefined;
    const stepZoom = (now: number) => {
      began ??= now;
      const t = Math.max(0, Math.min(1, (now - began) / 180)), eased = 1 - (1 - t) ** 3;
      setCamera(SkyShift.zoomAt(start, t === 1 ? target : start.z + (target - start.z) * eased, x, y, fixture.scale));
      if (t < 1) zoomAnimation = requestAnimationFrame(stepZoom);
      else zoomGoal = null;
    };
    zoomAnimation = requestAnimationFrame(stepZoom);
  }
  /** One whole level per press; quick presses stack on the pending target. */
  function zoomStep(delta: number): void {
    const base = zoomGoal ?? camera.z;
    const level = Math.round(base);
    zoomTo(Math.abs(base - level) < 1e-6 ? level + delta : delta > 0 ? Math.ceil(base) : Math.floor(base));
  }

  const searchAreaPill = get<HTMLButtonElement>("search-area");
  function updateSearchArea(): void {
    if (embed || busy || !series) { searchAreaPill.hidden = true; document.body.classList.remove("pill-on"); return; }
    const [ra, dec] = toSky(...visibleCentre());
    const width = fieldSide() * fixture.scale;
    searchAreaPill.hidden = SkyShift.separation(ra, dec, fixture.ra0, fixture.dec0) < width;
    document.body.classList.toggle("pill-on", !searchAreaPill.hidden);
  }

  function measureChrome(): void {
    const W = screen.width, H = screen.height;
    const topbar = get("topbar").getBoundingClientRect();
    const dock = get("dock").getBoundingClientRect();
    let left = 0, bottom = dock.top;
    if (!panel.hidden) {
      // Layout offsets ignore the slide-in transform, which getBoundingClientRect would include.
      if (panel.offsetTop < H * 0.3) left = panel.offsetLeft + panel.offsetWidth; else bottom = Math.min(bottom, panel.offsetTop);
    }
    visible.left = left;
    visible.top = Math.min(topbar.bottom, H / 3);
    // On narrow screens the zoom/recenter column sits over the map's right edge.
    const controls = get("map-controls").getBoundingClientRect();
    visible.right = W < 900 && controls.width ? Math.max(controls.left - 2, W / 2) : W;
    visible.bottom = Math.max(bottom, visible.top + 80);
    document.documentElement.style.setProperty("--dock-space", `${Math.round(H - dock.top)}px`);
    document.documentElement.style.setProperty("--top-space", `${Math.round(topbar.bottom)}px`);
  }

  function resize(): void {
    const rect = mapCanvas.getBoundingClientRect();
    screen.width = rect.width || innerWidth;
    screen.height = rect.height || innerHeight;
    screen.dpr = Math.min(devicePixelRatio || 1, 3);
    mapCanvas.width = Math.round(screen.width * screen.dpr);
    mapCanvas.height = Math.round(screen.height * screen.dpr);
    measureChrome();
    if (cameraIsDefault) frameField(); else render();
  }
  addEventListener("resize", resize);
  new ResizeObserver(() => {
    measureChrome();
    if (cameraIsDefault) frameField(); else render();
  }).observe(get("dock"));

  // Pointer: drag to pan, wheel or pinch to zoom at the pointer, tap for a position card.
  const pointers = new Map<number, { x: number; y: number }>();
  // Drags keep the grabbed sky point under the pointer; pinches keep the sky
  // under the starting midpoint under the current midpoint.
  type Gesture = { startX: number; startY: number; moved: boolean; grab: [number, number]; pinch?: { distance: number; camera: SkyShift.Camera; sky: [number, number] } };
  let gesture: Gesture | null = null;
  let lastTap = { time: 0, x: 0, y: 0 };
  function pinchState() {
    const [a, b] = [...pointers.values()];
    return { distance: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
  }
  mapCanvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    mapCanvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    closePopovers();
    stopZoomAnimation();
    if (pointers.size === 1) gesture = { startX: event.clientX, startY: event.clientY, moved: false, grab: toSky(event.clientX, event.clientY) };
    else if (pointers.size === 2) {
      const state = pinchState(), sky = toSky(state.midX, state.midY);
      gesture = { startX: state.midX, startY: state.midY, moved: true, grab: sky, pinch: { distance: state.distance, camera, sky } };
    }
  });
  mapCanvas.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse") { pointerAt = [event.clientX, event.clientY]; if (!pointers.size) updateReadout(); }
    const last = pointers.get(event.pointerId);
    if (!last || !gesture) return;
    const now = { x: event.clientX, y: event.clientY };
    if (pointers.size === 1) {
      if (!gesture.moved && Math.hypot(now.x - gesture.startX, now.y - gesture.startY) < 4) return;
      if (!gesture.moved) { gesture.moved = true; mapCanvas.classList.add("dragging"); }
      pointers.set(event.pointerId, now);
      setCamera(SkyShift.placeAt(camera, ...gesture.grab, now.x - screen.width / 2, now.y - screen.height / 2, scaleNow()));
    } else if (pointers.size === 2 && gesture.pinch) {
      pointers.set(event.pointerId, now);
      const state = pinchState(), start = gesture.pinch;
      const z = SkyShift.clampZoom(start.camera.z + Math.log2(state.distance / start.distance));
      setCamera(SkyShift.placeAt({ ...start.camera, z }, ...start.sky, state.midX - screen.width / 2, state.midY - screen.height / 2,
        SkyShift.pxPerArcsec(z, fixture.scale)));
    }
  });
  function endPointer(event: PointerEvent): void {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (event.type === "pointerup" && gesture && !gesture.moved && pointers.size === 0) handleTap(event.clientX, event.clientY, event.shiftKey, event.pointerType === "mouse");
    if (pointers.size === 0) { gesture = null; mapCanvas.classList.remove("dragging"); }
    else if (pointers.size === 1) {
      const [p] = [...pointers.values()];
      gesture = { startX: p.x, startY: p.y, moved: true, grab: toSky(p.x, p.y) };
    }
  }
  mapCanvas.addEventListener("pointerup", endPointer);
  mapCanvas.addEventListener("pointercancel", endPointer);
  mapCanvas.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") { pointerAt = null; updateReadout(); }
  });
  mapCanvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? screen.height : 1;
    const z = camera.z - event.deltaY * unit * (event.ctrlKey ? 0.01 : 0.004);
    stopZoomAnimation();
    setCamera(SkyShift.zoomAt(camera, z, event.clientX - screen.width / 2, event.clientY - screen.height / 2, fixture.scale));
  }, { passive: false });
  function handleTap(x: number, y: number, shift: boolean, mouse: boolean): void {
    const now = performance.now();
    if (now - lastTap.time < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 24) {
      lastTap.time = 0;
      zoomTo((zoomGoal ?? camera.z) + (shift ? -1 : 1), x, y);
      return;
    }
    lastTap = { time: now, x, y };
    const [ra, dec] = toSky(x, y);
    showHere(ra, dec);
    // Mouse users get keyboard shortcuts on the map; touch users keep their place.
    if (mouse) mapCanvas.focus({ preventScroll: true });
  }

  // "What's here" card: the single-pointer route to coordinates, values and search.
  const hereCard = get("whats-here");
  function showHere(ra: number, dec: number): void {
    selected = { ra, dec };
    hereCard.hidden = false;
    refreshHere();
    render();
  }
  function hideHere(): void {
    if (!selected) return;
    selected = null;
    hereCard.hidden = true;
    render();
  }
  function refreshHere(): void {
    if (!selected) return;
    const { ra, dec } = selected;
    const pixel = pixelAt(ra, dec);
    const viewLabel = arithmeticView() ? (modeSelect.value === "difference" ? "B − A" : "A + B") : labelFor(frame);
    get("here-title").textContent = pixel.inside ? `${fieldName()} · ${viewLabel}` : "Sky position";
    get("here-coords").textContent = `${SkyShift.formatRa(ra, 0.01)} ${SkyShift.formatDec(dec, 0.1)} · ${ra.toFixed(5)}°, ${dec.toFixed(5)}°`;
    get("here-value").textContent = pixel.inside
      ? Number.isFinite(pixel.value) ? `${valueText(pixel.value)} at this pixel` : "No data at this pixel"
      : `${formatAngle(SkyShift.separation(ra, dec, fixture.ra0, fixture.dec0))} from the ${fieldName()} field centre`;
    get("here-details").hidden = !pixel.inside;
    get("here-search").hidden = pixel.inside || embed;
  }
  get("here-close").addEventListener("click", () => { hideHere(); mapCanvas.focus(); });
  get("here-center").addEventListener("click", () => {
    if (!selected) return;
    const p = toScreen(selected.ra, selected.dec);
    const [vx, vy] = visibleCentre();
    if (p) panScreen(vx - p[0], vy - p[1]);
  });
  get("here-details").addEventListener("click", () => openPanel(get("here-details")));
  get("here-search").addEventListener("click", () => { if (selected) void searchFromOptions(selected.ra, selected.dec); });
  get("here-copy").addEventListener("click", () => {
    if (selected) void copyText(`${selected.ra.toFixed(6)}, ${selected.dec.toFixed(6)}`, "Coordinates copied.");
  });
  async function copyText(text: string, done: string): Promise<void> {
    try { await navigator.clipboard.writeText(text); status.textContent = done; }
    catch { status.textContent = `Copy this: ${text}`; }
  }

  get("zoom-in").addEventListener("click", () => zoomStep(1));
  get("zoom-out").addEventListener("click", () => zoomStep(-1));
  get("recenter").addEventListener("click", () => frameField());
  get("panel-recenter").addEventListener("click", () => frameField());
  offscreen.addEventListener("click", () => { frameField(); mapCanvas.focus(); });
  gridToggle.addEventListener("change", render);

  function drawCatalogueStatus(): void { render(); }
  async function toggleCatalogue(name: "gaia" | "wise"): Promise<void> {
    const checkbox = get<HTMLInputElement>(name), output = get("catalogue-status");
    if (!checkbox.checked) { drawCatalogueStatus(); return; }
    if (!catalogues[name]) {
      const requestedRa = fixture.ra0, requestedDec = fixture.dec0;
      output.textContent = `Loading ${name === "gaia" ? "Gaia DR3" : "CatWISE2020"}…`;
      try {
        const q = new URLSearchParams({ catalogue: name, ra: String(fixture.ra0), dec: String(fixture.dec0), fov: String(currentSelection?.fov ?? fixture.half * 2 * fixture.scale / 60) });
        const response = await fetch(`/api/catalogue?${q}`); const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Catalogue unavailable.");
        if (fixture.ra0 !== requestedRa || fixture.dec0 !== requestedDec || !checkbox.checked) return;
        catalogues[name] = result.sources;
        output.textContent = `${result.catalogue}: ${result.sources.length} sources${result.truncated ? " (limit reached)" : ""}. Gaia markers use linear proper motion; CatWISE positions are catalogue positions.`;
        const list = document.createElement("details");
        const summary = document.createElement("summary"); summary.textContent = `${result.catalogue} source IDs`;
        const text = document.createElement("p"); text.textContent = result.sources.map((item: CatalogueSource) => item.id).join(", ") || "No sources.";
        list.append(summary, text); get("catalogue-list").append(list);
      } catch (error) {
        checkbox.checked = false;
        output.textContent = error instanceof TypeError ? "Catalogue overlays need the SkyShift server (npm run dev)." : error instanceof Error ? error.message : String(error);
      }
    }
    drawCatalogueStatus();
  }
  for (const name of ["gaia", "wise"] as const) get<HTMLInputElement>(name).addEventListener("change", () => void toggleCatalogue(name));
  function clearCatalogues(): void {
    for (const name of ["gaia", "wise"]) { delete catalogues[name]; get<HTMLInputElement>(name).checked = false; }
    get("catalogue-list").replaceChildren();
    get("catalogue-status").textContent = "";
  }

  function step(delta: number): void {
    if (!series) return;
    frame = (frame + delta + series.frames.length) % series.frames.length;
    draw();
  }

  function pause(): void {
    const wasPlaying = playback !== undefined;
    clearInterval(timer);
    timer = undefined;
    playback = undefined;
    play.textContent = "Play";
    play.setAttribute("aria-pressed", "false");
    blink.textContent = "Blink";
    blink.setAttribute("aria-pressed", "false");
    if (wasPlaying) commitView();
  }

  function togglePlay(): void {
    if (playback === "visits") { pause(); return; }
    if (busy || !series || series.frames.length < 2) return;
    pause();
    if (modeSelect.value !== "exposures") modeSelect.value = "stack";
    playback = "visits";
    timer = window.setInterval(() => step(1), 850);
    play.textContent = "Pause";
    play.setAttribute("aria-pressed", "true");
    commitView();
  }

  function toggleBlink(): void {
    if (playback === "blink") { pause(); return; }
    if (busy || !canCompare() || modeSelect.value === "exposures") return;
    pause();
    dismissHint();
    const a = Number(referenceSelect.value), b = Number(comparisonSelect.value);
    modeSelect.value = "blink";
    frame = a;
    playback = "blink";
    timer = window.setInterval(() => {
      frame = frame === a ? b : a;
      draw();
    }, 500);
    blink.textContent = "Pause blink";
    blink.setAttribute("aria-pressed", "true");
    commitView();
  }

  async function submit(
    engine: SkyShift.EngineName,
    scenario: SkyShift.Scenario,
    cache: SkyShift.CacheLevel,
    progress: (done: number, total: number) => void,
    data: SkyShift.PackedFixture = fixture,
    frameMode: "visits" | "exposures" = "visits",
  ): Promise<SkyShift.WorkResult> {
    if (!workerURL) workerURL = URL.createObjectURL(new Blob([ASSETS.worker], { type: "text/javascript" }));
    const current = new Worker(workerURL);
    worker = current;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        current.terminate();
        if (worker === current) {
          worker = undefined;
          interrupt = undefined;
        }
      };
      interrupt = () => {
        cleanup();
        reject(new DOMException("Cancelled", "AbortError"));
      };
      current.onerror = (event) => {
        cleanup();
        reject(new Error(event.message || "The browser worker could not start."));
      };
      current.onmessage = (event: MessageEvent<SkyShift.WorkMessage>) => {
        const message = event.data;
        if (message.type === "progress") {
          progress(message.done, message.total);
          return;
        }
        cleanup();
        if (message.type === "result") resolve(message.result);
        else reject(new Error(message.message));
      };
      current.postMessage({ engine, scenario, cache, fixture: data, frameMode, wasm: engine === "rust" ? ASSETS.wasm : "" });
    });
  }

  const nameOf = (engine: SkyShift.EngineName) => engine === "rust" ? "Rust/WASM" : "TypeScript";
  const elapsed = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;

  async function load(data: SkyShift.PackedFixture = fixture): Promise<boolean> {
    pause();
    busy = true;
    updateControls();
    status.textContent = "Preparing observations…";
    const engine = engineSelect.value as SkyShift.EngineName;
    const cache = cacheSelect.value as SkyShift.CacheLevel;
    const started = performance.now();
    try {
      const loaded = await submit(engine, "wise0855", cache, (done, total) => {
        status.textContent = `Aligned ${done} of ${total} visits…`;
      }, data, modeSelect.value === "exposures" ? "exposures" : "visits");
      // Keep the apparent zoom if a new grid uses a different pixel scale.
      if (data.scale !== fixture.scale) camera = { ...camera, z: SkyShift.clampZoom(camera.z + Math.log2(data.scale / fixture.scale)) };
      fixture = data;
      series = loaded.series;
      frame = Math.max(0, Math.min(frame, series.frames.length - 1));
      updateStretch(series);
      rebuildVisits();
      commitView();
      const source = {
        miss: "Computed from exposures",
        inputs: "Rebuilt from cached exposures",
        results: "Loaded cached frames",
      }[loaded.cacheHit];
      status.textContent = routineStatus = `${source} · ${nameOf(engine)} · ${elapsed(performance.now() - started)}`;
      return true;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      busy = false;
      updateControls();
    }
  }

  async function benchmarkEngines(): Promise<void> {
    pause();
    busy = true;
    updateControls();
    const scenario = scenarioSelect.value as SkyShift.Scenario;
    const results: { engine: SkyShift.EngineName; result: SkyShift.WorkResult; elapsedMs: number }[] = [];
    try {
      for (const engine of ["typescript", "rust"] as const) {
        benchmarkOutput.textContent = `Running ${nameOf(engine)}…`;
        const start = performance.now();
        const result = await submit(engine, scenario, "none", (done, total) => {
          status.textContent = `Benchmark · ${nameOf(engine)} · ${done}/${total} stacks`;
        });
        results.push({ engine, result, elapsedMs: performance.now() - start });
      }
      const [ts, rust] = results;
      const diff = SkyShift.compareSeries(ts.result.series, rust.result.series);
      if (diff.maskMismatch || diff.maxError > 1e-6) throw new Error("The two engines produced different frames.");
      benchmarkOutput.replaceChildren();
      const table = document.createElement("table");
      const head = table.createTHead().insertRow();
      for (const label of ["Engine", "Initialize", "Align + stack", "Worker total"]) {
        const th = document.createElement("th");
        th.scope = "col";
        th.textContent = label;
        head.append(th);
      }
      for (const row of results) {
        const tr = table.insertRow();
        for (const value of [nameOf(row.engine), elapsed(row.result.initializeMs), elapsed(row.result.computeMs), elapsed(row.elapsedMs)]) {
          tr.insertCell().textContent = value;
        }
      }
      benchmarkOutput.append(table);
      const summary = document.createElement("p");
      const faster = ts.result.computeMs <= rust.result.computeMs ? ts : rust;
      const slower = faster === ts ? rust : ts;
      const ratio = slower.result.computeMs / Math.max(faster.result.computeMs, 0.001);
      summary.textContent = `${nameOf(faster.engine)} was ${ratio.toFixed(2)}× as fast for alignment and stacking. ${diff.maxError === 0 ? "The output pixels match." : `Maximum pixel difference: ${diff.maxError.toExponential(2)}.`}`;
      benchmarkOutput.append(summary);
      const details = document.createElement("p");
      details.textContent = `${SkyShift.SCENARIOS[scenario]}. One run per engine with caching off. Worker total includes startup and sharing data; fixture download is excluded.`;
      benchmarkOutput.append(details);

      const cacheStatus = document.createElement("p");
      cacheStatus.textContent = "Measuring cached revisits…";
      benchmarkOutput.append(cacheStatus);
      // Prime both entries in IndexedDB, then time reads from fresh workers.
      await submit("typescript", scenario, "prime", () => {});
      const revisits: { label: string; hit: SkyShift.CacheHit; total: number; compute: number }[] = [];
      for (const level of ["inputs", "results"] as const) {
        const start = performance.now();
        const result = await submit("typescript", scenario, level, () => {});
        revisits.push({
          label: level === "inputs" ? "Cached exposures" : "Cached frames",
          hit: result.cacheHit,
          total: performance.now() - start,
          compute: result.computeMs,
        });
      }
      const [inputs, frames] = revisits;
      if (inputs.hit === "inputs" && frames.hit === "results") {
        cacheStatus.textContent = `Cached exposures reopened in ${elapsed(inputs.total)} (${elapsed(inputs.compute)} processing). Cached frames reopened in ${elapsed(frames.total)} (no processing).`;
      } else {
        cacheStatus.textContent = "Persistent cache was unavailable in this browser session.";
      }
      status.textContent = "Comparison complete.";
    } catch (error) {
      benchmarkOutput.textContent = error instanceof Error ? error.message : String(error);
      status.textContent = "Comparison stopped.";
    } finally {
      busy = false;
      updateControls();
    }
  }

  get("show-benchmark").addEventListener("click", () => {
    benchmark.hidden = false;
    benchmark.scrollIntoView({ block: "nearest" });
    scenarioSelect.focus();
  });
  get("hide-benchmark").addEventListener("click", () => {
    benchmark.hidden = true;
    get("show-benchmark").focus();
  });
  async function share(): Promise<void> {
    clearTimeout(saveTimer);
    saveState();
    await copyText(location.href, "View link copied.");
  }
  get("share").addEventListener("click", () => void share());
  get("panel-share").addEventListener("click", () => void share());
  get("copy-coordinates").addEventListener("click", () => void copyText(`${fixture.ra0.toFixed(6)}, ${fixture.dec0.toFixed(6)}`, "Field coordinates copied."));
  get("export").addEventListener("click", () => {
    const manifest = {
      schemaVersion: 1, createdUtc: new Date().toISOString(), qualitative: true,
      grid: { raDeg: fixture.ra0, decDeg: fixture.dec0, side: fixture.half * 2 + 1, scaleArcsec: fixture.scale, projection: "TAN" },
      detector: currentSelection?.band ?? 6, dates: fixture.dates, exposureCounts: fixture.visitSizes,
      products: fixture.headers.map((h) => ({ productKey: h.productKey ?? null, mjd: h.mjd ?? null,
        sourceUrl: h.productKey ? `https://irsa.ipac.caltech.edu/ibe/data/spherex/${h.productKey}` : null })),
      algorithm: "TAN-SIP bilinear alignment; per-exposure median background; median visit stack",
      wavelengthSelectionMicron: wavelengthSelection,
      asOfUtc: currentSelection?.asof ?? null,
      timeWindow: currentSelection?.from ? { fromUtc: currentSelection.from, throughUtc: currentSelection.to } : null,
      view: modeSelect.value, frame: frame + 1,
      referenceFrame: Number(referenceSelect.value) + 1,
      comparisonFrame: Number(comparisonSelect.value) + 1,
      display: { map: { centreRaDeg: camera.ra, centreDecDeg: camera.dec, zoomLevel: camera.z, cssPxPerGridPixel: 2 ** camera.z }, stretch: stretchValue() },
      warnings: ["Visual exploration only; PSF and wavelength matching, quality flags, and uncertainty propagation are not applied."],
    };
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }));
    link.download = "skyshift-view.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  get("clear-cache").addEventListener("click", async () => {
    try { await SkyShift.clearBrowserCaches(); status.textContent = "Browser image and processing caches cleared."; }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  });
  async function applyWavelength(): Promise<void> {
    if (busy) return;
    const output = get("wave-status");
    const min = Number(get<HTMLInputElement>("wave-min").value), max = Number(get<HTMLInputElement>("wave-max").value);
    const controller = new AbortController();
    busy = true; updateControls(); interrupt = () => controller.abort();
    output.textContent = "Checking wavelengths…";
    try {
      const filtered = await SkyShift.filterWavelength(fullBandFixture, min, max, controller.signal);
      frame = 0; busy = false;
      if (await load(filtered.fixture)) {
        wavelengthSelection = { min, max };
        commitView();
        output.textContent = `${filtered.fixture.headers.length} exposures overlap ${min}–${max} μm; ${filtered.unavailable} had unavailable wavelength metadata. Dates without matching exposures are omitted.`;
      }
    } catch (error) { output.textContent = error instanceof Error ? error.message : String(error); }
    finally { busy = false; interrupt = undefined; updateControls(); }
  }
  get("wave-apply").addEventListener("click", () => void applyWavelength());
  type NominalChannel = { number: number; band: number; channel: number; center: number; low: number; high: number; blank: boolean };
  let nominalChannels: NominalChannel[] = [];
  get("channels-load").addEventListener("click", async () => {
    const output = get("channels-status"), select = get<HTMLSelectElement>("channels");
    output.textContent = "Loading IRSA channel metadata…";
    try {
      const response = await fetch("/api/channels"); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Channel metadata is unavailable.");
      nominalChannels = data.channels;
      const initial = document.createElement("option"); initial.value = ""; initial.textContent = "Choose a channel";
      select.replaceChildren(initial, ...nominalChannels.map((channel) => {
        const option = document.createElement("option"); option.value = String(channel.number); option.disabled = channel.blank;
        option.textContent = `${channel.number} · band ${channel.band} · ${channel.center.toFixed(3)} μm${channel.blank ? " · blank" : ""}`; return option;
      }));
      output.textContent = "Channels 51 and 52 are blank in the DR1 cube. Boundaries use adjacent wavelength midpoints.";
    } catch (error) { output.textContent = error instanceof Error ? error.message : String(error); }
  });
  get<HTMLSelectElement>("channels").addEventListener("change", (event) => {
    const channel = nominalChannels.find((item) => item.number === Number((event.target as HTMLSelectElement).value));
    if (!channel) return;
    get<HTMLInputElement>("wave-min").value = channel.low.toFixed(6);
    get<HTMLInputElement>("wave-max").value = channel.high.toFixed(6);
    const currentBand = currentSelection?.band ?? 6;
    get("channels-status").textContent = channel.band === currentBand
      ? `Channel ${channel.number} selected. Apply the wavelength filter.`
      : `Channel ${channel.number} belongs to band ${channel.band}; search that detector before applying the filter.`;
  });
  get("quality-decode").addEventListener("click", () => {
    try {
      const names = SkyShift.decodeQualityFlags(Number(get<HTMLInputElement>("quality-value").value));
      get("quality-status").textContent = names.length ? names.join(", ") : "No flags set.";
    } catch (error) { get("quality-status").textContent = error instanceof Error ? error.message : String(error); }
  });
  get("quality-fetch").addEventListener("click", async () => {
    const output = get("quality-status");
    const index = modeSelect.value === "exposures" ? frame : fixture.visitSizes.slice(0, frame).reduce((a, b) => a + b, 0);
    const header = fixture.headers[index];
    const requestedFixture = fixture;
    if (!header?.productKey) { output.textContent = "This exposure does not include a product identifier."; return; }
    try {
      const [x, y] = SkyShift.worldToPixel(SkyShift.packWcs(header), fixture.ra0, fixture.dec0);
      const query = new URLSearchParams({key: header.productKey, x: String(Math.round(x)), y: String(Math.round(y))});
      output.textContent = "Reading FLAGS for the first exposure in this frame…";
      const response = await fetch(`/api/quality?${query}`); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Flag inspection failed.");
      if (fixture !== requestedFixture) return;
      const names = SkyShift.decodeQualityFlags(data.combined);
      get<HTMLInputElement>("quality-value").value = String(data.combined);
      output.textContent = `Exposure ${index + 1}, pixels near (${data.x}, ${data.y}): ${names.length ? names.join(", ") : "no flags set"}. Combined mask ${data.combined}; other exposures in a stack may differ.`;
    } catch (error) { output.textContent = error instanceof Error ? error.message : String(error); }
  });
  get("wave-reset").addEventListener("click", () => {
    if (busy) return;
    wavelengthSelection = null;
    frame = 0; get("wave-status").textContent = "Showing the full detector band.";
    void load(fullBandFixture);
  });
  get("spectrum").addEventListener("click", async () => {
    const output = get("spectrum-status");
    const chart = get<HTMLCanvasElement>("spectrum-chart");
    const download = get<HTMLAnchorElement>("spectrum-download");
    output.textContent = "Calculating spectrum…";
    chart.hidden = true;
    download.hidden = true;
    try {
      const points = await SkyShift.quickSpectrum(fixture, new AbortController().signal);
      if (!points.length) throw new Error("No usable measurements are available.");
      const ctx = chart.getContext("2d")!;
      const xs = points.map((p) => p.wavelength), ys = points.map((p) => p.flux);
      const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys, 0), ymax = Math.max(...ys);
      ctx.clearRect(0, 0, chart.width, chart.height);
      ctx.strokeStyle = "#8794a4";
      ctx.strokeRect(55, 15, chart.width - 75, chart.height - 55);
      ctx.fillStyle = "#a4adbc";
      ctx.font = "13px sans-serif";
      ctx.fillText("Flux (Jy)", 8, 12);
      ctx.fillText(`${xmin.toFixed(2)} μm`, 55, chart.height - 15);
      ctx.fillText(`${xmax.toFixed(2)} μm`, chart.width - 95, chart.height - 15);
      ctx.fillText(ymax.toPrecision(3), 4, 28);
      ctx.fillText(ymin.toPrecision(3), 4, chart.height - 40);
      ctx.fillStyle = "#a3deca";
      for (const point of points) {
        const x = 55 + (point.wavelength - xmin) / Math.max(xmax - xmin, 1e-9) * (chart.width - 75);
        const y = 15 + (ymax - point.flux) / Math.max(ymax - ymin, 1e-12) * (chart.height - 55);
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      }
      chart.hidden = false;
      download.href = URL.createObjectURL(new Blob(["wavelength_um,bandwidth_um,approx_flux_jy,visit,mjd,product_key\n" + points.map((p) => `${p.wavelength},${p.bandwidth},${p.flux},"${p.date}",${p.mjd ?? ""},"${p.productKey ?? ""}"`).join("\n")], { type: "text/csv" }));
      download.hidden = false;
      output.textContent = `${points.length} measurements · approximate flux, no aperture correction or uncertainty`;
    } catch (error) { output.textContent = error instanceof Error ? error.message : String(error); }
  });
  run.addEventListener("click", () => void benchmarkEngines());
  cancel.addEventListener("click", () => interrupt?.());
  function manualStep(delta: number): void {
    pause();
    if (modeSelect.value !== "exposures") modeSelect.value = "stack";
    step(delta);
    updateControls();
    saveState();
  }
  next.addEventListener("click", () => manualStep(1));
  previous.addEventListener("click", () => manualStep(-1));
  play.addEventListener("click", togglePlay);
  blink.addEventListener("click", toggleBlink);
  function toggleDifference(): void {
    if (difference.disabled) return;
    pause();
    modeSelect.value = modeSelect.value === "difference" ? "stack" : "difference";
    commitView();
  }
  difference.addEventListener("click", toggleDifference);
  marker.addEventListener("change", render);
  for (const select of [referenceSelect, comparisonSelect]) select.addEventListener("change", () => {
    pause();
    if (modeSelect.value === "blink") frame = Number(referenceSelect.value);
    updateVisitBadges();
    commitView();
  });
  for (const input of stretchInputs) input.addEventListener("change", () => {
    pause();
    refreshThumbnails();
    commitView();
  });

  // ------------------------------------------------------------ panel ----
  let panelOpener: HTMLElement | null = null;
  function openPanel(opener?: HTMLElement | null): void {
    pause();
    closePopovers();
    if (panel.hidden) {
      panel.hidden = false;
      document.body.classList.add("panel-open");
      menuButton.setAttribute("aria-expanded", "true");
      panelOpener = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : mapCanvas);
      measureChrome();
      keepFieldVisible();
    }
    get("panel-close").focus();
  }
  function closePanel(restoreFocus = true): void {
    if (panel.hidden) return;
    panel.hidden = true;
    document.body.classList.remove("panel-open");
    menuButton.setAttribute("aria-expanded", "false");
    measureChrome();
    if (cameraIsDefault) frameField(); else render();
    if (restoreFocus) (panelOpener && document.contains(panelOpener) && !panelOpener.closest("[hidden]") ? panelOpener : mapCanvas).focus();
  }
  function keepFieldVisible(): void {
    if (cameraIsDefault) { frameField(); return; }
    const p = toScreen(fixture.ra0, fixture.dec0);
    if (!p) { render(); return; }
    const [vx, vy] = visibleCentre();
    if (p[0] < visible.left + 40 || p[0] > visible.right - 40 || p[1] > visible.bottom - 40 || p[1] < visible.top + 20) panScreen(vx - p[0], vy - p[1]);
    else render();
  }
  menuButton.addEventListener("click", () => panel.hidden ? openPanel(menuButton) : closePanel());
  get("panel-close").addEventListener("click", () => closePanel());

  // ----------------------------------------------------------- popovers ----
  const layers = get("layers"), layersToggle = get<HTMLButtonElement>("layers-toggle");
  function setLayers(open: boolean): void {
    layers.hidden = !open;
    layersToggle.setAttribute("aria-expanded", String(open));
  }
  layersToggle.addEventListener("click", () => setLayers(layers.hasAttribute("hidden")));
  const searchDrop = get("search-drop"), suggestionsList = get<HTMLUListElement>("suggestions");
  const queryPreview = get("query-preview"), searchOptions = get("search-options"), optionsToggle = get<HTMLButtonElement>("options-toggle");
  function closeDrop(): void {
    searchDrop.hidden = true;
    query.setAttribute("aria-expanded", "false");
    query.removeAttribute("aria-activedescendant");
    activeSuggestion = -1;
  }
  function closePopovers(): void {
    closeDrop();
    setLayers(false);
  }
  document.addEventListener("pointerdown", (event) => {
    const target = event.target as Node;
    if (!document.querySelector(".search-column")!.contains(target)) closeDrop();
    if (!get("layers-area").contains(target)) setLayers(false);
  });

  // ------------------------------------------------------------ search ----
  let suggestionItems: SkyShift.Target[] = [];
  let activeSuggestion = -1;
  let shownName = "WISE 0855";
  function openDrop(): void {
    searchDrop.hidden = false;
    query.setAttribute("aria-expanded", "true");
    updateSuggestions();
  }
  function updateSuggestions(): void {
    const text = query.value.trim();
    const typed = text !== "" && text !== shownName;
    suggestionItems = typed ? SkyShift.matchTargets(text) : SkyShift.TARGETS;
    activeSuggestion = Math.min(activeSuggestion, suggestionItems.length - 1);
    suggestionsList.replaceChildren(...suggestionItems.map((target, index) => {
      const item = document.createElement("li");
      item.id = `suggestion-${index}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === activeSuggestion));
      const name = document.createElement("span"); name.className = "s-name"; name.textContent = target.label;
      const tag = document.createElement("span"); tag.className = "s-tag";
      tag.textContent = target.id === "wise0855" || ASSETS.examples.includes(target.id) ? "Bundled" : "Live search";
      const coords = document.createElement("span"); coords.className = "s-coords";
      coords.textContent = `${SkyShift.formatRa(target.ra, 0.1)} ${SkyShift.formatDec(target.dec, 1)} · band ${target.band}`;
      item.append(name, tag, coords);
      item.addEventListener("pointerdown", (event) => event.preventDefault());
      item.addEventListener("click", () => void openExample(target.id));
      return item;
    }));
    if (activeSuggestion >= 0) query.setAttribute("aria-activedescendant", `suggestion-${activeSuggestion}`);
    else query.removeAttribute("aria-activedescendant");
    queryPreview.classList.remove("invalid");
    queryPreview.textContent = "";
    if (typed) {
      try {
        const parsed = SkyShift.parseQuery(text);
        queryPreview.textContent = parsed.kind === "target"
          ? `Enter opens ${parsed.target.label}.`
          : `RA ${parsed.ra.toFixed(5)}° (${SkyShift.formatRa(parsed.ra, 0.1)}) · Dec ${parsed.dec.toFixed(5)}° (${SkyShift.formatDec(parsed.dec, 1)}) · band ${bandSelect.value} · ${fovSelect.value}′. Enter searches the archive.`;
      } catch (error) {
        queryPreview.classList.add("invalid");
        queryPreview.textContent = error instanceof Error ? error.message : String(error);
      }
    }
    get("query-clear").hidden = !query.value;
  }
  query.addEventListener("focus", () => { query.select(); openDrop(); });
  query.addEventListener("input", () => { activeSuggestion = -1; openDrop(); });
  query.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (searchDrop.hidden) openDrop();
      const count = suggestionItems.length;
      if (!count) return;
      activeSuggestion = event.key === "ArrowDown" ? (activeSuggestion + 1) % count : (activeSuggestion - 1 + count) % count;
      updateSuggestions();
    } else if (event.key === "Enter" && activeSuggestion >= 0 && !searchDrop.hidden) {
      event.preventDefault();
      void openExample(suggestionItems[activeSuggestion].id);
    }
  });
  get("query-clear").addEventListener("click", () => { query.value = ""; query.focus(); openDrop(); });
  optionsToggle.addEventListener("click", () => {
    const open = searchOptions.hidden;
    searchOptions.hidden = !open;
    optionsToggle.setAttribute("aria-expanded", String(open));
    if (open) { openDrop(); bandSelect.focus(); }
  });
  for (const control of [bandSelect, fovSelect]) control.addEventListener("change", updateSuggestions);
  get<HTMLFormElement>("search").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = query.value.trim();
    if (text === shownName) { closeDrop(); frameField(); mapCanvas.focus(); return; }
    let parsed: SkyShift.Query;
    try { parsed = SkyShift.parseQuery(text); }
    catch (error) {
      openDrop();
      queryPreview.classList.add("invalid");
      queryPreview.textContent = error instanceof Error ? error.message : String(error);
      return;
    }
    if (parsed.kind === "target") void openExample(parsed.target.id);
    else void searchFromOptions(parsed.ra, parsed.dec);
  });

  const chips = get("chips");
  chips.replaceChildren(...SkyShift.TARGETS.map((target) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.dataset.target = target.id;
    chip.textContent = target.label;
    chip.setAttribute("aria-pressed", String(target.id === currentTargetId));
    chip.addEventListener("click", () => void openExample(target.id));
    return chip;
  }));
  function setFieldInfo(name: string, coordinates: string, band: number, targetId?: string): void {
    get("target").textContent = name;
    get("coordinates").textContent = coordinates;
    get("field-survey").textContent = `SPHEREx · band ${band}`;
    shownName = name;
    query.value = name;
    get("query-clear").hidden = !name;
    currentTargetId = targetId;
    for (const chip of chips.querySelectorAll<HTMLButtonElement>("button")) chip.setAttribute("aria-pressed", String(chip.dataset.target === targetId));
    bandSelect.value = String(band);
    if (targetId !== "wise0855") hint.hidden = true;
  }

  let loadedFrameMode = modeSelect.value === "exposures" ? "exposures" : "visits";
  modeSelect.addEventListener("change", async () => {
    pause();
    const nextMode = modeSelect.value === "exposures" ? "exposures" : "visits";
    if (nextMode !== loadedFrameMode) {
      const previousFrame = frame;
      frame = 0;
      if (await load()) loadedFrameMode = nextMode;
      else {
        modeSelect.value = loadedFrameMode === "exposures" ? "exposures" : "stack";
        frame = previousFrame;
        commitView();
      }
    } else {
      if (modeSelect.value === "blink" && canCompare()) frame = Number(referenceSelect.value);
      commitView();
    }
  });
  function exposureLabel(index: number): string {
    const mjd = fixture.headers[index]?.mjd;
    return mjd === undefined ? `Exposure ${index + 1}` : new Date((mjd - 40587) * 86400000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }
  function labelFor(index: number): string {
    return modeSelect.value === "exposures" ? exposureLabel(index) : fixture.dates[index] ?? `Visit ${index + 1}`;
  }

  function updateVisitBadges(): void {
    const a = Number(referenceSelect.value), b = Number(comparisonSelect.value);
    visits.forEach((button, index) => {
      const assigned = [];
      if (modeSelect.value !== "exposures" && visits.length > 1) {
        if (index === a) assigned.push("A");
        if (index === b) assigned.push("B");
      }
      const holder = button.querySelector(".visit-badges")!;
      holder.replaceChildren(...assigned.map((slot) => {
        const badge = document.createElement("span");
        badge.className = "slot-badge";
        badge.textContent = slot;
        return badge;
      }));
      const label = [labelFor(index), button.querySelector(".visit-count")?.textContent, ...assigned.map(slot => `Visit ${slot}`)];
      button.setAttribute("aria-label", label.filter(Boolean).join(", "));
    });
  }

  function refreshThumbnails(): void {
    if (!series) return;
    const { side, frames } = series;
    const previewSide = Math.min(48, side);
    visits.forEach((button, index) => {
      const preview = button.querySelector("canvas")!;
      const ctx = preview.getContext("2d");
      if (!ctx) return;
      const source = frames[index];
      let pixels = source;
      if (previewSide < side) {
        pixels = new Float32Array(previewSide * previewSide);
        for (let y = 0; y < previewSide; y++) {
          for (let x = 0; x < previewSide; x++) {
            pixels[y * previewSide + x] = source[Math.floor(y * side / previewSide) * side + Math.floor(x * side / previewSide)];
          }
        }
      }
      paint(preview, ctx, pixels, previewSide, "stack");
    });
  }

  function rebuildVisits(): void {
    if (!series) return;
    const container = get("visits");
    const labels = series.frames.map((_, index) => labelFor(index));
    const key = `${fixture.id}:${modeSelect.value === "exposures" ? "exposures" : "visits"}`;
    const candidates = labels.map((_, index) => index);
    const full = candidates.filter((index) => series!.counts[index] >= 5);
    const defaults = (full.length >= 2 ? full : candidates).slice(-2);
    const firstLoad = pairSequence === undefined;
    const unchanged = pairSequence === key;
    const legacyA = params.get("reference");
    const legacyB = requestedMode === "difference" || requestedMode === "sum" ? params.get("frame") : null;
    function resolve(select: HTMLSelectElement, oneBased: string | null, fallback: number): string {
      const index = unchanged && select.value !== "" ? Number(select.value) : firstLoad && oneBased !== null ? Number(oneBased) - 1 : fallback;
      return String(Number.isInteger(index) ? Math.max(0, Math.min(index, labels.length - 1)) : fallback);
    }
    const a = resolve(referenceSelect, params.get("a") ?? (legacyA === null ? null : String(Number(legacyA) + 1)), defaults[0] ?? 0);
    const b = resolve(comparisonSelect, params.get("b") ?? legacyB, defaults.at(-1) ?? 0);
    for (const [select, value] of [[referenceSelect, a], [comparisonSelect, b]] as const) {
      select.replaceChildren(...labels.map((label, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = label;
        return option;
      }));
      select.value = value;
    }
    pairSequence = key;
    visits = labels.map((label, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.visit = String(index);
      const preview = document.createElement("canvas");
      preview.className = "visit-preview";
      preview.setAttribute("aria-hidden", "true");
      const date = document.createElement("span");
      date.className = "visit-date";
      date.textContent = label;
      const count = document.createElement("span");
      count.className = "visit-count";
      const n = series!.counts[index];
      count.textContent = `${n} ${n === 1 ? "exposure" : "exposures"}${n < 5 && modeSelect.value !== "exposures" ? " · Shallow" : ""}`;
      const badges = document.createElement("span");
      badges.className = "visit-badges";
      badges.setAttribute("aria-hidden", "true");
      button.append(preview, date, count, badges);
      button.addEventListener("click", () => {
        pause();
        if (modeSelect.value !== "exposures") modeSelect.value = "stack";
        frame = index;
        commitView();
      });
      return button;
    });
    container.replaceChildren(...visits);
    get("visit-total").textContent = `${labels.length} ${modeSelect.value === "exposures" ? "exposures" : labels.length === 1 ? "visit" : "visits"}`;
    updateVisitBadges();
    refreshThumbnails();
  }
  // Roving focus: arrow keys step through the thumbnails.
  get("visits").addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const index = visits.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const target = visits[Math.max(0, Math.min(visits.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)))];
    target.click();
    target.focus();
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  engineSelect.addEventListener("change", () => void load());
  cacheSelect.addEventListener("change", () => void load());

  async function openExample(id: string): Promise<void> {
    const target = SkyShift.TARGETS.find((item) => item.id === id);
    if (!target || busy) return;
    closeDrop();
    if (target.id === "wise0855") {
      const previousFrame = frame;
      frame = modeSelect.value === "exposures" ? 0 : 1;
      if (await load(ASSETS.fixture)) {
        isBundled = true; currentSelection = undefined; fullBandFixture = ASSETS.fixture;
        wavelengthSelection = null; marker.checked = false;
        clearCatalogues();
        setFieldInfo(target.label, "RA 133.759765° · Dec −7.242186° · 4.42–5.00 μm · 2.1′ field", target.band, target.id);
        hideHere();
        frameField();
        commitView();
      } else frame = previousFrame;
      return;
    }
    let bundle: { fixture: SkyShift.PackedFixture } | undefined;
    if (ASSETS.examples.includes(target.id)) try {
      const response = await fetch(`examples/${target.id}.json`);
      if (response.ok) bundle = await response.json();
      else if (response.status !== 404) throw new Error("Could not load the example bundle.");
    } catch (error) {
      if (!(error instanceof TypeError)) { status.textContent = error instanceof Error ? error.message : String(error); return; }
    }
    if (!bundle) {
      // Not bundled in this build: fetch the example from the archive instead.
      fovSelect.value = "5";
      await searchFromOptions(target.ra, target.dec, undefined, target);
      return;
    }
    const previousFrame = frame; frame = 0;
    if (!await load(bundle.fixture)) { frame = previousFrame; return; }
    fullBandFixture = bundle.fixture; wavelengthSelection = null; isBundled = false;
    currentSelection = { ra: target.ra, dec: target.dec, band: target.band, fov: 5 };
    setFieldInfo(target.label, `RA ${target.ra.toFixed(6)}° · Dec ${target.dec.toFixed(6)}° · Band ${target.band} · 5′ field`, target.band, target.id);
    marker.checked = false;
    clearCatalogues();
    hideHere();
    frameField();
    commitView();
    status.textContent += " · Bundled sampled observations";
  }

  async function searchFromOptions(ra: number, dec: number, savedAsof?: string, target?: SkyShift.Target): Promise<void> {
    const band = target?.band ?? Number(bandSelect.value);
    const fov = Number(fovSelect.value);
    const from = get<HTMLInputElement>("date-from").value, to = get<HTMLInputElement>("date-to").value;
    if (!!from !== !!to || (from && (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from > to))) {
      status.textContent = "Enter both dates in chronological order, or leave both blank.";
      openDrop(); searchOptions.hidden = false; optionsToggle.setAttribute("aria-expanded", "true");
      return;
    }
    await search({ ra, dec, band, fov, from, to }, savedAsof, target);
  }

  async function search(request: { ra: number; dec: number; band: number; fov: number; from: string; to: string }, savedAsof?: string, named?: SkyShift.Target): Promise<void> {
    if (busy) return;
    const { ra, dec, band, fov, from, to } = request;
    const cutoff = savedAsof ?? new Date().toISOString();
    const cutoffMs = Date.parse(cutoff);
    if (!Number.isFinite(cutoffMs) || cutoffMs > Date.now() + 86400000) { status.textContent = "The shared cutoff date is invalid."; return; }
    pause();
    closeDrop();
    busy = true;
    updateControls();
    searchController = new AbortController();
    interrupt = () => searchController?.abort();
    try {
      status.textContent = `Searching SPHEREx observations${named ? ` of ${named.label}` : ""}…`;
      const params = new URLSearchParams({ ra: String(ra), dec: String(dec), band: String(band), fov: String(fov) });
      const startMs = from ? Date.parse(`${from}T00:00:00Z`) : (60789 - 40587) * 86400000;
      const endMs = to ? Math.min(Date.parse(`${to}T23:59:59Z`), cutoffMs) : cutoffMs;
      if (startMs > endMs) throw new Error("The date range starts after the observation cutoff.");
      params.set("fromMjd", String(startMs / 86400000 + 40587));
      params.set("toMjd", String(endMs / 86400000 + 40587));
      const response = await fetch("/api/observations?" + params, { signal: searchController.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Observation search failed.");
      if (!data.observations.length) throw new Error("No observations found for this selection.");
      const nextFixture = await SkyShift.makeLiveFixture(data.observations, ra, dec, fov, searchController.signal, (done, total) => {
        status.textContent = `Downloading ${done} of ${total} observations…`;
      }, cacheSelect.value !== "none");
      busy = false;
      const previousFrame = frame;
      frame = Math.max(0, Math.min(Number.isInteger(initialFrame) ? initialFrame : 0, nextFixture.dates.length - 1));
      if (!await load(nextFixture)) {
        frame = previousFrame;
        return;
      }
      fullBandFixture = nextFixture;
      wavelengthSelection = null;
      clearCatalogues();
      get("wave-status").textContent = "";
      isBundled = false;
      currentSelection = { ra, dec, band, fov, asof: new Date(cutoffMs).toISOString(), ...(from && to ? {from, to} : {}) };
      marker.checked = false;
      const target = named ?? SkyShift.TARGETS.find((item) => item.ra === ra && item.dec === dec);
      setFieldInfo(target?.label ?? `${ra.toFixed(5)}, ${dec.toFixed(5)}`, `RA ${ra.toFixed(6)}° · Dec ${dec.toFixed(6)}° · Band ${band} · ${fov}′ field`, band, target?.id);
      hideHere();
      frameField();
      commitView();
      status.textContent += " · Sampled observations";
      if (data.collections.some((item: { status: string }) => item.status !== "ok")) {
        status.textContent += " · Some archive collections were unavailable or truncated.";
      }
    } catch (error) {
      searchController?.abort();
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = error instanceof DOMException && error.name === "AbortError" ? "Search cancelled. Showing the previous field."
        : error instanceof TypeError || error instanceof SyntaxError
          ? `The archive search needs the SkyShift server (npm run dev). Still showing ${fieldName()}.`
          : `${message} Still showing ${fieldName()}.`;
    } finally {
      searchController = undefined;
      interrupt = undefined;
      busy = false;
      updateControls();
    }
  }
  searchAreaPill.addEventListener("click", () => {
    const [ra, dec] = toSky(...visibleCentre());
    void searchFromOptions(ra, dec);
  });

  // ----------------------------------------------------- toast and hint ----
  let toastTimer: number | undefined;
  function showToast(): void {
    toast.classList.add("show");
    clearTimeout(toastTimer);
    // Routine load results flash briefly; progress and errors stay readable longer.
    if (!busy) toastTimer = window.setTimeout(() => toast.classList.remove("show"), status.textContent === routineStatus ? 2500 : 6000);
  }
  new MutationObserver(showToast).observe(status, { childList: true, characterData: true, subtree: true });
  const hintKey = "skyshift.hint.blink";
  function maybeShowHint(): void {
    if (embed || sharedView || !isBundled || !canCompare()) return;
    try { if (localStorage.getItem(hintKey)) return; } catch { /* Storage can be unavailable; show the hint. */ }
    hint.hidden = false;
  }
  function dismissHint(): void {
    if (hint.hidden) return;
    hint.hidden = true;
    try { localStorage.setItem(hintKey, "1"); } catch { /* Not persisted in this browser. */ }
  }
  get("hint-dismiss").addEventListener("click", () => { dismissHint(); blink.focus(); });

  const dock = get("dock"), dockCollapse = get<HTMLButtonElement>("dock-collapse");
  dockCollapse.addEventListener("click", () => {
    const collapsed = dock.classList.toggle("collapsed");
    dockCollapse.setAttribute("aria-expanded", String(!collapsed));
    dockCollapse.setAttribute("aria-label", collapsed ? "Show thumbnails" : "Hide thumbnails");
  });

  get("help").addEventListener("click", () => shortcuts.showModal());
  get("shortcuts-close").addEventListener("click", () => shortcuts.close());

  // ---------------------------------------------------------- keyboard ----
  function handleEscape(): void {
    if (shortcuts.open) return;
    if (!searchDrop.hidden) { closeDrop(); return; }
    if (!layers.hidden) { setLayers(false); layersToggle.focus(); return; }
    if (selected) { hideHere(); mapCanvas.focus(); return; }
    if (!panel.hidden) { closePanel(); return; }
    if (!hint.hidden) { dismissHint(); return; }
    pause();
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { handleEscape(); return; }
    const target = event.target as HTMLElement;
    if (target.closest("input, select, textarea, [contenteditable]") || event.ctrlKey || event.metaKey || event.altKey || shortcuts.open) return;
    const onMap = target === mapCanvas || target === document.body;
    const key = event.key;
    const nudge = (event.shiftKey ? 0.5 : 0.15) * Math.min(screen.width, screen.height);
    const pans: Record<string, [number, number]> = { ArrowLeft: [nudge, 0], ArrowRight: [-nudge, 0], ArrowUp: [0, nudge], ArrowDown: [0, -nudge] };
    if (key in pans) {
      if (!onMap) return;
      event.preventDefault();
      panScreen(...pans[key]);
    } else if (key === "+" || key === "=") zoomStep(1);
    else if (key === "-" || key === "_") zoomStep(-1);
    else if (key === "0" || key === "Home") frameField();
    else if (key === " ") {
      if (!onMap) return;
      event.preventDefault();
      if (busy) return;
      if (playback) pause();
      else if (modeSelect.value === "blink") toggleBlink();
      else togglePlay();
    } else if (key === "," || key === "<") { if (!busy && !playback) manualStep(-1); }
    else if (key === "." || key === ">") { if (!busy && !playback) manualStep(1); }
    else if (key === "b" || key === "B") toggleBlink();
    else if (key === "d" || key === "D") toggleDifference();
    else if (key === "i" || key === "I") panel.hidden ? openPanel(target) : closePanel();
    else if (key === "/") { event.preventDefault(); query.focus(); }
    else if (key === "?") shortcuts.showModal();
    else return;
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
  addEventListener("pagehide", () => {
    pause();
    worker?.terminate();
    if (workerURL) URL.revokeObjectURL(workerURL);
    workerURL = undefined;
  });

  // ------------------------------------------------------------- start ----
  setFieldInfo("WISE 0855", get("coordinates").textContent ?? "", 6, "wise0855");
  resize();
  frameField();
  function applyInitialCamera(): void {
    ready = true;
    if (restoredCamera) { camera = restoredCamera; cameraIsDefault = false; cameraChanged(); }
    else frameField(legacyLevel ?? fitLevel());
    saveState();
  }
  const sharedRa = params.get("ra"), sharedDec = params.get("dec");
  const restoreWavelength = async () => {
    const min = params.get("waveMin"), max = params.get("waveMax");
    if (min !== null && max !== null) {
      get<HTMLInputElement>("wave-min").value = min; get<HTMLInputElement>("wave-max").value = max;
      await applyWavelength();
    }
  };
  if (sharedRa !== null && sharedDec !== null) {
    if (params.get("band")) bandSelect.value = params.get("band")!;
    if (params.get("fov")) fovSelect.value = params.get("fov")!;
    if (params.get("from")) get<HTMLInputElement>("date-from").value = params.get("from")!;
    if (params.get("to")) get<HTMLInputElement>("date-to").value = params.get("to")!;
    let ra: number, dec: number;
    try {
      ra = SkyShift.parseCoordinate(sharedRa, "ra");
      dec = SkyShift.parseCoordinate(sharedDec, "dec");
    } catch (error) {
      status.textContent = `Shared link: ${error instanceof Error ? error.message : String(error)}`;
      void load().then(applyInitialCamera);
      return;
    }
    query.value = `${ra.toFixed(5)}, ${dec.toFixed(5)}`;
    void searchFromOptions(ra, dec, params.get("asof") ?? undefined).then(() => {
      if (currentSelection) { applyInitialCamera(); return restoreWavelength(); }
      // The shared field failed to load: show the bundled example, keep the reason visible.
      const failure = status.textContent ?? "";
      return load().then(() => { applyInitialCamera(); status.textContent = failure; });
    });
  } else {
    void load().then(() => { applyInitialCamera(); maybeShowHint(); return restoreWavelength(); });
  }
})();
