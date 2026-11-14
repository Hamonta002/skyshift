declare const ASSETS: {
  fixture: SkyShift.PackedFixture;
  wasm: string;
  worker: string;
  toolchain: string;
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
  const stretchSelect = get<HTMLSelectElement>("stretch-preset");
  const sky = get("sky");
  const plate = get("sky-plate");
  const inspector = get<HTMLDialogElement>("inspector");
  const canvas = get<HTMLCanvasElement>("frame");
  const marks = get<HTMLCanvasElement>("marks");
  const context = canvas.getContext("2d")!;
  const overlays = marks.getContext("2d")!;
  const observation = get("observation");
  const marker = get<HTMLInputElement>("marker");
  const status = get("status");
  const cancel = get<HTMLButtonElement>("cancel");
  const next = get<HTMLButtonElement>("next");
  const previous = get<HTMLButtonElement>("previous");
  const play = get<HTMLButtonElement>("play");
  let visits = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-visit]"));
  const benchmark = get("benchmark");
  const benchmarkOutput = get("benchmark-output");
  const run = get<HTMLButtonElement>("run-benchmark");
  const scenarioSelect = get<HTMLSelectElement>("scenario");
  let series: SkyShift.AlignedSeries | undefined;
  let stretch = { low: 0, high: 1 };
  let frame = 0;
  let timer: number | undefined;
  let playback: "visits" | "blink" | undefined;
  let zoom = 1;
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
  type CatalogueSource = SkyShift.CatalogueSource;
  const catalogues: Record<string, CatalogueSource[]> = {};
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
  const requestedStretch = params.get("stretch");
  if (requestedStretch && ["balanced", "faint", "linear"].includes(requestedStretch)) stretchSelect.value = requestedStretch;
  const requestedZoom = Number(params.get("zoom"));
  if ([1, 2, 4].includes(requestedZoom)) zoom = requestedZoom;
  if (params.get("embed") === "1") document.body.classList.add("embed");

  function canCompare(): boolean {
    return !!series && series.frames.length > 1 && referenceSelect.value !== comparisonSelect.value;
  }

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
  }

  function saveState(): void {
    const url = new URL(location.href);
    url.searchParams.set("engine", engineSelect.value);
    url.searchParams.set("cache", cacheSelect.value);
    url.searchParams.set("frame", String(frame + 1));
    url.searchParams.set("view", modeSelect.value);
    if (referenceSelect.value !== "") url.searchParams.set("a", String(Number(referenceSelect.value) + 1));
    if (comparisonSelect.value !== "") url.searchParams.set("b", String(Number(comparisonSelect.value) + 1));
    url.searchParams.delete("reference");
    url.searchParams.set("zoom", String(zoom));
    url.searchParams.set("stretch", stretchSelect.value);
    if (wavelengthSelection) {
      url.searchParams.set("waveMin", String(wavelengthSelection.min));
      url.searchParams.set("waveMax", String(wavelengthSelection.max));
    } else { url.searchParams.delete("waveMin"); url.searchParams.delete("waveMax"); }
    if (currentSelection) {
      url.searchParams.delete("from"); url.searchParams.delete("to");
      for (const [key, value] of Object.entries(currentSelection)) url.searchParams.set(key, String(value));
    } else for (const key of ["ra", "dec", "band", "fov", "from", "to", "asof"]) url.searchParams.delete(key);
    try { history.replaceState(null, "", url); } catch { /* File previews can restrict history. */ }
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
            const gain = stretchSelect.value === "faint" ? 64 : 16;
            const light = Math.round((stretchSelect.value === "linear" ? x : Math.asinh(x * gain) / Math.asinh(gain)) * 242);
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

  function updateScale(): void {
    get("scale-line").style.width = `${30 * plate.clientWidth * zoom / ((series?.side ?? 41) * fixture.scale)}px`;
  }

  function draw(): void {
    if (!series || !series.frames.length) return;
    const side = series.side;
    const a = Number(referenceSelect.value), b = Number(comparisonSelect.value);
    const view = canCompare() ? modeSelect.value : "stack";
    const arithmetic = view === "sum" || view === "difference";
    const pixels = arithmetic ? SkyShift.combineFrames(series.frames[a], series.frames[b], view) : series.frames[frame];
    const limit = paint(canvas, context, pixels, side, view);
    const differenceScale = get("difference-scale");
    differenceScale.hidden = view !== "difference";
    if (view === "difference") {
      get("difference-negative").textContent = `−${limit.toPrecision(2)}`;
      get("difference-positive").textContent = `+${limit.toPrecision(2)}`;
    }
    updateScale();
    difference.setAttribute("aria-pressed", String(view === "difference"));
    overlays.clearRect(0, 0, marks.width, marks.height);
    if (playback !== "blink" && !arithmetic) drawCatalogues(side);
    const markerIndex = modeSelect.value === "exposures" ? frame : fixture.visitSizes.slice(0, frame).reduce((a, b) => a + b, 0);
    const markerMjd = fixture.headers[markerIndex]?.mjd;
    if (marker.checked && isBundled && markerMjd !== undefined && playback !== "blink" && !arithmetic) {
      const time = 2000 + (markerMjd - 51544.5) / 365.25 - 2026;
      const x = marks.width / 2 - time * -8.1237 / fixture.scale * marks.width / side;
      const y = marks.height / 2 - time * 0.6732 / fixture.scale * marks.height / side;
      overlays.strokeStyle = "#a3deca";
      overlays.lineWidth = 1.6;
      overlays.beginPath();
      overlays.moveTo(x - 30, y);
      overlays.lineTo(x - 13, y);
      overlays.moveTo(x, y - 30);
      overlays.lineTo(x, y - 13);
      overlays.stroke();
    }
    const count = series.counts[frame];
    const shallow = count < 5 && modeSelect.value !== "exposures";
    observation.textContent = arithmetic
      ? `${view === "difference" ? "Visual difference B − A" : "Visual sum A + B"} · A ${labelFor(a)} · B ${labelFor(b)}`
      : `${labelFor(frame)} · ${count} ${count === 1 ? "exposure" : "exposures"}${shallow ? " · Shallow frame" : ""}`;
    const slot = get("active-slot");
    slot.hidden = view !== "blink";
    slot.textContent = frame === a ? "A" : frame === b ? "B" : "";
    if (slot.textContent === "") slot.hidden = true;
    get("inspect-frame").textContent = observation.textContent;
    get("bundled-provenance").hidden = !isBundled;
    canvas.setAttribute("aria-label", `Aligned infrared image of ${get("target").textContent}. ${observation.textContent}`);
    visits.forEach((button, index) => button.setAttribute("aria-pressed", String(!arithmetic && index === frame)));
  }

  function commitView(): void {
    draw();
    updateControls();
    saveState();
  }

  function drawCatalogues(side: number): void {
    const index = modeSelect.value === "exposures" ? frame : fixture.visitSizes.slice(0, frame).reduce((a, b) => a + b, 0);
    const mjd = fixture.headers[index]?.mjd;
    const year = mjd === undefined ? null : 2000 + (mjd - 51544.5) / 365.25;
    for (const [name, sources] of Object.entries(catalogues)) {
      if (!get<HTMLInputElement>(name).checked) continue;
      overlays.strokeStyle = name === "gaia" ? "#f3c97a" : "#80bfff";
      overlays.lineWidth = 1.2;
      for (const source of sources) {
        let pixel: [number, number];
        try { pixel = SkyShift.cataloguePixel(fixture, source, year); } catch { continue; }
        const x = (pixel[0] + 0.5) * marks.width / side, y = (side - pixel[1] - 0.5) * marks.height / side;
        if (x < 0 || y < 0 || x > marks.width || y > marks.height) continue;
        overlays.beginPath(); overlays.arc(x, y, 5, 0, 2 * Math.PI); overlays.stroke();
      }
    }
  }

  async function toggleCatalogue(name: "gaia" | "wise"): Promise<void> {
    const checkbox = get<HTMLInputElement>(name), output = get("catalogue-status");
    if (!checkbox.checked) { draw(); return; }
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
      } catch (error) { checkbox.checked = false; output.textContent = error instanceof Error ? error.message : String(error); }
    }
    draw();
  }
  for (const name of ["gaia", "wise"] as const) get<HTMLInputElement>(name).addEventListener("change", () => void toggleCatalogue(name));

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
    play.textContent = "Play visits";
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
      status.textContent = `${source} · ${nameOf(engine)} · ${elapsed(performance.now() - started)}`;
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
  get("share").addEventListener("click", async () => {
    saveState();
    try {
      await navigator.clipboard.writeText(location.href);
      status.textContent = "View link copied.";
    } catch {
      status.textContent = "Copy this page’s address to share the current view.";
    }
  });
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
      display: { zoom, stretch: stretchSelect.value },
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
  difference.addEventListener("click", () => {
    pause();
    modeSelect.value = modeSelect.value === "difference" ? "stack" : "difference";
    commitView();
  });
  marker.addEventListener("change", draw);
  for (const select of [referenceSelect, comparisonSelect]) select.addEventListener("change", () => {
    pause();
    if (modeSelect.value === "blink") frame = Number(referenceSelect.value);
    updateVisitBadges();
    commitView();
  });
  stretchSelect.addEventListener("change", () => {
    pause();
    refreshThumbnails();
    commitView();
  });
  const zoomButton = get<HTMLButtonElement>("zoom");
  function setZoom(nextZoom: number): void {
    zoom = nextZoom;
    get("sky-image").style.setProperty("--zoom", String(zoom));
    zoomButton.textContent = zoom === 1 ? "Fit" : `${zoom}×`;
    zoomButton.setAttribute("aria-label", `Zoom. Current zoom is ${zoomButton.textContent}.`);
  }
  setZoom(zoom);
  zoomButton.addEventListener("click", () => {
    pause();
    setZoom(zoom === 4 ? 1 : zoom * 2);
    commitView();
  });
  new ResizeObserver(updateScale).observe(plate);
  const inspectButton = get<HTMLButtonElement>("inspect");
  inspectButton.addEventListener("click", () => { pause(); inspector.showModal(); });
  get("inspect-close").addEventListener("click", () => inspector.close());
  inspector.addEventListener("close", () => inspectButton.focus());
  const searchToggle = get<HTMLButtonElement>("search-toggle");
  const searchForm = get<HTMLFormElement>("search");
  function showSearch(show: boolean): void {
    searchForm.hidden = !show;
    searchToggle.setAttribute("aria-expanded", String(show));
    if (show) get<HTMLInputElement>("ra").focus();
  }
  searchToggle.addEventListener("click", () => showSearch(searchForm.hasAttribute("hidden")));
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
  engineSelect.addEventListener("change", () => void load());
  cacheSelect.addEventListener("change", () => void load());
  get<HTMLSelectElement>("example").addEventListener("change", async (event) => {
    const target = SkyShift.TARGETS.find((item) => item.id === (event.target as HTMLSelectElement).value);
    if (!target) return;
    get<HTMLInputElement>("ra").value = String(target.ra);
    get<HTMLInputElement>("dec").value = String(target.dec);
    get<HTMLSelectElement>("band").value = String(target.band);
    if (busy) return;
    if (target.id === "wise0855") {
      const previousFrame = frame;
      frame = modeSelect.value === "exposures" ? 0 : 1;
      if (await load(ASSETS.fixture)) {
        isBundled = true; currentSelection = undefined; fullBandFixture = ASSETS.fixture;
        wavelengthSelection = null; marker.checked = false;
        get("target").textContent = target.label;
        get("coordinates").textContent = "RA 133.759765° · Dec −7.242186° · 4.42–5.00 μm · 2.1′ field";
        commitView();
      } else frame = previousFrame;
      return;
    }
    try {
      const response = await fetch(`examples/${target.id}.json`);
      if (response.status === 404) { status.textContent = `${target.label} is not bundled. Select Search to load it from the archive.`; return; }
      if (!response.ok) throw new Error("Could not load the example bundle.");
      const bundle: { fixture: SkyShift.PackedFixture } = await response.json();
      const previousFrame = frame; frame = 0;
      if (!await load(bundle.fixture)) { frame = previousFrame; return; }
      fullBandFixture = bundle.fixture; wavelengthSelection = null; isBundled = false;
      currentSelection = { ra: target.ra, dec: target.dec, band: target.band, fov: 5 };
      get("target").textContent = target.label;
      get("coordinates").textContent = `RA ${target.ra.toFixed(6)}° · Dec ${target.dec.toFixed(6)}° · Band ${target.band} · 5′ field`;
      marker.checked = false;
      for (const name of ["gaia", "wise"]) { delete catalogues[name]; get<HTMLInputElement>(name).checked = false; }
      get("catalogue-list").replaceChildren(); commitView();
      status.textContent += " · Bundled sampled observations";
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  });
  get<HTMLFormElement>("search").addEventListener("submit", (event) => {
    event.preventDefault();
    void search();
  });
  async function search(savedAsof?: string): Promise<void> {
    if (busy) return;
    let ra: number, dec: number;
    try {
      ra = SkyShift.parseCoordinate(get<HTMLInputElement>("ra").value, "ra");
      dec = SkyShift.parseCoordinate(get<HTMLInputElement>("dec").value, "dec");
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      return;
    }
    const band = Number(get<HTMLSelectElement>("band").value);
    const fov = Number(get<HTMLSelectElement>("fov").value);
    const from = get<HTMLInputElement>("date-from").value, to = get<HTMLInputElement>("date-to").value;
    if (!!from !== !!to || (from && (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from > to))) {
      status.textContent = "Enter both dates in chronological order, or leave both blank."; return;
    }
    const cutoff = savedAsof ?? new Date().toISOString();
    const cutoffMs = Date.parse(cutoff);
    if (!Number.isFinite(cutoffMs) || cutoffMs > Date.now() + 86400000) { status.textContent = "The shared cutoff date is invalid."; return; }
    pause();
    busy = true;
    updateControls();
    searchController = new AbortController();
    interrupt = () => searchController?.abort();
    try {
      status.textContent = "Searching SPHEREx observations…";
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
      for (const name of ["gaia", "wise"]) { delete catalogues[name]; get<HTMLInputElement>(name).checked = false; }
      get("catalogue-list").replaceChildren();
      get("wave-status").textContent = "";
      isBundled = false;
      currentSelection = { ra, dec, band, fov, asof: new Date(cutoffMs).toISOString(), ...(from && to ? {from, to} : {}) };
      marker.checked = false;
      const target = SkyShift.TARGETS.find((item) => item.ra === ra && item.dec === dec);
      get("target").textContent = target?.label ?? "Sky field";
      get("coordinates").textContent = `RA ${ra.toFixed(6)}° · Dec ${dec.toFixed(6)}° · Band ${band} · ${fov}′ field`;
      showSearch(false);
      commitView();
      status.textContent += " · Sampled observations";
      if (data.collections.some((item: { status: string }) => item.status !== "ok")) {
        status.textContent += " · Some archive collections were unavailable or truncated.";
      }
    } catch (error) {
      searchController?.abort();
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      searchController = undefined;
      interrupt = undefined;
      busy = false;
      updateControls();
    }
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      pause();
      if (!searchForm.hidden) { showSearch(false); searchToggle.focus(); }
      return;
    }
    if (busy || event.target !== sky) return;
    if (!playback && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      manualStep(event.key === "ArrowRight" ? 1 : -1);
    } else if (event.code === "Space") {
      event.preventDefault();
      if (playback) pause();
      else if (modeSelect.value === "blink") toggleBlink();
      else togglePlay();
    }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
  addEventListener("pagehide", () => {
    pause();
    worker?.terminate();
    if (workerURL) URL.revokeObjectURL(workerURL);
    workerURL = undefined;
  });
  const sharedRa = params.get("ra"), sharedDec = params.get("dec");
  const restoreWavelength = async () => {
    const min = params.get("waveMin"), max = params.get("waveMax");
    if (min !== null && max !== null) {
      get<HTMLInputElement>("wave-min").value = min; get<HTMLInputElement>("wave-max").value = max;
      await applyWavelength();
    }
  };
  if (sharedRa !== null && sharedDec !== null) {
    get<HTMLInputElement>("ra").value = sharedRa;
    get<HTMLInputElement>("dec").value = sharedDec;
    if (params.get("band")) get<HTMLSelectElement>("band").value = params.get("band")!;
    if (params.get("fov")) get<HTMLSelectElement>("fov").value = params.get("fov")!;
    if (params.get("from")) get<HTMLInputElement>("date-from").value = params.get("from")!;
    if (params.get("to")) get<HTMLInputElement>("date-to").value = params.get("to")!;
    void search(params.get("asof") ?? undefined).then(() => currentSelection ? restoreWavelength() : undefined);
  } else {
    void load().then(restoreWavelength);
  }
})();
