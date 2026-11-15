/// <reference path="science.ts" />
/// <reference path="wasm.ts" />
/// <reference path="worker.ts" />
/// <reference path="coordinates.ts" />
/// <reference path="archive.ts" />
/// <reference path="spectrum.ts" />
/// <reference path="catalogue.ts" />
/// <reference path="map.ts" />
/// <reference path="track.ts" />
/// <reference path="comparison.ts" />

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
  const earlierWindowButton = get<HTMLButtonElement>("earlier-window");
  const scenarioSelect = get<HTMLSelectElement>("scenario");
  const stretchInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="stretch"]'));
  const mapLocator = get("map-locator");
  const locatorZone = get("locator-zone");
  const locatorOffset = get("locator-offset");
  const locatorCoords = get("locator-coords");
  const locatorReturn = get<HTMLButtonElement>("locator-return");
  const moversPanel = get("movers-panel");
  const moversSubtitle = get("movers-subtitle");
  const moversToggle = get<HTMLButtonElement>("movers-toggle");
  const moversFilters = get("movers-filters");
  const moversList = get<HTMLUListElement>("movers-list");
  const moversEmpty = get("movers-empty");
  const countAll = get("count-all");
  const countMover = get("count-mover");
  const countVariable = get("count-variable");
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
  let comparisonTarget: SkyShift.SpectrumTarget | null = null;
  let comparisonReference: SkyShift.SpectrumTarget | null = null;
  let comparisonResult: SkyShift.StarComparison | null = null;
  let comparisonCsvUrl: string | undefined;
  let comparisonController: AbortController | undefined;

  // Map camera and screen geometry. The projection centre is the middle of the
  // viewport; `visible` is the part of the map not covered by floating chrome.
  let camera: SkyShift.Camera = { ra: fixture.ra0, dec: fixture.dec0, z: SkyShift.MAP_DEFAULT_ZOOM };
  let cameraIsDefault = true;
  const screen = { width: innerWidth, height: innerHeight, dpr: 1 };
  const visible = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  let pointerAt: [number, number] | null = null;
  let selected: { ra: number; dec: number; label?: string; pmra?: number; pmdec?: number; epoch?: number; source?: CatalogueSource } | null = null;
  let zoomAnimation = 0;
  let zoomGoal: number | null = null; // target level of a running zoom animation
  function stopZoomAnimation(): void {
    cancelAnimationFrame(zoomAnimation);
    zoomGoal = null;
  }

  const params = new URLSearchParams(location.search);
  const hasWasm = Boolean(ASSETS.wasm);
  const rustOption = engineSelect.querySelector('option[value="rust"]') as HTMLOptionElement | null;
  const requestedEngine = params.get("engine");
  if (!hasWasm) {
    if (rustOption) rustOption.disabled = true;
    engineSelect.value = "typescript";
  } else if (requestedEngine === "rust" || requestedEngine === "typescript") {
    engineSelect.value = requestedEngine;
  }
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
    earlierWindowButton.disabled = busy;
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
    if (tracked) url.searchParams.set("mark", `${tracked.start.ra.toFixed(6)},${tracked.start.dec.toFixed(6)}`);
    else url.searchParams.delete("mark");
    url.search = url.searchParams.toString().replace(/(^|&)(at|mark)=([^&]*)/g, (_, lead: string, key: string, value: string) => `${lead}${key}=${decodeURIComponent(value)}`);
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
    const colourView = showColour && !!colour && colour.side === side;
    const limit = colourView ? 0 : paint(fieldCanvas, fieldContext, pixels, side, view);
    if (colourView) paintColour();
    const differenceScale = get("difference-scale");
    differenceScale.hidden = view !== "difference" || colourView;
    if (view === "difference") {
      get("difference-negative").textContent = `−${limit.toPrecision(2)}`;
      get("difference-positive").textContent = `+${limit.toPrecision(2)}`;
    }
    difference.setAttribute("aria-pressed", String(view === "difference"));
    const count = series.counts[frame];
    const shallow = count < 5 && modeSelect.value !== "exposures";
    const activeBand = currentSelection?.band ?? (currentTargetId ? SkyShift.TARGETS.find((t) => t.id === currentTargetId)?.band : undefined) ?? 6;
    const waveSpan = SkyShift.frameWavelengthSpan(fixture, frame, modeSelect.value === "exposures" ? "exposures" : "visits", activeBand);
    const waveText = waveSpan ? ` · ${waveSpan.min.toFixed(2)}–${waveSpan.max.toFixed(2)} μm` : "";
    observation.textContent = colourView ? `Colour composite · red band ${colour!.bands[0]} · green band ${colour!.bands[1]} · blue band ${colour!.bands[2]} · all visits`
      : arithmetic
      ? `${view === "difference" ? "Visual difference B − A" : "Visual sum A + B"} · A ${labelFor(a)} · B ${labelFor(b)}`
      : `${labelFor(frame)} · ${count} ${count === 1 ? "exposure" : "exposures"}${waveText}${shallow ? " · Shallow frame" : ""}`;
    const slot = get("active-slot");
    slot.textContent = view === "blink" ? (frame === a ? "A" : frame === b ? "B" : "") : "";
    slot.hidden = slot.textContent === "";
    fieldDateText = colourView ? `Colour · bands ${colour!.bands.join(" / ")}` : arithmetic
      ? (view === "difference" ? `B − A · ${labelFor(b)} − ${labelFor(a)}` : `A + B · ${labelFor(a)} + ${labelFor(b)}`)
      : `${labelFor(frame)} · ${count} exp${waveText}${shallow ? " · shallow" : ""}`;
    get("inspect-frame").textContent = observation.textContent;
    get("bundled-provenance").hidden = !isBundled;
    get("attribution-provenance").hidden = !isBundled;
    mapCanvas.setAttribute("aria-label", `Sky map showing ${fieldName()}, north up, east left. ${observation.textContent}`);
    visits.forEach((button, index) => {
      button.setAttribute("aria-pressed", String(!arithmetic && index === frame));
      button.tabIndex = index === Math.min(frame, visits.length - 1) ? 0 : -1;
    });
    refreshHere();
    if (tracked) drawLightCurve();
    if (comparisonResult) drawComparisonChart();
    render();
  }

  function commitView(): void {
    draw();
    updateControls();
    updateMoversPanel();
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
    drawDiscovery(ctx, k);
    drawMapOrientation(ctx, k);
    placeFieldChrome(corners);
    const bar = SkyShift.scaleBar(k);
    get("scale-line").style.width = `${bar.px}px`;
    get("scale-label").textContent = bar.label;
    updateReadout();
  }

  function headingDirection(ra1: number, dec1: number, ra2: number, dec2: number): string {
    const dra = (ra1 - ra2) * Math.cos((dec2 * Math.PI) / 180);
    const ddec = dec1 - dec2;
    const angle = ((Math.atan2(-dra, ddec) * 180) / Math.PI + 360) % 360;
    return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(angle / 22.5) % 16];
  }

  function drawMapOrientation(ctx: CanvasRenderingContext2D, k: number): void {
    if (!series) return;
    const [vx, vy] = visibleCentre();
    const [centerRa, centerDec] = toSky(vx, vy, k);
    const distArcsec = SkyShift.separation(centerRa, centerDec, fixture.ra0, fixture.dec0);
    const halfSideArcsec = (fieldSide() * fixture.scale) / 2;
    const isDragging = mapCanvas.classList.contains("dragging");

    // Target Focus Square (Empty square showing the actively focused FOV)
    const targetFovArcmin = Number(fovSelect.value) || 5;
    const targetFovArcsec = targetFovArcmin * 60;
    const fovPx = targetFovArcsec * k;
    const isOffField = distArcsec > halfSideArcsec * 0.25;

    if (isOffField || isDragging) {
      const left = vx - fovPx / 2, top = vy - fovPx / 2;
      const isLarge = fovPx >= 36;

      // Subtle translucent footprint fill
      ctx.fillStyle = "rgba(166, 232, 220, 0.04)";
      ctx.fillRect(left, top, fovPx, fovPx);

      // Dashed focus square outline
      ctx.strokeStyle = isDragging ? "#a6e8dc" : "rgba(166, 232, 220, 0.68)";
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(left, top, fovPx, fovPx);
      ctx.setLineDash([]);

      // Viewfinder corner brackets
      if (isLarge) {
        const tick = Math.min(18, Math.max(8, fovPx * 0.15));
        ctx.strokeStyle = "#a6e8dc";
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        // Top-left
        ctx.moveTo(left, top + tick); ctx.lineTo(left, top); ctx.lineTo(left + tick, top);
        // Top-right
        ctx.moveTo(left + fovPx - tick, top); ctx.lineTo(left + fovPx, top); ctx.lineTo(left + fovPx, top + tick);
        // Bottom-right
        ctx.moveTo(left + fovPx, top + fovPx - tick); ctx.lineTo(left + fovPx, top + fovPx); ctx.lineTo(left + fovPx - tick, top + fovPx);
        // Bottom-left
        ctx.moveTo(left + tick, top + fovPx); ctx.lineTo(left, top + fovPx); ctx.lineTo(left, top + fovPx - tick);
        ctx.stroke();

        // Top tag badge: "Focus area · 5′ field"
        const tagText = `Focus area · ${targetFovArcmin}′ field`;
        ctx.font = "600 10px system-ui, sans-serif";
        const tagW = ctx.measureText(tagText).width;
        ctx.fillStyle = "rgba(12, 19, 34, 0.92)";
        ctx.fillRect(vx - tagW / 2 - 6, top - 20, tagW + 12, 17);
        ctx.strokeStyle = "rgba(166, 232, 220, 0.55)";
        ctx.lineWidth = 1;
        ctx.strokeRect(vx - tagW / 2 - 6, top - 20, tagW + 12, 17);
        ctx.fillStyle = "#a6e8dc";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(tagText, vx, top - 11);

        // Bottom tag badge: "RA ..., Dec ..."
        const coordText = `${SkyShift.formatRa(centerRa, 0.1)} ${SkyShift.formatDec(centerDec, 1)}`;
        const coordW = ctx.measureText(coordText).width;
        ctx.fillStyle = "rgba(12, 19, 34, 0.92)";
        ctx.fillRect(vx - coordW / 2 - 6, top + fovPx + 3, coordW + 12, 17);
        ctx.strokeStyle = "rgba(166, 232, 220, 0.35)";
        ctx.strokeRect(vx - coordW / 2 - 6, top + fovPx + 3, coordW + 12, 17);
        ctx.fillStyle = "rgba(219, 233, 250, 0.92)";
        ctx.fillText(coordText, vx, top + fovPx + 12);
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
      }
    }

    if (isDragging || isOffField) {
      ctx.strokeStyle = "rgba(166, 232, 220, 0.45)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(vx - 11, vy); ctx.lineTo(vx - 3, vy);
      ctx.moveTo(vx + 3, vy); ctx.lineTo(vx + 11, vy);
      ctx.moveTo(vx, vy - 11); ctx.lineTo(vx, vy - 3);
      ctx.moveTo(vx, vy + 3); ctx.lineTo(vx, vy + 11);
      ctx.stroke();
    }

    const fieldPt = toScreen(fixture.ra0, fixture.dec0, k);
    if (fieldPt && distArcsec > halfSideArcsec * 0.75) {
      ctx.strokeStyle = "rgba(166, 232, 220, 0.32)";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(vx, vy);
      ctx.lineTo(fieldPt[0], fieldPt[1]);
      ctx.stroke();
      ctx.setLineDash([]);

      const mx = (vx + fieldPt[0]) / 2, my = (vy + fieldPt[1]) / 2;
      const text = `${formatAngle(distArcsec)} to ${fieldName()}`;
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = "rgba(5, 8, 15, 0.85)";
      ctx.fillRect(mx - tw / 2 - 5, my - 8, tw + 10, 16);
      ctx.strokeStyle = "rgba(166, 232, 220, 0.38)";
      ctx.lineWidth = 1;
      ctx.strokeRect(mx - tw / 2 - 5, my - 8, tw + 10, 16);
      ctx.fillStyle = "#a6e8dc";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, mx, my);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
  }

  function updateMapLocator(): void {
    if (embed || !series) {
      mapLocator.hidden = true;
      return;
    }
    mapLocator.hidden = false;
    const [centerRa, centerDec] = toSky(...visibleCentre());
    const distArcsec = SkyShift.separation(centerRa, centerDec, fixture.ra0, fixture.dec0);
    const halfSideArcsec = (fieldSide() * fixture.scale) / 2;
    const isInside = distArcsec <= halfSideArcsec * 1.05;
    const targetFovArcmin = Number(fovSelect.value) || 5;

    locatorZone.className = `locator-zone ${isInside ? "inside" : "outside"}`;
    locatorZone.textContent = isInside ? "Inside field" : "Off field";

    if (distArcsec < 3) {
      locatorOffset.textContent = `Centered on ${fieldName()} (${targetFovArcmin}′ focus)`;
      locatorReturn.hidden = true;
    } else {
      const dir = headingDirection(centerRa, centerDec, fixture.ra0, fixture.dec0);
      locatorOffset.textContent = `Focusing ${targetFovArcmin}′ field · ${formatAngle(distArcsec)} ${dir} of ${fieldName()}`;
      locatorReturn.hidden = isInside && cameraIsDefault;
    }
    locatorCoords.textContent = `${SkyShift.formatRa(centerRa, 0.01)} ${SkyShift.formatDec(centerDec, 0.1)}`;
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
      if (marker.checked && mjd !== undefined) {
        const pmTarget = (currentTargetId ? SkyShift.TARGETS.find((item) => item.id === currentTargetId) : undefined)
          ?? SkyShift.findTargetAt(fixture.ra0, fixture.dec0);
        if (pmTarget && pmTarget.pmra !== undefined && pmTarget.pmdec !== undefined) {
          const [ra, dec] = SkyShift.targetPosition(pmTarget, mjd);
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
      // Comparison Target & Reference star markers (propagated to current MJD).
      const drawCompPin = (star: SkyShift.SpectrumTarget, color: string, tag: string) => {
        const [sra, sdec] = SkyShift.exposureSkyPosition(star, mjd);
        const p = toScreen(sra, sdec, k);
        if (!p) return;
        const size = Math.max(9, 1.8 * pixelPx);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p[0], p[1] - size); ctx.lineTo(p[0] + size, p[1]);
        ctx.lineTo(p[0], p[1] + size); ctx.lineTo(p[0] - size, p[1]);
        ctx.closePath();
        ctx.stroke();
        ctx.font = "600 10px system-ui, sans-serif";
        const tw = ctx.measureText(tag).width;
        const lx = p[0] - tw / 2 - 4, ly = p[1] + size + 3;
        ctx.fillStyle = "rgba(8, 13, 24, 0.9)";
        ctx.fillRect(lx, ly, tw + 8, 14);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(lx, ly, tw + 8, 14);
        ctx.fillStyle = color;
        ctx.fillText(tag, p[0] - tw / 2, ly + 11);
        ctx.restore();
      };
      if (comparisonTarget) drawCompPin(comparisonTarget, "#a6e8dc", "Target");
      if (comparisonReference) drawCompPin(comparisonReference, "#f3c97a", "Ref");
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
    updateMapLocator();
  }

  function cameraChanged(): void {
    render();
    updateSearchArea();
    updateMapLocator();
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
      // A narrow panel covers the left side; a full-width one is a bottom sheet.
      if (panel.offsetWidth < W * 0.75) left = panel.offsetLeft + panel.offsetWidth; else bottom = Math.min(bottom, panel.offsetTop);
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
  function findCatalogueSourceAtScreen(sx: number, sy: number): { source: CatalogueSource; ra: number; dec: number } | undefined {
    const mjd = frameMjd();
    const year = mjd === undefined ? null : 2000 + (mjd - 51544.5) / 365.25;
    const hitRadius = Math.max(12, Math.min(40, 1.4 * (2 ** camera.z)) + 4);
    let best: { source: CatalogueSource; ra: number; dec: number; dist: number } | undefined;
    for (const name of ["gaia", "wise"] as const) {
      if (!get<HTMLInputElement>(name).checked) continue;
      for (const source of catalogues[name] ?? []) {
        const [ra, dec] = SkyShift.cataloguePosition(source, year);
        const p = toScreen(ra, dec);
        if (!p) continue;
        const dist = Math.hypot(p[0] - sx, p[1] - sy);
        if (dist <= hitRadius && (!best || dist < best.dist)) {
          best = { source: { ...source, catalogue: source.catalogue ?? name }, ra, dec, dist };
        }
      }
    }
    return best;
  }

  function handleTap(x: number, y: number, shift: boolean, mouse: boolean): void {
    const now = performance.now();
    if (now - lastTap.time < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 24) {
      lastTap.time = 0;
      zoomTo((zoomGoal ?? camera.z) + (shift ? -1 : 1), x, y);
      return;
    }
    lastTap = { time: now, x, y };
    const hit = findCatalogueSourceAtScreen(x, y);
    if (hit) {
      showHere(hit.ra, hit.dec, hit.source);
    } else {
      const [ra, dec] = toSky(x, y);
      showHere(ra, dec);
    }
    // Mouse users get keyboard shortcuts on the map; touch users keep their place.
    if (mouse) mapCanvas.focus({ preventScroll: true });
  }

  // "What's here" card: the single-pointer route to coordinates, values and search.
  const hereCard = get("whats-here");
  function showHere(ra: number, dec: number, source?: CatalogueSource): void {
    selected = source
      ? {
          ra,
          dec,
          label: SkyShift.formatCatalogueSource(source),
          pmra: source.pmra ?? undefined,
          pmdec: source.pmdec ?? undefined,
          epoch: source.epoch ?? undefined,
          source,
        }
      : { ra, dec };
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
    const mjd = frameMjd();
    const year = mjd === undefined ? null : 2000 + (mjd - 51544.5) / 365.25;
    if (selected.source) {
      const [propRa, propDec] = SkyShift.cataloguePosition(selected.source, year);
      selected.ra = propRa;
      selected.dec = propDec;
    }
    const { ra, dec } = selected;
    const pixel = pixelAt(ra, dec);
    const viewLabel = arithmeticView() ? (modeSelect.value === "difference" ? "B − A" : "A + B") : labelFor(frame);
    get("here-title").textContent = selected.source
      ? SkyShift.formatCatalogueSource(selected.source)
      : (pixel.inside ? `${fieldName()} · ${viewLabel}` : "Sky position");
    get("here-coords").textContent = `${SkyShift.formatRa(ra, 0.01)} ${SkyShift.formatDec(dec, 0.1)} · ${ra.toFixed(5)}°, ${dec.toFixed(5)}°`;
    const fluxPart = pixel.inside
      ? (Number.isFinite(pixel.value) ? `${valueText(pixel.value)} at this pixel` : "No data at this pixel")
      : `${formatAngle(SkyShift.separation(ra, dec, fixture.ra0, fixture.dec0))} from the ${fieldName()} field centre`;
    const epochPart = selected.source && selected.source.pmra != null && selected.source.pmdec != null && selected.source.epoch != null && year !== null
      ? ` · propagated from epoch ${selected.source.epoch}`
      : "";
    get("here-value").textContent = fluxPart + epochPart;
    get("here-track").hidden = !pixel.inside;
    get("here-set-target").hidden = !pixel.inside || embed;
    get("here-set-reference").hidden = !pixel.inside || embed;
    get("here-search").hidden = pixel.inside || embed;
  }
  get("here-close").addEventListener("click", () => { hideHere(); mapCanvas.focus(); });
  get("here-center").addEventListener("click", () => {
    if (!selected) return;
    const p = toScreen(selected.ra, selected.dec);
    const [vx, vy] = visibleCentre();
    if (p) panScreen(vx - p[0], vy - p[1]);
  });
  get("here-search").addEventListener("click", () => { if (selected) void searchFromOptions(selected.ra, selected.dec); });
  get("here-set-target").addEventListener("click", () => {
    if (!selected) return;
    setComparisonSlot("target", selectedToSpectrumTarget(selected));
    openComparisonSection();
    if (comparisonReference) void runComparison();
  });
  get("here-set-reference").addEventListener("click", () => {
    if (!selected) return;
    setComparisonSlot("reference", selectedToSpectrumTarget(selected));
    if (!comparisonTarget) {
      setComparisonSlot("target", SkyShift.resolveSpectrumTarget(fixture, currentTargetId, tracked, null));
    }
    openComparisonSection();
    if (comparisonTarget) void runComparison();
  });
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
        const enriched: CatalogueSource[] = (result.sources as CatalogueSource[]).map((item) => ({ ...item, catalogue: item.catalogue ?? name }));
        catalogues[name] = enriched;
        output.textContent = `${result.catalogue}: ${enriched.length} brightest sources${result.truncated ? " (top 250 by magnitude)" : ""}. Click any marker on the map for details.`;
        const list = document.createElement("details");
        const summary = document.createElement("summary"); summary.textContent = `${result.catalogue} sources (${enriched.length})`;
        const text = document.createElement("p");
        if (!enriched.length) {
          text.textContent = "No sources.";
        } else {
          enriched.slice(0, 60).forEach((item, idx) => {
            if (idx > 0) text.append(", ");
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "link-button";
            btn.textContent = item.magnitude != null ? `${item.id} (${item.magnitude.toFixed(1)})` : item.id;
            btn.addEventListener("click", () => {
              const mjd = frameMjd();
              const year = mjd === undefined ? null : 2000 + (mjd - 51544.5) / 365.25;
              const [ra, dec] = SkyShift.cataloguePosition(item, year);
              showHere(ra, dec, item);
              ensureVisible(ra, dec);
            });
            text.append(btn);
          });
        }
        list.append(summary, text); get("catalogue-list").append(list);
        refreshComparisonPicker();
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
    refreshComparisonPicker();
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

  const speedSelect = get<HTMLSelectElement>("speed");
  function playbackMultiplier(): number {
    const val = Number(speedSelect.value);
    return val === 0.5 || val === 2 ? val : 1;
  }

  function togglePlay(): void {
    if (playback === "visits") { pause(); return; }
    if (busy || !series || series.frames.length < 2) return;
    pause();
    colourOff();
    if (modeSelect.value !== "exposures") modeSelect.value = "stack";
    playback = "visits";
    timer = window.setInterval(() => step(1), Math.round(850 / playbackMultiplier()));
    play.textContent = "Pause";
    play.setAttribute("aria-pressed", "true");
    commitView();
  }

  function toggleBlink(): void {
    if (playback === "blink") { pause(); return; }
    if (busy || !canCompare() || modeSelect.value === "exposures") return;
    pause();
    colourOff();
    dismissHint();
    const a = Number(referenceSelect.value), b = Number(comparisonSelect.value);
    modeSelect.value = "blink";
    frame = a;
    playback = "blink";
    timer = window.setInterval(() => {
      frame = frame === a ? b : a;
      draw();
    }, Math.round(500 / playbackMultiplier()));
    blink.textContent = "Pause blink";
    blink.setAttribute("aria-pressed", "true");
    commitView();
  }

  speedSelect.addEventListener("change", () => {
    if (!playback) return;
    clearInterval(timer);
    if (playback === "visits") {
      timer = window.setInterval(() => step(1), Math.round(850 / playbackMultiplier()));
    } else if (playback === "blink") {
      const a = Number(referenceSelect.value), b = Number(comparisonSelect.value);
      timer = window.setInterval(() => {
        frame = frame === a ? b : a;
        draw();
      }, Math.round(500 / playbackMultiplier()));
    }
  });

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  async function updateCacheDiagnostics(): Promise<void> {
    const cacheStatusEl = document.getElementById("cache-status");
    if (!cacheStatusEl) return;
    try {
      const [arch, comp] = await Promise.all([
        SkyShift.cacheDiagnostics(),
        SkyShift.comparisonCacheDiagnostics(),
      ]);
      const total = arch.totalBytes + comp.bytes;
      const cropsCount = Math.max(arch.memoryCrops, arch.persistentCrops);
      cacheStatusEl.textContent = `Cache usage: ${formatBytes(total)} (${cropsCount} crop${cropsCount === 1 ? "" : "s"}, ${arch.liveFixtures} fixture${arch.liveFixtures === 1 ? "" : "s"}, ${comp.entries} stack${comp.entries === 1 ? "" : "s"}, ${arch.waveGrids} WCS-WAVE grid${arch.waveGrids === 1 ? "" : "s"})`;
    } catch {
      cacheStatusEl.textContent = "Cache usage: unavailable";
    }
  }

  async function fetchLiveInWorker(
    observations: SkyShift.Observation[],
    ra: number,
    dec: number,
    fov: number,
    signal: AbortSignal,
    progress: (done: number, total: number) => void,
    useCache: boolean,
  ): Promise<SkyShift.PackedFixture> {
    if (typeof Worker === "undefined") {
      return SkyShift.makeLiveFixture(observations, ra, dec, fov, signal, progress, useCache);
    }
    if (!workerURL) workerURL = URL.createObjectURL(new Blob([ASSETS.worker], { type: "text/javascript" }));
    const current = new Worker(workerURL);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        current.terminate();
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Cancelled", "AbortError"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
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
        if (message.type === "fixture") {
          cleanup();
          resolve(message.fixture);
          return;
        }
        if (message.type === "error") {
          cleanup();
          reject(new Error(message.message));
        }
      };
      current.postMessage({
        engine: "typescript",
        scenario: "wise0855",
        cache: "none",
        fixture,
        wasm: "",
        liveFetch: { observations, ra, dec, fov, useCache, onlyFixture: true },
      } satisfies SkyShift.WorkRequest);
    });
  }

  async function submit(
    engine: SkyShift.EngineName,
    scenario: SkyShift.Scenario,
    cache: SkyShift.CacheLevel,
    progress: (done: number, total: number) => void,
    data: SkyShift.PackedFixture = fixture,
    frameMode: "visits" | "exposures" = "visits",
    onFrame?: (index: number, total: number, side: number, count: number, pixels: Float32Array) => void,
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
        if (message.type === "frame") {
          onFrame?.(message.index, message.total, message.side, message.count, message.pixels);
          return;
        }
        if (message.type === "fixture") return;
        cleanup();
        if (message.type === "result") resolve(message.result);
        else if (message.type === "error") reject(new Error(message.message));
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
      const loaded = await submit(
        engine,
        "wise0855",
        cache,
        (done, total) => {
          status.textContent = `Aligned ${done} of ${total} ${modeSelect.value === "exposures" ? "exposures" : "visits"}…`;
        },
        data,
        modeSelect.value === "exposures" ? "exposures" : "visits",
        (index, total, side, _count, pixels) => {
          if (index === 0 && total > 1 && data === fixture) {
            paint(fieldCanvas, fieldContext, pixels, side, stretchValue());
            render();
          }
        },
      );
      // Keep the apparent zoom if a new grid uses a different pixel scale.
      if (data.scale !== fixture.scale) camera = { ...camera, z: SkyShift.clampZoom(camera.z + Math.log2(data.scale / fixture.scale)) };
      fixture = data;
      series = loaded.series;
      frame = Math.max(0, Math.min(frame, series.frames.length - 1));
      updateStretch(series);
      resetDiscovery();
      rebuildVisits();
      commitView();
      const source = {
        miss: "Computed from exposures",
        inputs: "Rebuilt from cached exposures",
        results: "Loaded cached frames",
      }[loaded.cacheHit];
      status.textContent = routineStatus = `${source} · ${nameOf(engine)} · ${elapsed(performance.now() - started)}`;
      void updateCacheDiagnostics();
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
      void updateCacheDiagnostics();
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
    try {
      await SkyShift.clearBrowserCaches();
      await updateCacheDiagnostics();
      status.textContent = "Browser image and processing caches cleared.";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
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
    const targetPos = selected
      ? { ra: selected.ra, dec: selected.dec, label: selected.label ?? `${SkyShift.formatRa(selected.ra, 0.01)} ${SkyShift.formatDec(selected.dec, 0.1)}` }
      : tracked && tracked.points.length
        ? (() => {
            const pt = tracked.points.find((p) => p.frame === frame) ?? tracked.points[0];
            return { ra: pt.ra, dec: pt.dec, label: `tracked source (${SkyShift.formatRa(pt.ra, 0.01)} ${SkyShift.formatDec(pt.dec, 0.1)})` };
          })()
        : { ra: fixture.ra0, dec: fixture.dec0, label: "field centre" };
    try {
      const [x, y] = SkyShift.worldToPixel(SkyShift.packWcs(header), targetPos.ra, targetPos.dec);
      const ix = Math.round(x), iy = Math.round(y);
      if (ix < 0 || ix >= 2040 || iy < 0 || iy >= 2040) {
        output.textContent = `The position (${targetPos.label}) falls outside detector coordinates (${ix}, ${iy}) in exposure ${index + 1}.`;
        return;
      }
      const query = new URLSearchParams({ key: header.productKey, x: String(ix), y: String(iy) });
      output.textContent = `Reading FLAGS at ${targetPos.label} for exposure ${index + 1}…`;
      const response = await fetch(`/api/quality?${query}`); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Flag inspection failed.");
      if (fixture !== requestedFixture) return;
      const names = SkyShift.decodeQualityFlags(data.combined);
      const centerVal = typeof data.center === "number" ? data.center : data.combined;
      const centerNames = SkyShift.decodeQualityFlags(centerVal);
      const flaggedCount = typeof data.flaggedPixels === "number" ? data.flaggedPixels : (data.combined ? 1 : 0);
      const totalCount = typeof data.totalPixels === "number" ? data.totalPixels : 9;
      const stackCount = series?.counts[frame] ?? 1;
      const coverage = modeSelect.value === "exposures"
        ? "single exposure"
        : `${stackCount} stacked exposure${stackCount === 1 ? "" : "s"} in visit ${frame + 1}`;
      get<HTMLInputElement>("quality-value").value = String(data.combined);
      output.textContent = `Exposure ${index + 1} (${coverage}) at ${targetPos.label}, detector pixel (${data.x}, ${data.y}): `
        + `centre mask ${centerVal} (${centerNames.length ? centerNames.join(", ") : "clean"}); `
        + `3×3 neighbourhood mask ${data.combined} (${flaggedCount}/${totalCount} pixels flagged: ${names.length ? names.join(", ") : "none"}).`;
    } catch (error) {
      output.textContent = error instanceof TypeError
        ? "Quality flag inspection requires the SkyShift server (npm run dev)."
        : error instanceof Error ? error.message : String(error);
    }
  });
  get("wave-reset").addEventListener("click", () => {
    if (busy) return;
    wavelengthSelection = null;
    frame = 0; get("wave-status").textContent = "Showing the full detector band.";
    void load(fullBandFixture);
  });
  let spectrumUrl: string | undefined;
  function revokeSpectrumUrl(): void {
    if (!spectrumUrl) return;
    URL.revokeObjectURL(spectrumUrl);
    spectrumUrl = undefined;
    const download = get<HTMLAnchorElement>("spectrum-download");
    download.removeAttribute("href");
    download.hidden = true;
  }

  const visitPalette = ["#a6e8dc", "#f3c97a", "#ff9ad5", "#80bfff", "#b8a9ff", "#ffb07c"];
  function setupHiDpiCanvas(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): CanvasRenderingContext2D {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const targetW = Math.round(cssWidth * dpr), targetH = Math.round(cssHeight * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  get("spectrum").addEventListener("click", async () => {
    const output = get("spectrum-status");
    const comparisonEl = get("spectrum-comparison");
    const chart = get<HTMLCanvasElement>("spectrum-chart");
    const download = get<HTMLAnchorElement>("spectrum-download");
    output.textContent = "Calculating spectrum…";
    chart.hidden = true;
    comparisonEl.hidden = true;
    comparisonEl.textContent = "";
    revokeSpectrumUrl();
    try {
      const spectrumTarget = SkyShift.resolveSpectrumTarget(fixture, currentTargetId, tracked, selected);
      const points = await SkyShift.quickSpectrum(fixture, new AbortController().signal, spectrumTarget);
      if (!points.length) throw new Error("No usable measurements are available at this position.");
      const W = 380, H = 165;
      const ctx = setupHiDpiCanvas(chart, W, H);
      const xs = points.map((p) => p.wavelength);
      const yLows = points.map((p) => p.flux - p.error), yHighs = points.map((p) => p.flux + p.error);
      const xmin = Math.min(...xs), xmax = Math.max(...xs);
      const ymin = Math.min(...yLows, 0), ymax = Math.max(...yHighs);
      const left = 52, right = 14, top = 26, bottom = 30;
      const plotW = W - left - right, plotH = H - top - bottom;
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = "#2a3650";
      ctx.lineWidth = 1;
      ctx.strokeRect(left, top, plotW, plotH);
      if (ymin < 0 && ymax > 0) {
        const yZero = top + (ymax - 0) / Math.max(ymax - ymin, 1e-12) * plotH;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(left, yZero); ctx.lineTo(left + plotW, yZero); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = "#a0aec4";
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillText("Flux (Jy)", 6, 14);
      ctx.fillText(`${xmin.toFixed(2)} μm`, left, H - 8);
      ctx.textAlign = "right";
      ctx.fillText(`${xmax.toFixed(2)} μm`, left + plotW, H - 8);
      ctx.fillText(ymax.toPrecision(3), left - 5, top + 9);
      ctx.fillText(ymin.toPrecision(3), left - 5, top + plotH);
      ctx.textAlign = "left";
      // Legend coloured by observation visit.
      const seenVisits = [...new Set(points.map((p) => p.visit))].sort((a, b) => a - b);
      let lx = left + 4;
      for (const v of seenVisits.slice(0, 5)) {
        const color = visitPalette[v % visitPalette.length];
        const label = (fixture.dates[v] ?? `V${v + 1}`).slice(0, 10);
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(lx + 4, 11, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#c9d4e5";
        ctx.fillText(label, lx + 10, 14);
        lx += ctx.measureText(label).width + 18;
      }
      for (const point of points) {
        const x = left + (point.wavelength - xmin) / Math.max(xmax - xmin, 1e-9) * plotW;
        const y = top + (ymax - point.flux) / Math.max(ymax - ymin, 1e-12) * plotH;
        const yLo = top + (ymax - (point.flux - point.error)) / Math.max(ymax - ymin, 1e-12) * plotH;
        const yHi = top + (ymax - (point.flux + point.error)) / Math.max(ymax - ymin, 1e-12) * plotH;
        const color = visitPalette[point.visit % visitPalette.length];
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, Math.max(top, Math.min(top + plotH, yHi)));
        ctx.lineTo(x, Math.max(top, Math.min(top + plotH, yLo)));
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, point.saturated ? 3.5 : 3, 0, Math.PI * 2);
        if (point.saturated) ctx.stroke(); else ctx.fill();
      }
      chart.hidden = false;
      const comparison = SkyShift.compareSpectrumVisits(points, fixture.dates);
      if (comparison.summary) {
        comparisonEl.textContent = comparison.summary;
        comparisonEl.hidden = false;
      }
      const csvRows = points.map((p) => `${p.wavelength},${p.bandwidth},${p.flux},${p.error},${p.visit + 1},"${p.date}",${p.mjd ?? ""},${p.mode},${p.saturated},"${p.productKey ?? ""}"`);
      spectrumUrl = URL.createObjectURL(new Blob(["wavelength_um,bandwidth_um,approx_flux_jy,flux_err_jy,visit_index,visit_date,mjd,photometry_mode,saturated,product_key\n" + csvRows.join("\n")], { type: "text/csv" }));
      download.href = spectrumUrl;
      download.hidden = false;
      const ringCount = points.filter((p) => p.mode === "ring").length;
      const modeNote = ringCount === points.length
        ? "3–6 px ring photometry (saturated core; approximate uncalibrated wing flux)"
        : ringCount > 0
          ? `2.5 px aperture (${points.length - ringCount}) + 3–6 px ring for saturated cores (${ringCount}, hollow points)`
          : "2.5 px aperture, no aperture correction";
      output.textContent = `${points.length} measurements at ${spectrumTarget.label ?? "target"} (${ seenVisits.length } ${seenVisits.length === 1 ? "visit" : "visits"}) · ${modeNote}`;
    } catch (error) { output.textContent = error instanceof Error ? error.message : String(error); }
  });

  // ------------------------------------------------ comparison star ----
  function revokeComparisonCsvUrl(): void {
    if (!comparisonCsvUrl) return;
    URL.revokeObjectURL(comparisonCsvUrl);
    comparisonCsvUrl = undefined;
    const download = get<HTMLAnchorElement>("comp-download");
    download.removeAttribute("href");
    download.hidden = true;
  }

  function catalogueSourceToTarget(src: CatalogueSource): SkyShift.SpectrumTarget {
    return {
      label: SkyShift.formatCatalogueSource(src),
      ra: src.ra,
      dec: src.dec,
      pmra: src.pmra ?? undefined,
      pmdec: src.pmdec ?? undefined,
      epoch: src.epoch ?? undefined,
    };
  }

  function selectedToSpectrumTarget(sel: NonNullable<typeof selected>): SkyShift.SpectrumTarget {
    if (sel.source) return catalogueSourceToTarget(sel.source);
    const known = SkyShift.findTargetAt(sel.ra, sel.dec, 0.005);
    if (known) return known;
    return {
      label: sel.label ?? `${SkyShift.formatRa(sel.ra, 0.01)} ${SkyShift.formatDec(sel.dec, 0.1)}`,
      ra: sel.ra,
      dec: sel.dec,
      pmra: sel.pmra,
      pmdec: sel.pmdec,
      epoch: sel.epoch,
    };
  }

  function formatStarSummary(star: SkyShift.SpectrumTarget | null, placeholder: string): string {
    if (!star) return placeholder;
    const name = star.label ?? "Selected star";
    const coords = `${SkyShift.formatRa(star.ra, 0.01)} ${SkyShift.formatDec(star.dec, 0.1)}`;
    const pm = star.pmra !== undefined && star.pmdec !== undefined
      ? ` · μ=(${(star.pmra / 1000).toFixed(2)}″, ${(star.pmdec / 1000).toFixed(2)}″)/yr${star.epoch ? ` @ ${star.epoch}` : ""}`
      : "";
    return `${name} · ${coords}${pm}`;
  }

  function updateComparisonSlots(): void {
    get("comp-target-info").textContent = formatStarSummary(
      comparisonTarget,
      "None selected — click a star on the map or use tracked object.",
    );
    get("comp-ref-info").textContent = formatStarSummary(
      comparisonReference,
      "None selected — click any star / Gaia source on the map or choose below.",
    );
    get<HTMLButtonElement>("comp-target-clear").disabled = !comparisonTarget;
    get<HTMLButtonElement>("comp-ref-clear").disabled = !comparisonReference;
    get<HTMLButtonElement>("comp-swap").disabled = !comparisonTarget && !comparisonReference;
  }

  function setComparisonSlot(role: "target" | "reference", star: SkyShift.SpectrumTarget | null): void {
    if (role === "target") comparisonTarget = star;
    else comparisonReference = star;
    comparisonResult = null;
    get("comp-results").hidden = true;
    revokeComparisonCsvUrl();
    updateComparisonSlots();
    render();
  }

  function openComparisonSection(): void {
    const details = get<HTMLDetailsElement>("comparison-tools");
    details.open = true;
    openPanel();
    details.scrollIntoView({ block: "nearest" });
  }

  function refreshComparisonPicker(): void {
    const picker = get<HTMLSelectElement>("comp-ref-picker");
    const first = document.createElement("option");
    first.value = "";
    const allSources: { key: string; label: string; src: CatalogueSource }[] = [];
    for (const catName of ["gaia", "wise"] as const) {
      const list = catalogues[catName] ?? [];
      list.forEach((src, i) => {
        const tag = catName === "wise" ? "CatWISE2020" : "Gaia DR3";
        const mag = src.magnitude != null && Number.isFinite(src.magnitude)
          ? ` (${catName === "wise" ? "W1" : "G"}=${src.magnitude.toFixed(1)})`
          : "";
        allSources.push({ key: `${catName}:${i}`, label: `${tag} ${src.id}${mag}`, src });
      });
    }
    first.textContent = allSources.length
      ? `Choose from ${allSources.length} loaded catalogue source(s)…`
      : "Load Gaia DR3 or CatWISE2020 overlays first…";
    picker.replaceChildren(first, ...allSources.map((entry) => {
      const opt = document.createElement("option");
      opt.value = entry.key;
      opt.textContent = entry.label;
      return opt;
    }));
  }

  get<HTMLSelectElement>("comp-ref-picker").addEventListener("change", (event) => {
    const val = (event.target as HTMLSelectElement).value;
    if (!val) return;
    const [catName, idxStr] = val.split(":");
    const src = catalogues[catName]?.[Number(idxStr)];
    if (!src) return;
    setComparisonSlot("reference", catalogueSourceToTarget(src));
    if (!comparisonTarget) {
      setComparisonSlot("target", SkyShift.resolveSpectrumTarget(fixture, currentTargetId, tracked, null));
    }
    const mjd = frameMjd();
    const year = mjd === undefined ? null : SkyShift.mjdToJulianYear(mjd);
    const [ra, dec] = SkyShift.cataloguePosition(src, year);
    ensureVisible(ra, dec);
    if (comparisonTarget && comparisonReference) void runComparison();
  });

  get("comp-use-tracked").addEventListener("click", () => {
    const target = SkyShift.resolveSpectrumTarget(fixture, currentTargetId, tracked, selected);
    setComparisonSlot("target", target);
    if (comparisonTarget && comparisonReference) void runComparison();
  });
  get("comp-target-clear").addEventListener("click", () => setComparisonSlot("target", null));
  get("comp-ref-clear").addEventListener("click", () => {
    get<HTMLSelectElement>("comp-ref-picker").value = "";
    setComparisonSlot("reference", null);
  });
  get("comp-swap").addEventListener("click", () => {
    const prevTarget = comparisonTarget;
    comparisonTarget = comparisonReference;
    comparisonReference = prevTarget;
    comparisonResult = null;
    get("comp-results").hidden = true;
    revokeComparisonCsvUrl();
    updateComparisonSlots();
    render();
    if (comparisonTarget && comparisonReference) void runComparison();
  });
  get("comp-load-gaia").addEventListener("click", () => {
    const box = get<HTMLInputElement>("gaia");
    if (!box.checked) {
      box.checked = true;
      void toggleCatalogue("gaia");
    } else if (!catalogues.gaia) {
      void toggleCatalogue("gaia");
    } else {
      get("comp-status").textContent = `${catalogues.gaia.length} Gaia DR3 sources ready in the dropdown or on the map.`;
    }
  });

  function drawComparisonChart(): void {
    const comp = comparisonResult;
    const canvas = get<HTMLCanvasElement>("comp-chart");
    if (!comp) return;
    const validVisits = comp.visits.filter((v) => v.ratio !== null && v.target !== null && v.reference !== null);
    if (!validVisits.length) {
      canvas.hidden = true;
      return;
    }
    canvas.hidden = false;
    const W = 380, H = 250;
    const ctx = setupHiDpiCanvas(canvas, W, H);
    ctx.clearRect(0, 0, W, H);

    const mjds = comp.visits.map((v) => v.mjd).filter((m): m is number => m !== null && Number.isFinite(m));
    const useMjd = mjds.length === validVisits.length && mjds.length >= 2 && Math.max(...mjds) > Math.min(...mjds);
    const minMjd = useMjd ? Math.min(...mjds) : 0;
    const maxMjd = useMjd ? Math.max(...mjds) : Math.max(comp.visits.length - 1, 1);
    const left = 54, right = 12, xSpan = W - left - right;
    const xOf = (v: SkyShift.VisitComparison) => {
      if (useMjd && v.mjd !== null) return left + (v.mjd - minMjd) / Math.max(maxMjd - minMjd, 1e-6) * xSpan;
      return left + (v.visit / Math.max(comp.visits.length - 1, 1)) * xSpan;
    };

    const maxTargetFlux = Math.max(...validVisits.map((v) => Math.abs(v.target!.value)));
    const maxRefFlux = Math.max(...validVisits.map((v) => Math.abs(v.reference!.value)));
    const fluxFormat = (maxAbs: number) => maxAbs >= 0.1
      ? { scale: 1, unit: "Jy" }
      : { scale: 1e3, unit: "mJy" };
    const tFmt = fluxFormat(maxTargetFlux);
    const rFmt = fluxFormat(maxRefFlux);

    const panels: {
      top: number; height: number; title: string; color: string; zeroLine?: number;
      series: { visit: number; val: number; err: number; estimate: boolean }[];
    }[] = [
      {
        top: 16, height: 54, title: `Target (${tFmt.unit})`, color: "#a6e8dc",
        series: validVisits.map((v) => ({
          visit: v.visit, val: v.target!.value * tFmt.scale, err: v.target!.error * tFmt.scale,
          estimate: comp.mode === "estimate",
        })),
      },
      {
        top: 86, height: 54, title: `Reference (${rFmt.unit})`, color: "#f3c97a",
        series: validVisits.map((v) => ({
          visit: v.visit, val: v.reference!.value * rFmt.scale, err: v.reference!.error * rFmt.scale,
          estimate: comp.mode === "estimate",
        })),
      },
      {
        top: 156, height: 60, title: "Differential Δmag (up=brighter)", color: "#ff9ad5", zeroLine: 0,
        series: validVisits.filter((v) => v.deltaMag !== null).map((v) => ({
          visit: v.visit, val: v.deltaMag!.value, err: v.deltaMag!.error,
          estimate: comp.mode === "estimate",
        })),
      },
    ];

    for (const p of panels) {
      ctx.strokeStyle = "#26324a";
      ctx.lineWidth = 1;
      ctx.strokeRect(left, p.top, xSpan, p.height);
      ctx.fillStyle = "#c9d4e5";
      ctx.font = "600 10px system-ui, sans-serif";
      ctx.fillText(p.title, left, p.top - 4);
      if (!p.series.length) continue;

      let lo = Math.min(...p.series.map((s) => s.val - s.err));
      let hi = Math.max(...p.series.map((s) => s.val + s.err));
      if (p.zeroLine !== undefined) {
        lo = Math.min(lo, -0.05);
        hi = Math.max(hi, 0.05);
      }
      const pad = Math.max((hi - lo) * 0.15, p.zeroLine !== undefined ? 0.02 : 1e-6);
      lo -= pad; hi += pad;
      const yOf = (val: number) => p.zeroLine !== undefined
        // Differential magnitude panel: smaller / negative Δmag is brighter (higher on plot).
        ? p.top + ((val - lo) / Math.max(hi - lo, 1e-12)) * p.height
        : p.top + ((hi - val) / Math.max(hi - lo, 1e-12)) * p.height;

      if (p.zeroLine !== undefined) {
        const y0 = yOf(p.zeroLine);
        ctx.strokeStyle = "#3a4a68";
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(left, y0); ctx.lineTo(left + xSpan, y0); ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle = "#8d9bb3";
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "right";
      const topLabel = p.zeroLine !== undefined ? `${lo >= 0 ? "+" : ""}${lo.toFixed(2)}` : hi.toPrecision(3);
      const botLabel = p.zeroLine !== undefined ? `${hi >= 0 ? "+" : ""}${hi.toFixed(2)}` : lo.toPrecision(3);
      ctx.fillText(topLabel, left - 4, p.top + 8);
      ctx.fillText(botLabel, left - 4, p.top + p.height);
      ctx.textAlign = "left";

      // Connecting line
      ctx.strokeStyle = p.color + "88";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      p.series.forEach((pt, idx) => {
        const v = comp.visits[pt.visit];
        const x = xOf(v), y = yOf(pt.val);
        if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Points + error bars
      for (const pt of p.series) {
        const v = comp.visits[pt.visit];
        const x = xOf(v), y = yOf(pt.val);
        const yLo = Math.max(p.top, Math.min(p.top + p.height, yOf(pt.val - pt.err)));
        const yHi = Math.max(p.top, Math.min(p.top + p.height, yOf(pt.val + pt.err)));
        ctx.strokeStyle = p.color;
        ctx.fillStyle = pt.estimate ? "#0b111c" : p.color;
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(x, yLo); ctx.lineTo(x, yHi); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, pt.visit === frame ? 4 : 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (pt.visit === frame && !arithmeticView()) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(x, y, 6.2, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }

    // Shared X-axis visit labels
    ctx.fillStyle = "#95a3bd";
    ctx.font = "9px ui-monospace, monospace";
    const every = Math.max(1, Math.ceil(validVisits.length / 4));
    for (let i = 0; i < validVisits.length; i += every) {
      const v = validVisits[i];
      const x = xOf(v);
      ctx.textAlign = i === 0 ? "left" : i >= validVisits.length - 1 ? "right" : "center";
      ctx.fillText(labelFor(v.visit).slice(0, 10), x, H - 14);
      if (v.waveMin !== null && v.waveMax !== null) {
        ctx.fillText(`${v.waveMin.toFixed(1)}–${v.waveMax.toFixed(1)}μm`, x, H - 3);
      }
    }
    ctx.textAlign = "left";
  }

  async function runComparison(): Promise<void> {
    if (!series) return;
    if (!comparisonTarget) {
      comparisonTarget = SkyShift.resolveSpectrumTarget(fixture, currentTargetId, tracked, selected);
      updateComparisonSlots();
    }
    if (!comparisonReference) {
      get("comp-status").textContent = "Choose a reference star from Gaia DR3, CatWISE2020, or by clicking on the map.";
      return;
    }
    comparisonController?.abort();
    const controller = new AbortController();
    comparisonController = controller;
    const output = get("comp-status");
    const resultsBox = get("comp-results");
    resultsBox.hidden = true;
    revokeComparisonCsvUrl();
    output.textContent = "Measuring target and reference brightness across exposures…";

    try {
      const exposures = SkyShift.decodeFixture(fixture);
      const targetSeries = await SkyShift.measureStarSeries(fixture, comparisonTarget, controller.signal, exposures);
      const refSeries = await SkyShift.measureStarSeries(fixture, comparisonReference, controller.signal, exposures);
      if (controller.signal.aborted) return;

      let flagsUnavailable = 0;
      if (get<HTMLInputElement>("comp-check-flags").checked) {
        output.textContent = "Inspecting SPHEREx FLAGS around target and reference apertures…";
        const flagCache = new Map<string, number>();
        const queryFlag = async (m: SkyShift.StarMeasurement): Promise<void> => {
          if ((m.status !== "measured" && m.status !== "estimate") || !m.productKey || m.detectorX === null || m.detectorY === null) return;
          const ix = Math.round(m.detectorX), iy = Math.round(m.detectorY);
          if (ix < 0 || ix >= 2040 || iy < 0 || iy >= 2040) return;
          const cacheKey = `${m.productKey}:${ix}:${iy}`;
          if (flagCache.has(cacheKey)) { m.flags = flagCache.get(cacheKey)!; return; }
          try {
            const q = new URLSearchParams({ key: m.productKey, x: String(ix), y: String(iy) });
            const res = await fetch(`/api/quality?${q}`, { signal: controller.signal });
            if (!res.ok) { flagsUnavailable++; return; }
            const data = await res.json();
            if (typeof data.combined === "number") {
              flagCache.set(cacheKey, data.combined);
              m.flags = data.combined;
            }
          } catch (err) {
            if (controller.signal.aborted) throw err;
            flagsUnavailable++;
          }
        };
        for (const m of targetSeries) await queryFlag(m);
        for (const m of refSeries) await queryFlag(m);
      }

      const midMjd = fixture.headers.map((h) => h.mjd).find((m): m is number => m !== undefined && Number.isFinite(m));
      const [tRa, tDec] = SkyShift.exposureSkyPosition(comparisonTarget, midMjd);
      const [rRa, rDec] = SkyShift.exposureSkyPosition(comparisonReference, midMjd);
      const sepArcsec = SkyShift.separation(tRa, tDec, rRa, rDec);
      const comp = SkyShift.compareStars(targetSeries, refSeries, fixture.dates, sepArcsec);
      comparisonResult = comp;

      const assessEl = get("comp-assessment");
      assessEl.className = `comp-assessment ${comp.assessment.severity}`;
      assessEl.replaceChildren();
      const verdictHead = document.createElement("strong");
      verdictHead.textContent = comp.verdictText;
      assessEl.append(verdictHead);
      const metaLine = document.createElement("div");
      const modeText = comp.mode === "estimate"
        ? "Estimate mode (3–6 px wing ring for saturated cores)"
        : comp.mode === "measured"
          ? "Measured mode (2.5 px aperture)"
          : "No usable pairs";
      metaLine.textContent = `${comp.usablePairs} of ${comp.pairs.length} paired exposures usable · Separation ${sepArcsec.toFixed(1)}″ · ${modeText}${comp.chi2 !== null && comp.dof > 0 ? ` · χ²/dof = ${(comp.chi2 / comp.dof).toFixed(2)}` : ""}`;
      assessEl.append(metaLine);
      if (comp.assessment.reasons.length || flagsUnavailable) {
        const ul = document.createElement("ul");
        for (const reason of comp.assessment.reasons) {
          const li = document.createElement("li"); li.textContent = reason; ul.append(li);
        }
        if (flagsUnavailable) {
          const li = document.createElement("li");
          li.textContent = `FLAGS metadata could not be queried for ${flagsUnavailable} aperture lookup(s); pixel-flag rejection skipped where unavailable.`;
          ul.append(li);
        }
        assessEl.append(ul);
      }

      // Render matched-wavelength bins table
      const binsBox = get("comp-bins");
      binsBox.replaceChildren();
      if (comp.bins.length) {
        const tbl = document.createElement("table");
        const thead = tbl.createTHead().insertRow();
        for (const h of ["Matched λ", "Δmag (max−min)", "Significance"]) {
          const th = document.createElement("th"); th.textContent = h; thead.append(th);
        }
        const tbody = tbl.createTBody();
        for (const b of comp.bins) {
          const row = tbody.insertRow();
          row.insertCell().textContent = `${b.minWave.toFixed(2)}–${b.maxWave.toFixed(2)} μm`;
          row.insertCell().textContent = b.deltaMag !== null && b.deltaMagError !== null
            ? `${b.deltaMag.toFixed(3)} ± ${b.deltaMagError.toFixed(3)}`
            : "–";
          row.insertCell().textContent = b.sigma !== null
            ? `${b.sigma.toFixed(1)}σ${b.significant ? " ★" : ""}`
            : "<2 visits";
        }
        binsBox.append(tbl);
      }

      // Render per-visit table
      const vTable = get<HTMLTableElement>("comp-visits-table");
      vTable.replaceChildren();
      const vHead = vTable.createTHead().insertRow();
      for (const h of ["Visit", "MJD", "Pairs", "λ (μm)", "Target (Jy)", "Ref (Jy)", "Ratio", "Δmag"]) {
        const th = document.createElement("th"); th.textContent = h; vHead.append(th);
      }
      const vBody = vTable.createTBody();
      for (const v of comp.visits) {
        const row = vBody.insertRow();
        row.insertCell().textContent = labelFor(v.visit).slice(0, 10);
        row.insertCell().textContent = v.mjd !== null ? v.mjd.toFixed(2) : "–";
        row.insertCell().textContent = String(v.pairs);
        row.insertCell().textContent = v.waveMin !== null && v.waveMax !== null ? `${v.waveMin.toFixed(2)}–${v.waveMax.toFixed(2)}` : "–";
        row.insertCell().textContent = v.target ? `${v.target.value.toPrecision(3)} ± ${v.target.error.toPrecision(2)}` : "–";
        row.insertCell().textContent = v.reference ? `${v.reference.value.toPrecision(3)} ± ${v.reference.error.toPrecision(2)}` : "–";
        row.insertCell().textContent = v.ratio ? `${v.ratio.value.toPrecision(3)} ± ${v.ratio.error.toPrecision(2)}` : "–";
        row.insertCell().textContent = v.deltaMag ? `${v.deltaMag.value >= 0 ? "+" : ""}${v.deltaMag.value.toFixed(3)}` : "–";
      }

      // Assumptions list
      const assumEl = get("comp-assumptions");
      assumEl.replaceChildren(...comp.assumptions.map((text) => {
        const li = document.createElement("li"); li.textContent = text; return li;
      }));

      // CSV export
      const csvHeader = "exposure,visit,date,mjd,mode,usable,reason,target_status,target_flux_jy,target_err_jy,target_wave_um,ref_status,ref_flux_jy,ref_err_jy,ref_wave_um,ratio,ratio_err";
      const csvLines = comp.pairs.map((p) => [
        p.exposure + 1, p.visit + 1, `"${p.date}"`, p.mjd ?? "", p.mode ?? "", p.usable,
        `"${(p.reason ?? "").replaceAll('"', '""')}"`,
        p.target.status, p.target.flux ?? "", p.target.error ?? "", p.target.wavelength ?? "",
        p.reference.status, p.reference.flux ?? "", p.reference.error ?? "", p.reference.wavelength ?? "",
        p.ratio ?? "", p.ratioError ?? "",
      ].join(","));
      comparisonCsvUrl = URL.createObjectURL(new Blob([csvHeader + "\n" + csvLines.join("\n")], { type: "text/csv" }));
      const dl = get<HTMLAnchorElement>("comp-download");
      dl.href = comparisonCsvUrl;
      dl.hidden = false;

      resultsBox.hidden = false;
      drawComparisonChart();
      output.textContent = `Comparison complete: ${comp.usablePairs} usable pairs across ${comp.visits.filter((v) => v.ratio).length} visit(s).`;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      output.textContent = error instanceof Error ? error.message : String(error);
    }
  }
  get("comp-run").addEventListener("click", () => void runComparison());
  updateComparisonSlots();
  run.addEventListener("click", () => void benchmarkEngines());
  cancel.addEventListener("click", () => interrupt?.());
  function manualStep(delta: number): void {
    pause();
    colourOff();
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
    colourOff();
    modeSelect.value = modeSelect.value === "difference" ? "stack" : "difference";
    commitView();
  }
  difference.addEventListener("click", toggleDifference);
  marker.addEventListener("change", render);
  for (const select of [referenceSelect, comparisonSelect]) select.addEventListener("change", () => {
    pause();
    candidates = [];
    candidateNames.clear();
    candidateLookups.clear();
    if (modeSelect.value === "blink") frame = Number(referenceSelect.value);
    updateVisitBadges();
    commitView();
    updateMoversPanel();
  });
  for (const input of stretchInputs) input.addEventListener("change", () => {
    pause();
    refreshThumbnails();
    commitView();
  });

  // -------------------------------------------------------- discovery ----
  // Track & identify, the mover finder, colour composites and reports.
  type Tracked = {
    start: { ra: number; dec: number; frame: number };
    points: SkyShift.TrackPoint[]; motion: SkyShift.Motion | null; light: SkyShift.Brightness;
    id: SkyShift.Identification | null; idStatus: string; verdict: SkyShift.Verdict;
  };
  let tracked: Tracked | null = null;
  let trackToken = 0;
  let candidates: SkyShift.MoverCandidate[] = [];
  let candidateIndex = 0;
  let colour: { bands: number[]; channels: Float32Array[]; side: number } | null = null;
  let showColour = false;
  const objectSection = get("object"), candidateCard = get("candidates");

  /** Mean MJD of each loaded frame (each exposure, or the exposures in each visit). */
  function frameMjds(): (number | null)[] {
    if (!series) return [];
    if (modeSelect.value === "exposures") return series.frames.map((_, i) => fixture.headers[i]?.mjd ?? null);
    let offset = 0;
    return fixture.visitSizes.map((size) => {
      const values = fixture.headers.slice(offset, offset + size).map((h) => h.mjd).filter((m): m is number => m !== undefined && Number.isFinite(m));
      offset += size;
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    });
  }

  function resetDiscovery(): void {
    tracked = null; trackToken++;
    objectSection.hidden = true;
    candidates = []; candidateCard.hidden = true;
    candidateNames.clear();
    candidateLookups.clear();
    updateMoversPanel();
    colour = null; showColour = false;
    get("colour-status").textContent = "";
    revokeSpectrumUrl();
    get("spectrum-chart").hidden = true;
    get("spectrum-comparison").hidden = true;
    get("spectrum-comparison").textContent = "";
    get("spectrum-status").textContent = "";
    comparisonController?.abort();
    comparisonTarget = null;
    comparisonReference = null;
    comparisonResult = null;
    revokeComparisonCsvUrl();
    get("comp-results").hidden = true;
    get("comp-status").textContent = "";
    get<HTMLSelectElement>("comp-ref-picker").value = "";
    updateComparisonSlots();
    updateColourToggle();
  }

  function ensureVisible(ra: number, dec: number): void {
    const p = toScreen(ra, dec);
    if (!p) return;
    if (p[0] < visible.left + 40 || p[0] > visible.right - 40 || p[1] < visible.top + 30 || p[1] > visible.bottom - 40) {
      const [vx, vy] = visibleCentre();
      panScreen(vx - p[0], vy - p[1]);
    }
  }

  function trackAt(ra: number, dec: number, startFrame = frame): boolean {
    if (!series) return false;
    const side = series.side;
    const [x, y] = SkyShift.fieldPixel(fixture, ra, dec);
    if (!(x >= 0 && y >= 0 && x < side && y < side)) { status.textContent = "Tracking works on sources inside the SPHEREx field."; return false; }
    const hintMotion = selected && selected.pmra !== undefined && selected.pmdec !== undefined && SkyShift.separation(ra, dec, selected.ra, selected.dec) < 5
      ? { pmra: selected.pmra, pmdec: selected.pmdec }
      : undefined;
    const points = SkyShift.trackSource(series.frames, side, startFrame, x, y, fixture, frameMjds(), hintMotion);
    if (!points) { status.textContent = "No source bright enough to track here. Click on a star or a bright spot."; return false; }
    const motion = SkyShift.fitMotion(points), light = SkyShift.brightness(points, series.frames.length);
    const at = points.find((p) => p.frame === startFrame) ?? points[0];
    tracked = {
      start: { ra: at.ra, dec: at.dec, frame: startFrame }, points, motion, light, id: null,
      idStatus: "Checking SIMBAD, Gaia DR3 and SkyBoT…", verdict: SkyShift.classifyObject(points, series.frames.length, motion, light, null),
    };
    const token = ++trackToken;
    dismissHint();
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : mapCanvas;
    hideHere();
    objectSection.hidden = false;
    renderObject();
    openPanel(opener, [at.ra, at.dec]);
    objectSection.scrollIntoView({ block: "start" });
    render();
    saveState();
    void identifyTracked(token);
    return true;
  }

  async function identifyTracked(token: number): Promise<void> {
    const t = tracked;
    if (!t) return;
    const best = t.points.find((p) => p.frame === t.start.frame) ?? t.points[0];
    const mjd = best.mjd ?? frameMjds().find((m): m is number => m !== null) ?? 61000;
    const epochs = [...new Set(t.points.map((p) => p.mjd).filter((m): m is number => m !== null))].slice(0, 4);
    const query = new URLSearchParams({ ra: best.ra.toFixed(6), dec: best.dec.toFixed(6), mjd: mjd.toFixed(4),
      radius: best.saturated ? "12" : "8", epochs: (epochs.length ? epochs : [mjd]).map((m) => m.toFixed(4)).join(",") });
    let identification: SkyShift.Identification | null = null, note = "";
    try {
      const response = await fetch(`/api/identify?${query}`);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error(response.status === 404 || !data ? "server" : data.error ?? `HTTP ${response.status}`);
      identification = data;
      const down = (["simbad", "gaia", "skybot"] as const).filter((key) => data[key].status !== "ok");
      if (down.length) note = `Not checked: ${down.map((key) => data[key].status).join(" ")}`;
    } catch (error) {
      note = error instanceof TypeError || (error instanceof Error && error.message === "server")
        ? "Catalogue identification needs the SkyShift server (npm run dev); showing measurements only."
        : `Identification failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (token !== trackToken || !tracked) return;
    const catMotion = identification?.gaia.matches.find((m) => m.pmra !== null && m.pmdec !== null)
      ?? identification?.simbad.matches.find((m) => m.pmra !== null && m.pmdec !== null);
    if (catMotion && catMotion.pmra !== null && catMotion.pmdec !== null && series && tracked.points.length < series.frames.length) {
      const [sx, sy] = SkyShift.fieldPixel(fixture, tracked.start.ra, tracked.start.dec);
      const rerun = SkyShift.trackSource(series.frames, series.side, tracked.start.frame, sx, sy, fixture, frameMjds(), {
        pmra: catMotion.pmra,
        pmdec: catMotion.pmdec,
      });
      if (rerun && rerun.length > tracked.points.length) {
        tracked.points = rerun;
        tracked.motion = SkyShift.fitMotion(rerun);
        tracked.light = SkyShift.brightness(rerun, series.frames.length);
      }
    }
    tracked.id = identification;
    tracked.idStatus = note;
    tracked.verdict = SkyShift.classifyObject(tracked.points, series?.frames.length ?? 0, tracked.motion, tracked.light, identification);
    renderObject();
    render();
  }

  const compass = (angle: number) => ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(angle / 45) % 8];
  const distanceText = (pc: number) => pc < 100 ? `${pc.toFixed(1)} pc (${(pc * 3.2616).toFixed(1)} light-years)` : `${pc.toFixed(0)} pc`;

  function renderObject(): void {
    const t = tracked;
    if (!t) { objectSection.hidden = true; return; }
    const frames = series?.frames.length ?? 0;
    const verdict = get("object-verdict");
    verdict.className = `verdict ${t.verdict.tone}`;
    verdict.textContent = t.verdict.label;
    get("object-reasons").replaceChildren(...[...t.verdict.reasons, ...(t.idStatus ? [t.idStatus] : [])].map((text) => {
      const item = document.createElement("li"); item.textContent = text; return item;
    }));
    const facts: [string, string | Node][] = [];
    const at = t.points.find((p) => p.frame === t.start.frame) ?? t.points[0];
    const knownTarget = SkyShift.findTargetAt(at.ra, at.dec, 0.02);
    const star = t.id?.simbad.matches.find((m) => m.type !== "Pl") ?? t.id?.simbad.matches[0];
    const sso = t.id?.skybot.matches?.[0];
    const gaia = t.id?.gaia.matches?.[0];
    const gaiaDisplay = gaia ? (gaia.name.startsWith("Gaia") ? gaia.name : `Gaia DR3 ${gaia.name}`) : undefined;
    const objName = sso?.name ?? star?.name ?? knownTarget?.label ?? (gaiaDisplay ?? (selected?.label ?? "Tracked source"));
    get("object-title").textContent = `Tracked object: ${objName}`;
    facts.push(["Position", `${SkyShift.formatRa(at.ra, 0.01)} ${SkyShift.formatDec(at.dec, 0.1)} in ${labelFor(at.frame)}`]);
    facts.push(["Seen in", `${t.points.length} of ${frames} ${modeSelect.value === "exposures" ? "exposures" : "visits"}${t.points.some((p) => p.saturated) ? " · saturated core" : ""}`]);
    if (t.motion) facts.push(["Motion", t.motion.significant
      ? `${t.motion.total.toFixed(2)} ± ${t.motion.error.toFixed(2)}″/yr toward the ${compass(t.motion.angle)} (PA ${t.motion.angle.toFixed(0)}°)`
      : `None detected (below about ${Math.max(3 * t.motion.error, 1.2 / t.motion.spanYears).toFixed(1)}″/yr)`]);
    if (star) {
      const link = document.createElement("a");
      link.href = `https://simbad.cds.unistra.fr/simbad/sim-id?Ident=${encodeURIComponent(star.name)}`;
      link.target = "_blank"; link.rel = "noopener"; link.textContent = star.name;
      const text = document.createElement("span");
      text.append(link, ` · ${star.description}${star.spectralType ? `, ${star.spectralType}` : ""}`);
      facts.push(["SIMBAD", text]);
      if (star.pmra !== null && star.pmdec !== null) facts.push(["Catalogue motion", `${(Math.hypot(star.pmra, star.pmdec) / 1000).toFixed(2)}″/yr`]);
      if (star.parallax && star.parallax > 0) facts.push(["Distance", `about ${distanceText(1000 / star.parallax)}`]);
    }
    if (gaia) facts.push(["Gaia DR3", `G = ${gaia.magnitude?.toFixed(2) ?? "–"}${gaia.colour != null ? `, BP−RP = ${gaia.colour.toFixed(2)}` : ""}${!star && gaia.parallax && gaia.parallax > 0 ? `, about ${distanceText(1000 / gaia.parallax)}` : ""}`]);
    for (const sso of t.id?.skybot.matches ?? []) facts.push(["Solar system", `${sso.number ? `(${sso.number}) ` : ""}${sso.name} · ${sso.kind} · V ≈ ${sso.magnitude ?? "–"} · ${sso.separation.toFixed(0)}″ away`]);
    get("object-facts").replaceChildren(...facts.flatMap(([term, value]) => {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = term; dd.append(value);
      return [dt, dd];
    }));
    const table = get<HTMLTableElement>("object-table");
    table.replaceChildren();
    const head = table.createTHead().insertRow();
    for (const label of [modeSelect.value === "exposures" ? "Exposure" : "Visit", "RA", "Dec", "S/N", "Δmag"]) {
      const th = document.createElement("th"); th.scope = "col"; th.textContent = label; head.append(th);
    }
    const body = table.createTBody();
    for (let f = 0; f < frames; f++) {
      const p = t.points.find((q) => q.frame === f), dm = t.light.deltaMag[f];
      const row = body.insertRow();
      for (const value of [labelFor(f), p ? SkyShift.formatRa(p.ra, 0.01) : "not found", p ? SkyShift.formatDec(p.dec, 0.1) : "",
        p ? (p.saturated ? "saturated" : p.snr.toFixed(0)) : "", dm !== null ? `${dm >= 0 ? "+" : "−"}${Math.abs(dm).toFixed(2)}` : "–"]) row.insertCell().textContent = value;
    }
    drawLightCurve();
  }

  function drawLightCurve(): void {
    const t = tracked, canvas = get<HTMLCanvasElement>("object-curve");
    if (!t) return;
    const W = 340, H = 125, left = 46, right = 12, top = 16, bottom = 28;
    const plotW = W - left - right, plotH = H - top - bottom;
    const ctx = setupHiDpiCanvas(canvas, W, H);
    ctx.clearRect(0, 0, W, H);
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = "#a0aec4";
    const frames = series?.frames.length ?? 0;
    const mjds = frameMjds();
    const values = t.light.deltaMag.flatMap((m, f) => {
      if (m === null) return [];
      const p = t.points.find((q) => q.frame === f);
      return [{ m, f, p, mjd: p?.mjd ?? mjds[f] ?? null }];
    });
    if (values.length < 2) { ctx.fillText("Not enough detections for a light curve.", left, H / 2); return; }
    const errors = values.map((v) => v.p && !v.p.saturated ? Math.hypot(1.0857 / Math.max(v.p.snr, 1), 0.05) : 0);
    const lo = Math.min(...values.map((v, i) => v.m - errors[i])), hi = Math.max(...values.map((v, i) => v.m + errors[i]));
    const span = Math.max(hi - lo, 0.2), mid = (hi + lo) / 2, yMin = mid - span * 0.6, yMax = mid + span * 0.6;
    const validMjds = values.map((v) => v.mjd).filter((m): m is number => m !== null && Number.isFinite(m));
    const minMjd = validMjds.length ? Math.min(...validMjds) : 0, maxMjd = validMjds.length ? Math.max(...validMjds) : 0;
    const useMjd = validMjds.length === values.length && maxMjd - minMjd > 1e-4;
    const xOf = (f: number, mjd: number | null = mjds[f] ?? null) =>
      left + (useMjd && mjd !== null ? (mjd - minMjd) / (maxMjd - minMjd) : (frames <= 1 ? 0.5 : f / (frames - 1))) * plotW;
    const yOf = (m: number) => top + (m - yMin) / (yMax - yMin) * plotH; // Brighter (negative) is up.
    ctx.strokeStyle = "#2a3650";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, top); ctx.lineTo(left, H - bottom); ctx.lineTo(W - right, H - bottom); ctx.stroke();
    ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(left, yOf(0)); ctx.lineTo(W - right, yOf(0)); ctx.stroke(); ctx.setLineDash([]);
    const signed = (m: number) => `${m > 0 ? "+" : m < 0 ? "−" : ""}${Math.abs(m).toFixed(2)}`;
    ctx.textAlign = "right";
    ctx.fillText(signed(yMin), left - 5, top + 9);
    ctx.fillText(signed(yMax), left - 5, H - bottom);
    if (yOf(0) > top + 18 && yOf(0) < H - bottom - 14) ctx.fillText("0", left - 5, yOf(0) + 4);
    ctx.textAlign = "left";
    // Connect consecutive detections to visualize brightness trajectory over time.
    ctx.strokeStyle = "rgba(166, 232, 220, 0.45)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = xOf(v.f, v.mjd), y = yOf(v.m);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    values.forEach((v, i) => {
      const x = xOf(v.f, v.mjd), y = yOf(v.m);
      const isCurrent = v.f === frame;
      if (isCurrent) {
        ctx.strokeStyle = "#f3c97a";
        ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.arc(x, y, 7, 0, 2 * Math.PI); ctx.stroke();
      }
      ctx.strokeStyle = "#a6e8dc"; ctx.fillStyle = "#a6e8dc"; ctx.lineWidth = 1.4;
      if (v.p?.saturated) {
        // Saturated core is a flux lower limit (brighter = upward).
        const yTip = Math.max(top, y - 9);
        ctx.beginPath();
        ctx.moveTo(x, y - 4); ctx.lineTo(x, yTip);
        ctx.moveTo(x - 2.5, yTip + 3); ctx.lineTo(x, yTip); ctx.lineTo(x + 2.5, yTip + 3);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(x, Math.max(top, Math.min(H - bottom, yOf(v.m - errors[i]))));
        ctx.lineTo(x, Math.max(top, Math.min(H - bottom, yOf(v.m + errors[i]))));
        ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill();
      }
    });
    ctx.fillStyle = "#a0aec4";
    const fmtMjd = (mjd: number) => {
      const iso = new Date((mjd - 40587) * 86400000).toISOString();
      return maxMjd - minMjd < 3 ? iso.slice(5, 16).replace("T", " ") : iso.slice(0, 10);
    };
    if (useMjd) {
      ctx.textAlign = "left";
      ctx.fillText(fmtMjd(minMjd), left, H - 8);
      ctx.textAlign = "center";
      ctx.fillText(`Δt ${(maxMjd - minMjd).toFixed(maxMjd - minMjd < 10 ? 2 : 1)} d (UTC)`, left + plotW / 2, H - 8);
      ctx.textAlign = "right";
      ctx.fillText(fmtMjd(maxMjd), W - right, H - 8);
      ctx.textAlign = "left";
    } else {
      ctx.textAlign = "center";
      const every = Math.ceil(frames / 5);
      for (let f = 0; f < frames; f += every) {
        ctx.fillText(labelFor(f).slice(0, 10), Math.min(Math.max(xOf(f), left + 28), W - right - 28), H - 8);
      }
      ctx.textAlign = "left";
    }
  }

  function drawDiscovery(ctx: CanvasRenderingContext2D, k: number): void {
    const pixelPx = 2 ** camera.z;
    if (tracked) {
      const pts = tracked.points.flatMap((p) => { const s = toScreen(p.ra, p.dec, k); return s ? [{ p, s }] : []; });
      ctx.strokeStyle = "rgba(166, 232, 220, 0.9)"; ctx.fillStyle = "#a6e8dc"; ctx.lineWidth = 1.6;
      ctx.beginPath();
      pts.forEach(({ s }, i) => i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]));
      ctx.stroke();
      for (const { s } of pts) { ctx.beginPath(); ctx.arc(s[0], s[1], 2.6, 0, 2 * Math.PI); ctx.fill(); }
      if (tracked.motion?.significant && pts.length >= 2) {
        // Arrowhead on the last segment shows the direction of motion.
        const [p, q] = [pts[pts.length - 2].s, pts[pts.length - 1].s];
        const angle = Math.atan2(q[1] - p[1], q[0] - p[0]);
        ctx.beginPath();
        ctx.moveTo(q[0] + 9 * Math.cos(angle), q[1] + 9 * Math.sin(angle));
        ctx.lineTo(q[0] + 9 * Math.cos(angle) - 8 * Math.cos(angle - 0.5), q[1] + 9 * Math.sin(angle) - 8 * Math.sin(angle - 0.5));
        ctx.lineTo(q[0] + 9 * Math.cos(angle) - 8 * Math.cos(angle + 0.5), q[1] + 9 * Math.sin(angle) - 8 * Math.sin(angle + 0.5));
        ctx.closePath(); ctx.fill();
      }
      if (pixelPx >= 3 && pts.length <= 12) {
        ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
        for (let idx = 0; idx < pts.length; idx++) {
          const { p, s } = pts[idx];
          const text = labelFor(p.frame).slice(0, 12);
          const tw = ctx.measureText(text).width;
          const lx = s[0] + 9;
          const ly = s[1] + 4 + idx * 14;
          ctx.fillStyle = "rgba(5, 8, 15, 0.82)";
          ctx.fillRect(lx - 2, ly - 9, tw + 4, 12);
          ctx.fillStyle = "rgba(219, 233, 250, 0.95)";
          ctx.fillText(text, lx, ly);
        }
      }
      // The ring follows the visible frame; hidden while blinking so it adds no motion of its own.
      const current = pts.find(({ p }) => p.frame === frame);
      if (current && playback !== "blink" && !arithmeticView()) {
        ctx.strokeStyle = "#a6e8dc"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(current.s[0], current.s[1], Math.max(10, 1.9 * pixelPx), 0, 2 * Math.PI); ctx.stroke();
      }
      // Name badge above the tracked source (current frame, or its first detection).
      const badgeAt = current ?? pts[0];
      if (badgeAt && playback !== "blink") {
        const objName = tracked.id?.skybot.matches?.[0]?.name
          || tracked.id?.simbad.matches?.[0]?.name
          || tracked.id?.gaia.matches?.[0]?.name
          || (SkyShift.findTargetAt(tracked.start.ra, tracked.start.dec, 0.03, badgeAt.p.mjd ?? undefined)?.label)
          || (SkyShift.separation(tracked.start.ra, tracked.start.dec, fixture.ra0, fixture.dec0) < 25 && currentTargetId
            ? SkyShift.TARGETS.find((t) => t.id === currentTargetId)?.label
            : undefined)
          || `${SkyShift.formatRa(tracked.start.ra, 0.01)} ${SkyShift.formatDec(tracked.start.dec, 0.1)}`;

        const r = Math.max(10, 1.9 * pixelPx);
        ctx.font = "bold 11px system-ui, sans-serif";
        const tw = ctx.measureText(objName).width;
        const bx = badgeAt.s[0];
        const by = badgeAt.s[1] - r - 8;

        ctx.fillStyle = "rgba(10, 16, 28, 0.9)";
        ctx.fillRect(bx - tw / 2 - 5, by - 10, tw + 10, 15);
        ctx.strokeStyle = "rgba(166, 232, 220, 0.85)";
        ctx.lineWidth = 1.2;
        ctx.strokeRect(bx - tw / 2 - 5, by - 10, tw + 10, 15);
        ctx.fillStyle = "#a6e8dc";
        ctx.textAlign = "center";
        ctx.fillText(objName, bx, by + 1);
        ctx.textAlign = "left";
      }
    }
    candidates.forEach((c, i) => {
      const [ra, dec] = SkyShift.gridToSky(fixture, c.x, c.y);
      const s = toScreen(ra, dec, k);
      if (!s) return;
      const active = i === candidateIndex && !candidateCard.hidden;
      const tint = c.kind === "mover" ? "#ff9ad5" : "#f3c97a", r = Math.max(10, 2.4 * pixelPx);
      ctx.strokeStyle = tint; ctx.fillStyle = tint; ctx.lineWidth = active ? 2.4 : 1.2;
      ctx.setLineDash(active ? [] : [4, 3]);
      ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, 2 * Math.PI); ctx.stroke();
      ctx.setLineDash([]);
      if (c.kind === "mover" && c.shift * pixelPx >= 6) {
        const from = toScreen(...SkyShift.gridToSky(fixture, ...c.from), k), to = toScreen(...SkyShift.gridToSky(fixture, ...c.to), k);
        if (from && to) { ctx.beginPath(); ctx.moveTo(from[0], from[1]); ctx.lineTo(to[0], to[1]); ctx.stroke(); }
      }
      const name = resolveCandidateName(c);
      const label = `${i + 1} · ${name}`;
      ctx.font = "600 11px system-ui, sans-serif";
      const tw = ctx.measureText(label).width;
      const lx = s[0] + r * 0.72 + 2;
      const ly = s[1] - r * 0.72 - 4;
      ctx.fillStyle = "rgba(12, 19, 34, 0.9)";
      ctx.fillRect(lx - 3, ly - 10, tw + 6, 14);
      ctx.strokeStyle = tint;
      ctx.lineWidth = 1;
      ctx.strokeRect(lx - 3, ly - 10, tw + 6, 14);
      ctx.fillStyle = tint;
      ctx.fillText(label, lx, ly);
    });
  }

  // Mover finder & right-side candidates list
  let moverFilter: "all" | "mover" | "variable" = "all";
  const candidateNames = new Map<string, string>();
  const candidateLookups = new Set<string>();

  function candidateCoordKey(c: SkyShift.MoverCandidate): string {
    return `${c.x.toFixed(1)},${c.y.toFixed(1)}`;
  }

  function resolveCandidateName(c: SkyShift.MoverCandidate): string {
    const key = candidateCoordKey(c);
    const cached = candidateNames.get(key);
    if (cached) return cached;

    const [ra, dec] = SkyShift.gridToSky(fixture, c.x, c.y);

    // 1. Check known targets
    const target = SkyShift.findTargetAt(ra, dec, 0.02);
    if (target) {
      candidateNames.set(key, target.label);
      return target.label;
    }

    // 2. Check if near loaded field target centre
    if (SkyShift.separation(ra, dec, fixture.ra0, fixture.dec0) < 25 && currentTargetId) {
      const fieldTarget = SkyShift.TARGETS.find((t) => t.id === currentTargetId);
      if (fieldTarget) {
        candidateNames.set(key, fieldTarget.label);
        return fieldTarget.label;
      }
    }

    // 3. Check loaded catalogues (Gaia / CatWISE), propagated to the frame epoch
    const candMjd = frameMjd();
    const candYear = candMjd === undefined ? null : SkyShift.mjdToJulianYear(candMjd);
    for (const catName of ["gaia", "wise"] as const) {
      for (const src of catalogues[catName] ?? []) {
        const [sra, sdec] = SkyShift.cataloguePosition(src, candYear);
        if (SkyShift.separation(ra, dec, sra, sdec) <= 5) {
          const label = `${catName === "wise" ? "CatWISE2020" : "Gaia DR3"} ${src.id}`;
          candidateNames.set(key, label);
          return label;
        }
      }
    }

    // 4. Query SIMBAD / Gaia in background
    void fetchCandidateIdentity(c);

    // 5. Default kind label until catalogue name resolves
    return c.kind === "mover" ? "Moving source" : c.kind === "brighter" ? "Variable source" : "Dimming source";
  }

  async function fetchCandidateIdentity(c: SkyShift.MoverCandidate): Promise<void> {
    const key = candidateCoordKey(c);
    // resolveCandidateName runs on every render; query each position once.
    if (candidateLookups.has(key)) return;
    candidateLookups.add(key);
    const [ra, dec] = SkyShift.gridToSky(fixture, c.x, c.y);
    const mjd = frameMjd() ?? 61000;
    try {
      const q = new URLSearchParams({
        ra: ra.toFixed(6),
        dec: dec.toFixed(6),
        mjd: mjd.toFixed(4),
        radius: "8",
      });
      const res = await fetch(`/api/identify?${q}`);
      if (!res.ok) return;
      const data = await res.json();
      const ssoName = data.skybot?.matches?.[0]?.name;
      const simbadName = data.simbad?.matches?.[0]?.name;
      const gaiaName = data.gaia?.matches?.[0]?.name;
      const resolved = ssoName || simbadName || gaiaName;
      if (resolved && resolved !== candidateNames.get(key)) {
        candidateNames.set(key, resolved);
        updateMoversPanel();
        if (candidates[candidateIndex] === c) showCandidate();
        render();
      }
    } catch {
      // offline / mock; ignore
    }
  }

  function ensureCandidatesComputed(): void {
    if (!series || !canCompare() || modeSelect.value === "exposures") return;
    const a = Number(referenceSelect.value), b = Number(comparisonSelect.value);
    if (a !== b && series.frames[a] && series.frames[b] && !candidates.length) {
      candidates = SkyShift.findMovers(series.frames[a], series.frames[b], series.side);
    }
  }

  function updateMoversPanel(): void {
    if (embed || !series || modeSelect.value === "exposures" || !canCompare()) {
      moversPanel.hidden = true;
      return;
    }
    moversPanel.hidden = false;
    const a = Number(referenceSelect.value), b = Number(comparisonSelect.value);
    moversSubtitle.textContent = `A (${labelFor(a)}) → B (${labelFor(b)})`;

    ensureCandidatesComputed();

    const moversCount = candidates.filter((c) => c.kind === "mover").length;
    const variableCount = candidates.filter((c) => c.kind !== "mover").length;
    countAll.textContent = String(candidates.length);
    countMover.textContent = String(moversCount);
    countVariable.textContent = String(variableCount);

    const filtered = candidates.map((c, originalIndex) => ({ c, originalIndex })).filter(({ c }) => {
      if (moverFilter === "mover") return c.kind === "mover";
      if (moverFilter === "variable") return c.kind !== "mover";
      return true;
    });

    moversEmpty.hidden = filtered.length > 0;
    moversList.replaceChildren();

    for (const { c, originalIndex } of filtered) {
      const [ra, dec] = SkyShift.gridToSky(fixture, c.x, c.y);
      const name = resolveCandidateName(c);
      const li = document.createElement("li");
      li.className = `mover-item kind-${c.kind}`;
      li.setAttribute("role", "option");
      const isSelected = originalIndex === candidateIndex && !candidateCard.hidden;
      li.setAttribute("aria-selected", String(isSelected));

      const rank = document.createElement("span");
      rank.className = "mover-rank";
      rank.textContent = String(originalIndex + 1);

      const main = document.createElement("div");
      main.className = "mover-main";

      const title = document.createElement("span");
      title.className = "mover-title";
      title.textContent = name;

      let changeBadge = "";
      if (c.kind === "mover") {
        const shiftArcsec = (c.shift * fixture.scale).toFixed(1);
        changeBadge = `Moved ${shiftArcsec}″`;
      } else if (c.kind === "brighter") {
        const pct = Math.round((c.relative - 1) * 100);
        changeBadge = `Brighter ▲ +${pct}%`;
      } else {
        const pct = Math.round((1 - c.relative) * 100);
        changeBadge = `Fainter ▼ −${pct}%`;
      }

      const meta = document.createElement("span");
      meta.className = "mover-meta";
      meta.textContent = `${changeBadge} · ${SkyShift.formatRa(ra, 0.01)} ${SkyShift.formatDec(dec, 0.1)} · S/N ${c.score >= 1000 ? ">1000" : c.score.toFixed(0)}`;

      main.append(title, meta);

      const action = document.createElement("span");
      action.className = "mover-action";
      action.textContent = "Track ↗";

      li.append(rank, main, action);

      li.addEventListener("click", () => {
        candidateIndex = originalIndex;
        showCandidate();
        const [targetRa, targetDec] = SkyShift.gridToSky(fixture, ...c.to);
        pause();
        trackAt(targetRa, targetDec, Number(comparisonSelect.value));
        updateMoversPanel();
      });

      moversList.append(li);
    }
  }

  function findMoversNow(): void {
    if (busy || !series) return;
    if (!canCompare() || modeSelect.value === "exposures") {
      status.textContent = "Choose two different visits as A and B, in the visit-stack view, to look for movers.";
      return;
    }
    pause();
    colourOff();
    dismissHint();
    const a = Number(referenceSelect.value), b = Number(comparisonSelect.value);
    candidates = SkyShift.findMovers(series.frames[a], series.frames[b], series.side);
    if (!candidates.length) {
      candidateCard.hidden = true;
      status.textContent = `Nothing moved or changed between ${labelFor(a)} and ${labelFor(b)} above the detection threshold.`;
      updateMoversPanel();
      render();
      return;
    }
    hideHere();
    candidateIndex = 0;
    moversPanel.classList.remove("collapsed");
    moversToggle.setAttribute("aria-expanded", "true");
    showCandidate();
    updateMoversPanel();
    const movers = candidates.filter((c) => c.kind === "mover").length, changes = candidates.length - movers;
    status.textContent = `${movers} moving-source candidate${movers === 1 ? "" : "s"} and ${changes} brightness change${changes === 1 ? "" : "s"} between A and B.`;
  }
  function showCandidate(): void {
    const c = candidates[candidateIndex];
    if (!c) return;
    candidateCard.hidden = false;
    const a = Number(referenceSelect.value), b = Number(comparisonSelect.value);
    const name = resolveCandidateName(c);
    const kindLabel = c.kind === "mover" ? "Moved" : c.kind === "brighter" ? "Got brighter" : "Got fainter";
    get("candidate-title").textContent = `${name} · ${kindLabel} (${candidateIndex + 1} of ${candidates.length})`;
    const strength = c.score >= 1000 ? "S/N over 1000" : `S/N ${c.score.toFixed(0)}`;
    get("candidate-detail").textContent = c.kind === "mover"
      ? `Shifted ${(c.shift * fixture.scale).toFixed(1)}″ between A (${labelFor(a)}) and B (${labelFor(b)}) · ${strength}`
      : `Changed between A (${labelFor(a)}) and B (${labelFor(b)}) without moving · ${strength}`;
    for (const id of ["candidate-prev", "candidate-next"]) get<HTMLButtonElement>(id).disabled = candidates.length < 2;
    // Bring it into view, zoomed in enough to judge it by eye.
    const [ra, dec] = SkyShift.gridToSky(fixture, c.x, c.y);
    const z = SkyShift.clampZoom(Math.max(camera.z, 4));
    const [vx, vy] = visibleCentre();
    setCamera(SkyShift.placeAt({ ...camera, z }, ra, dec, vx - screen.width / 2, vy - screen.height / 2, SkyShift.pxPerArcsec(z, fixture.scale)));
    updateMoversPanel();
  }
  function closeCandidates(): void {
    candidates = [];
    candidateCard.hidden = true;
    updateMoversPanel();
    render();
  }
  get("find-movers").addEventListener("click", findMoversNow);
  get("candidate-prev").addEventListener("click", () => { candidateIndex = (candidateIndex - 1 + candidates.length) % candidates.length; showCandidate(); });
  get("candidate-next").addEventListener("click", () => { candidateIndex = (candidateIndex + 1) % candidates.length; showCandidate(); });
  get("candidate-blink").addEventListener("click", () => toggleBlink());
  get("candidate-close").addEventListener("click", () => { closeCandidates(); mapCanvas.focus(); });
  get("candidate-track").addEventListener("click", () => {
    const c = candidates[candidateIndex];
    if (!c) return;
    const [ra, dec] = SkyShift.gridToSky(fixture, ...c.to);
    pause();
    trackAt(ra, dec, Number(comparisonSelect.value));
  });

  locatorReturn.addEventListener("click", () => { frameField(); mapCanvas.focus(); });
  moversToggle.addEventListener("click", () => {
    const isCollapsed = moversPanel.classList.toggle("collapsed");
    moversToggle.setAttribute("aria-expanded", String(!isCollapsed));
  });
  for (const btn of moversFilters.querySelectorAll<HTMLButtonElement>("button")) {
    btn.addEventListener("click", () => {
      moversFilters.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      moverFilter = (btn.dataset.filter as "all" | "mover" | "variable") || "all";
      updateMoversPanel();
    });
  }

  get("here-track").addEventListener("click", () => { if (selected) trackAt(selected.ra, selected.dec); });
  get("object-clear").addEventListener("click", () => {
    tracked = null; trackToken++;
    objectSection.hidden = true;
    render(); saveState();
    get("panel-close").focus();
  });

  // Reports: a link that reopens the view with the object tracked, and a JSON record.
  get("report-link").addEventListener("click", () => {
    clearTimeout(saveTimer);
    saveState();
    void copyText(location.href, "Report link copied. It reopens this view with the object tracked.");
  });
  get("report-json").addEventListener("click", () => {
    const t = tracked;
    if (!t) return;
    clearTimeout(saveTimer);
    saveState();
    const report = {
      schemaVersion: 1, tool: "SkyShift", createdUtc: new Date().toISOString(), link: location.href,
      field: { name: fieldName(), raDeg: fixture.ra0, decDeg: fixture.dec0, detector: currentSelection?.band ?? 6,
        fieldArcmin: fieldSide() * fixture.scale / 60, frames: (series?.frames ?? []).map((_, i) => labelFor(i)) },
      object: {
        verdict: t.verdict.label, tone: t.verdict.tone, reasons: t.verdict.reasons,
        positions: t.points.map((p) => ({ frame: labelFor(p.frame), mjd: p.mjd, raDeg: p.ra, decDeg: p.dec, snr: p.snr, saturated: !!p.saturated, deltaMag: t.light.deltaMag[p.frame] })),
        motion: t.motion && { eastArcsecPerYear: t.motion.east, northArcsecPerYear: t.motion.north, totalArcsecPerYear: t.motion.total,
          errorArcsecPerYear: t.motion.error, positionAngleDeg: t.motion.angle, significant: t.motion.significant, spanYears: t.motion.spanYears },
        brightness: { amplitudeMag: t.light.amplitude, variable: t.light.variable },
      },
      identification: t.id,
      warnings: ["Positions are flux-weighted centroids on aligned SPHEREx visit stacks; motion is a linear fit.",
        "Brightness changes can include the different wavelengths SPHEREx samples within a band from visit to visit.",
        "Verdicts are rules of thumb from catalogue matches and measurements; confirm them by eye."],
    };
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    link.download = `skyshift-object-${t.start.ra.toFixed(4)}_${t.start.dec.toFixed(4)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });

  // Colour composite across three detector bands.
  function updateColourToggle(): void {
    const toggle = get<HTMLButtonElement>("colour-toggle");
    toggle.hidden = !colour;
    toggle.setAttribute("aria-pressed", String(showColour));
    toggle.textContent = showColour ? "Hide colour" : "Show colour";
  }
  function colourOff(): void {
    if (!showColour) return;
    showColour = false;
    updateColourToggle();
  }
  function paintColour(): void {
    if (!colour) return;
    const side = colour.side;
    if (fieldCanvas.width !== side || fieldCanvas.height !== side) fieldCanvas.width = fieldCanvas.height = side;
    const bitmap = fieldContext.createImageData(side, side);
    const ranges = colour.channels.map((channel) => {
      const values = Array.from(channel).filter(Number.isFinite).sort((a, b) => a - b);
      return values.length ? [values[Math.floor((values.length - 1) * 0.05)], values[Math.floor((values.length - 1) * 0.997)]] : [0, 1];
    });
    const gain = stretchValue() === "faint" ? 64 : 16, linear = stretchValue() === "linear";
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const source = (side - y - 1) * side + x, index = (y * side + x) * 4;
      const missing = colour.channels.some((channel) => !Number.isFinite(channel[source]));
      for (let c = 0; c < 3; c++) {
        const value = colour.channels[c][source];
        if (missing) { bitmap.data[index + c] = ((x + y) % 4 === 0 ? 29 : 17) + c * 4; continue; }
        const t = Math.max(0, Math.min(1, (value - ranges[c][0]) / Math.max(ranges[c][1] - ranges[c][0], 1e-9)));
        bitmap.data[index + c] = Math.round((linear ? t : Math.asinh(t * gain) / Math.asinh(gain)) * 250);
      }
      bitmap.data[index + 3] = 255;
    }
    fieldContext.putImageData(bitmap, 0, 0);
  }
  async function loadColour(): Promise<void> {
    if (busy || !series) return;
    const bands = ["colour-r", "colour-g", "colour-b"].map((id) => Number(get<HTMLSelectElement>(id).value));
    const output = get("colour-status");
    if (new Set(bands).size < 3) { output.textContent = "Choose three different bands."; return; }
    const loadedBand = currentSelection?.band ?? 6;
    const fov = currentSelection?.fov ?? (Number(fovSelect.value) || 5);
    const frameMode = loadedFrameMode;
    const side = series.side, frames = series.frames;
    const { fromMjd, toMjd } = SkyShift.searchTimeBounds(
      currentSelection?.from ?? dateFromInput.value,
      currentSelection?.to ?? dateToInput.value,
      currentSelection?.asof,
    );
    pause();
    busy = true; updateControls();
    const controller = new AbortController();
    const cancelColour = () => controller.abort();
    interrupt = cancelColour;
    try {
      const channels: Float32Array[] = [];
      for (const [i, band] of bands.entries()) {
        if (band === loadedBand) { channels.push(SkyShift.deepStack(frames)); continue; }
        output.textContent = status.textContent = `Colour: searching band ${band} (${i + 1} of 3)…`;
        const query = new URLSearchParams({
          ra: String(fixture.ra0), dec: String(fixture.dec0), band: String(band), fov: String(fov),
          fromMjd: String(fromMjd), toMjd: String(toMjd),
        });
        const response = await fetch(`/api/observations?${query}`, { signal: controller.signal });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data) throw new Error(data?.error ?? "server");
        if (!data.observations.length) throw new Error(`No band ${band} observations cover this field.`);
        const bandFixture = await fetchLiveInWorker(data.observations, fixture.ra0, fixture.dec0, fov, controller.signal, (done, total) => {
          output.textContent = status.textContent = `Colour: downloading band ${band}, ${done} of ${total} observations…`;
        }, cacheSelect.value !== "none");
        const result = await submit(engineSelect.value as SkyShift.EngineName, "wise0855", cacheSelect.value as SkyShift.CacheLevel, () => {}, bandFixture, frameMode);
        interrupt = cancelColour;
        channels.push(SkyShift.cropGrid(SkyShift.deepStack(result.series.frames), result.series.side, side));
      }
      colour = { bands, channels, side };
      showColour = true;
      updateColourToggle();
      output.textContent = status.textContent = `Colour composite ready: red band ${bands[0]}, green band ${bands[1]}, blue band ${bands[2]}, ${frameMode === "exposures" ? "all exposures stacked" : "all visits stacked"}.`;
      busy = false;
      commitView();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.textContent = status.textContent = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError") ? "Colour composite cancelled."
        : error instanceof TypeError || message === "server" ? "Colour composites need the SkyShift server (npm run dev) to fetch the other bands." : message;
    } finally {
      busy = false; interrupt = undefined; updateControls();
    }
  }
  get("colour-load").addEventListener("click", () => void loadColour());
  get("colour-toggle").addEventListener("click", () => { if (!colour) return; pause(); showColour = !showColour; updateColourToggle(); commitView(); });


  // ------------------------------------------------------------ panel ----
  let panelOpener: HTMLElement | null = null;
  // Opening the panel only pans what matters into the uncovered map (never
  // zooms); closing it returns to the earlier framing if the map was not moved.
  let panelReturn: { camera: SkyShift.Camera; wasDefault: boolean } | null = null;
  function openPanel(opener?: HTMLElement | null, focus?: [number, number]): void {
    pause();
    closePopovers();
    if (panel.hidden) {
      const wasDefault = cameraIsDefault;
      panel.hidden = false;
      document.body.classList.add("panel-open");
      menuButton.setAttribute("aria-expanded", "true");
      panelOpener = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : mapCanvas);
      measureChrome();
      ensureVisible(...(focus ?? [fixture.ra0, fixture.dec0]));
      panelReturn = { camera, wasDefault };
      render();
    } else if (focus) ensureVisible(...focus);
    get("panel-close").focus();
  }
  function closePanel(restoreFocus = true): void {
    if (panel.hidden) return;
    panel.hidden = true;
    document.body.classList.remove("panel-open");
    menuButton.setAttribute("aria-expanded", "false");
    measureChrome();
    if (cameraIsDefault || (panelReturn?.wasDefault && panelReturn.camera === camera)) frameField(); else render();
    panelReturn = null;
    if (restoreFocus) (panelOpener && document.contains(panelOpener) && !panelOpener.closest("[hidden]") ? panelOpener : mapCanvas).focus();
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
  const dateFromInput = get<HTMLInputElement>("date-from");
  const dateToInput = get<HTMLInputElement>("date-to");
  const currentSearchOptions = (): SkyShift.SearchOptionsState => ({
    band: Number(bandSelect.value),
    fov: Number(fovSelect.value),
    from: dateFromInput.value,
    to: dateToInput.value,
  });
  let loadedOptions: SkyShift.SearchOptionsState = { band: 6, fov: 5, from: "", to: "" };
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
    } else if (text === shownName && SkyShift.searchOptionsDiffer(currentSearchOptions(), loadedOptions)) {
      queryPreview.textContent = `Band ${bandSelect.value} · ${fovSelect.value}′ · Enter searches ${shownName} with updated options.`;
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
  for (const control of [bandSelect, fovSelect, dateFromInput, dateToInput]) control.addEventListener("change", updateSuggestions);
  get<HTMLFormElement>("search").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = query.value.trim();
    const optionsChanged = SkyShift.searchOptionsDiffer(currentSearchOptions(), loadedOptions);
    if (text === shownName && !optionsChanged) { closeDrop(); frameField(); mapCanvas.focus(); return; }
    let parsed: SkyShift.Query;
    try { parsed = SkyShift.parseQuery(text); }
    catch (error) {
      if (text === shownName && currentSelection) {
        void searchFromOptions(currentSelection.ra, currentSelection.dec);
        return;
      }
      openDrop();
      queryPreview.classList.add("invalid");
      queryPreview.textContent = error instanceof Error ? error.message : String(error);
      return;
    }
    if (parsed.kind === "target") {
      if (!optionsChanged) void openExample(parsed.target.id);
      else void searchFromOptions(parsed.target.ra, parsed.target.dec, undefined, parsed.target);
    } else void searchFromOptions(parsed.ra, parsed.dec);
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

  let loadedFrameMode: "visits" | "exposures" = modeSelect.value === "exposures" ? "exposures" : "visits";
  modeSelect.addEventListener("change", async () => {
    pause();
    colourOff();
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
        colourOff();
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
    updateMoversPanel();
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
        setEarlierWindow(null);
        wavelengthSelection = null; marker.checked = false;
        clearCatalogues();
        fovSelect.value = "5";
        setFieldInfo(target.label, "RA 133.759765° · Dec −7.242186° · 4.42–5.00 μm · 2.1′ field", target.band, target.id);
        loadedOptions = { band: target.band, fov: 5, from: "", to: "" };
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
      bandSelect.value = String(target.band);
      await searchFromOptions(target.ra, target.dec, undefined, target, true);
      return;
    }
    const previousFrame = frame; frame = 0;
    if (!await load(bundle.fixture)) { frame = previousFrame; return; }
    frame = Number(referenceSelect.value) || 0;
    fullBandFixture = bundle.fixture; wavelengthSelection = null; isBundled = false;
    setEarlierWindow(null);
    fovSelect.value = "5";
    currentSelection = { ra: target.ra, dec: target.dec, band: target.band, fov: 5 };
    setFieldInfo(target.label, `RA ${target.ra.toFixed(6)}° · Dec ${target.dec.toFixed(6)}° · Band ${target.band} · 5′ field`, target.band, target.id);
    loadedOptions = { band: target.band, fov: 5, from: "", to: "" };
    marker.checked = false;
    clearCatalogues();
    hideHere();
    frameField();
    commitView();
    status.textContent += " · Bundled sampled observations";
  }

  async function searchFromOptions(
    ra: number,
    dec: number,
    savedAsof?: string,
    target?: SkyShift.Target,
    useTargetBand = false,
    extra: { waveRange?: [number, number] | null; preserveFrame?: boolean } = {},
  ): Promise<void> {
    const band = useTargetBand && target ? target.band : Number(bandSelect.value);
    const fov = Number(fovSelect.value);
    const from = dateFromInput.value, to = dateToInput.value;
    if (!!from !== !!to || (from && (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from > to))) {
      status.textContent = "Enter both dates in chronological order, or leave both blank.";
      openDrop(); searchOptions.hidden = false; optionsToggle.setAttribute("aria-expanded", "true");
      return;
    }
    await search({ ra, dec, band, fov, from, to, ...extra }, savedAsof, target);
  }

  type EarlierWindow = { ra: number; dec: number; band: number; fov: number; from: string; to: string; endMjd: number; target?: SkyShift.Target };
  let earlierWindow: EarlierWindow | null = null;
  function setEarlierWindow(nextWindow: EarlierWindow | null): void {
    earlierWindow = nextWindow;
    earlierWindowButton.hidden = !nextWindow;
    if (nextWindow) {
      const cutoffDate = new Date((nextWindow.endMjd - 40587) * 86400000).toISOString().slice(0, 10);
      earlierWindowButton.title = `Search earlier 90-day deep-field window (before ${cutoffDate})`;
    }
  }
  function updatePreflightEstimate(): void {
    const el = document.getElementById("preflight-estimate");
    if (!el) return;
    const fov = Number(fovSelect.value) || 5;
    const est = SkyShift.estimateDownloadBytes([], fov);
    el.textContent = `Preflight estimate (${fov}′ field): ~${formatBytes(est.perExposureBytes)} per exposure (~${formatBytes(est.totalBytes)} for ${est.selectedExposures} exposures; max ${est.maximumExposures} exposures / 32 MB).`;
  }
  fovSelect.addEventListener("change", () => {
    updatePreflightEstimate();
    render();
  });
  updatePreflightEstimate();

  earlierWindowButton.addEventListener("click", () => {
    if (!earlierWindow || busy) return;
    const { target, ...rest } = earlierWindow;
    void search(rest, undefined, target);
  });

  async function search(
    request: { ra: number; dec: number; band: number; fov: number; from: string; to: string; endMjd?: number; waveRange?: [number, number] | null; preserveFrame?: boolean },
    savedAsof?: string,
    named?: SkyShift.Target,
  ): Promise<void> {
    if (busy) return;
    const { ra, dec, band, fov, from, to, endMjd, waveRange, preserveFrame } = request;
    let startMjd: number, toMjd: number, cutoffMs: number;
    try {
      ({ fromMjd: startMjd, toMjd, cutoffMs } = SkyShift.searchTimeBounds(from, to, savedAsof, endMjd));
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      return;
    }
    pause();
    closeDrop();
    busy = true;
    updateControls();
    searchController = new AbortController();
    interrupt = () => searchController?.abort();
    try {
      status.textContent = `Searching SPHEREx observations${named ? ` of ${named.label}` : ""}…`;
      const params = new URLSearchParams({
        ra: String(ra), dec: String(dec), band: String(band), fov: String(fov),
        fromMjd: String(startMjd), toMjd: String(toMjd),
      });
      const response = await fetch("/api/observations?" + params, { signal: searchController.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Observation search failed.");
      if (!data.observations.length) throw new Error("No observations found for this selection.");
      const est = SkyShift.estimateDownloadBytes(data.observations, fov);
      const nextFixture = await fetchLiveInWorker(data.observations, ra, dec, fov, searchController.signal, (done, total) => {
        status.textContent = `Downloading ${done} of ${total} observations (~${formatBytes(est.totalBytes)})…`;
      }, cacheSelect.value !== "none");
      let initialFixture = nextFixture;
      let restoredWave: { min: number; max: number } | null = null;
      if (waveRange) {
        try {
          status.textContent = "Checking wavelengths…";
          const filtered = await SkyShift.filterWavelength(nextFixture, waveRange[0], waveRange[1], searchController.signal);
          initialFixture = filtered.fixture;
          restoredWave = { min: waveRange[0], max: waveRange[1] };
          get("wave-status").textContent = `${filtered.fixture.headers.length} exposures overlap ${waveRange[0]}–${waveRange[1]} μm; ${filtered.unavailable} had unavailable wavelength metadata. Dates without matching exposures are omitted.`;
        } catch (error) {
          get("wave-status").textContent = error instanceof Error ? error.message : String(error);
        }
      } else {
        get("wave-status").textContent = "";
      }
      busy = false;
      const previousFrame = frame;
      frame = preserveFrame && Number.isInteger(initialFrame) && initialFrame >= 0 ? initialFrame : 0;
      if (!await load(initialFixture)) {
        frame = previousFrame;
        return;
      }
      if (!savedAsof && !preserveFrame) frame = Number(referenceSelect.value) || 0;
      fullBandFixture = nextFixture;
      wavelengthSelection = restoredWave;
      clearCatalogues();
      isBundled = false;
      currentSelection = { ra, dec, band, fov, asof: new Date(cutoffMs).toISOString(), ...(from && to ? {from, to} : {}) };
      loadedOptions = { band, fov, from, to };
      marker.checked = false;
      const target = named ?? SkyShift.TARGETS.find((item) => item.ra === ra && item.dec === dec);
      setFieldInfo(target?.label ?? `${ra.toFixed(5)}, ${dec.toFixed(5)}`, `RA ${ra.toFixed(6)}° · Dec ${dec.toFixed(6)}° · Band ${band} · ${fov}′ field`, band, target?.id);
      const earlierDeep = (data.collections as Array<{ name: string; status: string; fromMjd: number; count?: number }>)
        .filter((item) => item.name.endsWith("_deep") && item.status !== "unavailable" && item.fromMjd > startMjd + 0.01 && ((item.count ?? 0) > 0 || item.status === "truncated"));
      setEarlierWindow(earlierDeep.length
        ? { ra, dec, band, fov, from, to, endMjd: Math.max(...earlierDeep.map((item) => item.fromMjd)), target }
        : null);
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
    if (!candidateCard.hidden) { closeCandidates(); mapCanvas.focus(); return; }
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
    else if (key === "f" || key === "F") findMoversNow();
    else if (key === "t" || key === "T") { const [ra, dec] = selected ? [selected.ra, selected.dec] : toSky(...visibleCentre()); trackAt(ra, dec); }
    else if ((key === "c" || key === "C") && colour) get("colour-toggle").click();
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
    revokeSpectrumUrl();
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
  function restoreMark(): void {
    const mark = params.get("mark")?.split(",").map(Number);
    if (mark?.length === 2 && mark.every(Number.isFinite)) trackAt(mark[0], mark[1]);
  }
  const sharedRa = params.get("ra"), sharedDec = params.get("dec");
  const initialWaveMin = params.get("waveMin"), initialWaveMax = params.get("waveMax");
  const initialWaveRange = SkyShift.parseWaveRange(initialWaveMin, initialWaveMax);
  if (initialWaveMin !== null && initialWaveMax !== null) {
    get<HTMLInputElement>("wave-min").value = initialWaveMin;
    get<HTMLInputElement>("wave-max").value = initialWaveMax;
  }
  const loadBundledInitial = async (): Promise<boolean> => {
    if (initialWaveRange) {
      try {
        const filtered = await SkyShift.filterWavelength(ASSETS.fixture, initialWaveRange[0], initialWaveRange[1], new AbortController().signal);
        wavelengthSelection = { min: initialWaveRange[0], max: initialWaveRange[1] };
        get("wave-status").textContent = `${filtered.fixture.headers.length} exposures overlap ${initialWaveRange[0]}–${initialWaveRange[1]} μm; ${filtered.unavailable} had unavailable wavelength metadata. Dates without matching exposures are omitted.`;
        return await load(filtered.fixture);
      } catch (error) {
        get("wave-status").textContent = error instanceof Error ? error.message : String(error);
      }
    }
    return await load();
  };
  if (sharedRa !== null && sharedDec !== null) {
    if (params.get("band")) bandSelect.value = params.get("band")!;
    if (params.get("fov")) fovSelect.value = params.get("fov")!;
    if (params.get("from")) dateFromInput.value = params.get("from")!;
    if (params.get("to")) dateToInput.value = params.get("to")!;
    let ra: number, dec: number;
    try {
      ra = SkyShift.parseCoordinate(sharedRa, "ra");
      dec = SkyShift.parseCoordinate(sharedDec, "dec");
    } catch (error) {
      status.textContent = `Shared link: ${error instanceof Error ? error.message : String(error)}`;
      void loadBundledInitial().then(applyInitialCamera);
      return;
    }
    query.value = `${ra.toFixed(5)}, ${dec.toFixed(5)}`;
    void searchFromOptions(ra, dec, params.get("asof") ?? undefined, undefined, false, {
      waveRange: initialWaveRange,
      preserveFrame: sharedView,
    }).then(() => {
      if (currentSelection) { applyInitialCamera(); restoreMark(); return; }
      // The shared field failed to load: show the bundled example, keep the reason visible.
      const failure = status.textContent ?? "";
      return load().then(() => { applyInitialCamera(); status.textContent = failure; });
    });
  } else {
    void loadBundledInitial().then(() => { applyInitialCamera(); maybeShowHint(); restoreMark(); });
  }
})();
