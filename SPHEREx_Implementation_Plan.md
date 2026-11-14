# SkyShift implementation plan

Project root is `/home/crow/planet`. This plan combines the archive findings in [Revision 2](SPHEREx_Project_Plan.md) with the processing, caching and scientific checks in [v1](SPHEREx_Project_Plan.v1.md). Use this file for implementation decisions and the earlier documents for measurements and design history. The interface now follows the full-screen sky-map design below.

## How to hand off the work

For the next UI build, start with [Task 7A](#task-7a-build-the-sky-map-wise-0855-prototype). It uses the bundled real WISE 0855 images and can proceed without archive access. Continue with Task 7B to integrate live, shared and embedded views. For the rest of the project, use each numbered task's pass criteria to identify the remaining work and follow its dependencies.

Copy this prompt and replace the task number when moving on.

> Work in `/home/crow/planet`. Read the Interface section of `SPHEREx_Implementation_Plan.md` and implement Task 7A. Read its dependencies and open the existing files before editing. Reuse the bundled WISE 0855 frames, worker and difference calculation. Run the applicable acceptance checks. Report observed results and any verification that is pending.

Use the actual repository state as the starting point. A task that already passes can be marked complete with the evidence. Offline fixtures are sufficient for tests of parsing and processing. Record live service and browser checks separately when the environment blocks them.

Implementation choices made for this handoff are to keep the static prototype's stack, use the existing 64 MiB cache budget, start with bounded automatic downloading and add the thin Node search route. Treat the network and storage limits as initial values to measure.

## Product and release targets

SkyShift is an embeddable public viewer for exploring how real SPHEREx observations change over time. A visitor picks a sky location, field size and detector band, then plays the observation frames and inspects motion or brightness changes.

| Release | Visitor can do |
|---|---|
| Prototype today | The built viewer includes the WISE 0855 band 6 fixture, three-visit playback, an engine switch and a benchmark. Node numerical checks have passed. Browser interaction and persistent-cache timings are pending. |
| Next UI prototype | Compare two bundled WISE 0855 visits in a large sky canvas using a thumbnail timeline, Blink and Difference. |
| First public version | Load all five verified examples, query a new position, choose a band and field size, compare visits, inspect quality and provenance, and share or embed the view. |
| Full challenge version | Refresh releases, browse all six detector bands and available narrow channels, extract a quick-look spectrum, stack or subtract selected images, overlay catalogues, and examine available contamination flags. |
| Scientific extensions | Validate photometry with the spectral calibration data and propagate uncertainty through matched comparisons. Offer a gateway for heavy cutouts or processing when measurements justify it. |

**Implementation choices**

- Use Rust compiled to WebAssembly for alignment and stacking. Extend the Rust kernel for numerical operations as they are validated. TypeScript handles UI, network requests, FITS decoding, cache coordination and worker messages. Keep the TypeScript numerical engine as a benchmark and an explicit fallback.
- Keep the current static TypeScript/Canvas app. It already has a build script, a worker, a benchmark and transferable numeric frames. A compact Canvas remains the main viewer. Load Aladin Lite only for the optional sky context.
- Use a small server route for IRSA metadata. Retrieve pixel byte ranges directly from the public AWS mirror after the browser access check. Reuse one search handler in a local Node server and any eventual hosting adapter.
- Cache downloaded data and computed frames. Search metadata expires on a short clock. Keep saved science results keyed to their input versions and algorithm.
- Ship one real visit sequence with an honest quality label before expanding the interface. The numerical comparisons use a fixed sky grid with north up, east left and a common brightness scale.

## Starting point and baseline

| Existing file | Use |
|---|---|
| `src/kernel.rs`, `src/wasm.ts` | Rust alignment and stacking plus the memory interface. |
| `src/science.ts`, `src/worker.ts` | Types, grid generation, reference TypeScript engine, fixture packing interface, worker messages and IndexedDB. |
| `src/index.html`, `src/viewer.ts`, `src/style.css` | Shared viewer, playback controls, cache selector and benchmark panel. |
| `scripts/build.mjs`, `package.json` | Existing local build and generated viewer. |
| `scripts/benchmark.mjs`, `scripts/check-cache.mjs` | Measured numerical comparison and simulated storage checks. |
| `reference/spx.py`, `reference/fits_layout.py` | Reference search mapping, FITS headers, HTTP ranges and wavelength extraction. |
| `reference/targets.py`, `reference/stack_visits.py`, `reference/measure_frames.py` | Example coordinates, visit stacks and photometry cross-checks. |
| `reference/_work/wise0855_d6.json` | Existing numerical fixture with 45 real exposures and the reference stacks. |
| `dist/benchmark.json` | Recorded Node measurements for the prototype. |

Run from the project root.

```bash
npm run build
node scripts/check-cache.mjs
npm run bench
```

The normal Rust build target is `wasm32-unknown-unknown`. The build already has a local LLVM fallback for the environment without that target. Use the standard target when available and retain the build metadata when comparing results. Open `dist/index.html` in a browser or serve `dist/` on localhost. Use an HTTP origin for persistent-cache and embedding checks.

The current build reads the pinned real fixture and its manifest from `reference/fixtures/`. Keep the build runnable from a fresh checkout with those documented assets. Raw observation caches and scratch scripts belong outside the public build.

The existing WISE 0855 fixture is a **41 × 41 output grid at 3.075 arcsec per pixel**, roughly 2.1′ across. Its three visits have **3, 21 and 21 exposures**. Keep those counts and actual field size when displaying the fixture. The live viewer will default to 5′. Generated benchmark scenarios with larger fields use synthetic pixels and stay in diagnostics.

| Workload | TypeScript processing | Rust/WASM processing |
|---|---:|---:|
| WISE 0855, 45 real exposures | 6.6 ms | 5.0 ms |
| 5′, 60 synthetic exposures | 74.6 ms | 48.1 ms |
| 20′, 60 synthetic exposures | 1.03 s | 0.69 s |
| 20′, 360 synthetic exposures | 7.47 s | 5.65 s |

Both engines agreed on all output pixels and missing-data masks in the recorded runs. The real fixture differed from the Python reference by at most approximately `5.24 × 10⁻⁷ MJy/sr`. These figures describe local Node numerical processing. Measure browser startup, IndexedDB and live transfer in Task 15.

## Data contracts

### Coordinates and view state

Use ICRS. Decimal input uses degrees for both coordinates. Accept sexagesimal RA in hours and declination in degrees only when given an explicit form such as `08h55m10.831s`, `−07d14m42.53s`, or the two labelled colon-delimited fields. Validate finite values, minutes and seconds below 60, RA within its allowed range and declination within ±90°. Normalize RA 360° to 0°. Preserve the sign of decimal or sexagesimal declinations, including `−0° 30′`. Reject extra text and partial fields.

For a fixed coordinate, keep the sky centre fixed. For a named preset, use its propagated centre at the documented reference epoch and show the predicted motion separately. Keep the catalogue epoch, proper motion and any available parallax in the target record. A linear proper-motion estimate can drive the marker. Its label must identify it as a prediction. Use the archive headers and calibration data for science claims.

Keep one parsed view state. Serialize these settings to the URL.

| Parameter | Values and units |
|---|---|
| `ra`, `dec` | Canonical decimal ICRS degrees for a live view. |
| `preset` | Stable ID for a bundled example. The bundle manifest supplies the centre and actual extent. |
| `fov` | Field diameter in arcminutes. Live choices are 5, 10 and 20. |
| `band` | Detector number 1–6. |
| `view` | `stack`, `exposures`, `blink`, `difference` or `sum`. Accept `diff` as an alias for `difference`. A restored Blink view opens paused. |
| `frame` | One-based selected frame index. Clamp after the sequence resolves. Timer ticks update only the visible frame. |
| `a`, `b` | One-based comparison inputs within the resolved sequence. Legacy `reference` is zero-based and supplies A when `a` is absent. A legacy Difference or Sum link uses `frame` for B when `b` is absent. |
| `at` | Optional map view as `ra,dec,z`: the view centre in decimal ICRS degrees and the zoom level (see Interface). Omitted at the default framing. Legacy `zoom=1`, `2` or `4` maps to z = 3, 4 or 5. |
| `stretch` | `balanced`, `faint` or `linear`. Missing or invalid values use `balanced`. |
| `asof` | ISO UTC cutoff for selecting observations. Convert it to an upper MJD bound when searching. |
| `from`, `to` | Optional paired UTC calendar dates (`YYYY-MM-DD`). Include the entire `to` date before applying the `asof` cutoff. |
| `waveMin`, `waveMax` | Optional paired wavelength bounds in micrometres. Restore the filter before resolving frame and comparison indices. |
| `manifest` | Optional versioned identifier for a published or bundled manifest. |
| `embed` | `1` selects the compact viewer. |

Preserve existing prototype links that use `engine`, `cache` and `frame`. Keep engine and cache controls in diagnostics in the public viewer. The share link includes sky settings and a cutoff. A versioned manifest records the actual products and settings for exact reproducibility. If a historical input is unavailable, show that status and make refreshing an explicit visitor action.

### Search endpoint

Implement `GET /api/observations`. Accept `ra`, `dec`, `fov`, `band`, and optional paired `fromMjd` and `toMjd`. The client parses coordinate formats and ISO UTC dates, then maps the view's cutoff and selected interval to effective bounds. For JavaScript epoch milliseconds use `mjd = utcMs / 86_400_000 + 40587`. The server validates every parameter again. With bounds omitted it uses the configured survey start through the request time. Use explicit UTC date labels and keep observation time separate from the metadata check time.

Use a small configuration list containing `spherex_dr1`, `spherex_dr1_deep`, `spherex_qr3` and `spherex_qr3_deep`. The spectral all-sky cube is a separate context layer. Query the IRSA SIA2 service with `COLLECTION`, `POS=CIRCLE ra dec radiusDeg`, `BAND` in metres, `TIME` in MJD and a finite `MAXREC`. For the circular view, the initial radius is `fov/120` degrees. Use the configured detector wavelength range for `BAND` and confirm the returned detector after parsing.

Start with IRSA's documented JSON response format. Capture a small real response and test its actual structure before declaring the adapter live. Existing coverage CSVs are useful for offline reference rows. Their `cloud_access` field can contain unquoted commas, so use the actual provider response format when building the live adapter.

Bound the search. Start with 500 rows per collection per query, at most four upstream requests in flight, and a ten-second per-request timeout. Wide collections use the effective date bounds. Deep collections use at most 90 days ending at the effective upper bound. Return the actual queried windows and provide earlier-window navigation when appropriate. Report an overflow marker or a reached row cap as potentially truncated and offer a narrower time selection. Tune these limits after live measurements.

Normalize to this shape. Field names and units are stable across provider adapters.

```ts
type Observation = {
  id: string
  collection: string
  detector: 1 | 2 | 3 | 4 | 5 | 6
  productKey: string
  processingVersion: number | null
  processingDate: string | null
  startMjd: number
  endMjd: number
  footprintIcrs: string | null
  sourceUrl: string
}

type ObservationReply = {
  checkedAtUtc: string
  observations: Observation[]
  collections: {
    name: string
    status: "ok" | "truncated" | "unavailable"
    fromMjd: number
    toMjd: number
  }[]
}
```

Parse by field name. Map `obs_id`, `obs_collection`, `energy_bandpassname`, `access_url`, `t_min`, `t_max` and optional `s_region` from checked upstream records. Use the full product key as identity and de-duplicate it in the search response. For stacking, group known reprocessings by observation ID and detector, prefer the highest verified version and latest processing date, and record the selected key. Support the regular `l2b-v27` and retry `l2b_retry-v27` naming patterns. Retain unknown processing versions as unknown. Sort by observation time with a stable key tie break. Preserve collection errors when returning partial results. Return 400 for invalid queries, 200 for successful and partial searches including empty results, and 502 when every collection fails.

The proxy contacts only its configured IRSA endpoint. Validate returned product paths against the SPHEREx archive prefix and configured releases, then derive the S3 key. Keep downstream binary fetches on the configured public bucket. Encode query parameters with `URLSearchParams`.

### Exposure, frame and result

Extend the existing namespace types in `src/science.ts` around the current `Exposure`, `Grid`, `Sequence`, `Engine` and `AlignedSeries` interfaces. Existing benchmark and fixture entry points should still run.

| Record | Required content |
|---|---|
| Exposure | Normalized observation identity, validated FITS metadata, native crop origin in zero-based pixels, crop dimensions, calibrated `Float32Array` surface brightness, time and optional wavelength/flags/variance. |
| Frame | Grid centre, scale, shape and orientation, `Float32Array` pixels in MJy/sr, visit dates, detector, wavelength span when available, loaded/available exposures, per-pixel contributions when available, warnings and exact input IDs. |
| Result manifest | Product IDs and versions, crop geometry, time bins, projection and scale, pixel mask rules, processing parameters, algorithm revision and source links. |
| Work message | Progress, result or error for the active request ID. Transfer final pixel buffers to the UI. Drop messages from superseded jobs. |

Use these minimum fields for the manifest and worker implementation. The TypeScript names here describe the transport shape and can extend the existing types.

```ts
type GridSpec = {
  raDeg: number
  decDeg: number
  side: number
  scaleArcsec: number
  projection: "TAN"
  footprint: "circle" | "square"
}

type ProductRef = {
  productKey: string
  inputRevision: string | null
  sourceUrl: string
}

type FrameSpec = {
  id: string
  detector: 1 | 2 | 3 | 4 | 5 | 6
  startMjd: number | null
  endMjd: number | null
  dateLabel: string
  selected: number
  contributing: number
  available: number
  inputs: ProductRef[]
  warnings: string[]
}

type ResultManifest = {
  schemaVersion: 1
  grid: GridSpec
  algorithmVersion: string
  mode: "stack" | "exposures" | "diff" | "sum"
  asOfUtc: string | null
  frames: FrameSpec[]
}
```

Extend the manifest with crop bounds, wavelength selection, time bins and calibration/quality settings as each operation is enabled. Live frames use exact time bounds and source identities. The legacy fixture may leave unknown timestamps or cutoff null and use an empty input list with an explicit provenance warning. For live jobs, carry `requestId` on requests and frame, progress, result or error replies. Treat frame pixels as a transferable array separate from the manifest. Send progress with stage, completed count, total count and bytes received where known.

The current `ExposureHeader.size` and WASM alignment call assume square crops. For the first live path, decode bounded rectangles with explicit width and height. Pad or copy them into a square native crop with missing values outside the valid rectangle, while retaining the correct zero-based origin. Test edge alignment before modifying the numerical interface. When a kernel interface or algorithm changes, rebuild both consumers and rerun the reference comparison.

Use nonfinite pixels for missing numerical data and keep a separate quality reason when known. The UI maps missing coverage and saturation to distinct text or markings. Use Float64 for WCS geometry and Float32 for the stored calibrated pixels and frames. Keep numerical arrays separate from display stretch and palette.

### FITS range reader

Reuse the reference logic in `reference/spx.py`. Level 2 spectral products contain calibrated detector exposures. The required `IMAGE` plane in the current fixture is 2040 × 2040 and uncompressed. Read the FITS header and the requested image rows.

1. Request the first 28,800 bytes. Scan 80-byte header cards, find each `END` card and advance to the next 2,880-byte block boundary. Derive the IMAGE data offset from the headers. If a header extends beyond the initial range, read more bounded blocks up to a documented limit. Check extension name, image shape, `BITPIX=-32` and WCS metadata before processing.
2. Project the requested circular sky footprint to detector pixels and pad for bilinear interpolation. Clip the native rectangle to detector bounds. Keep off-detector output missing. Verify edge coverage on fixtures. The rows transmitted by S3 can be wider than the requested crop.
3. Request a single contiguous byte range. With inclusive coordinates `x0,y0,x1,y1` and detector width `nx`, compute `start=dataOffset+4*(y0*nx+x0)` and `end=dataOffset+4*(y1*nx+x1)+3`. Read big-endian floats and apply FITS scaling when present. Extract only the needed columns for the stored crop.
4. Require HTTP 206 and the expected byte count for a ranged read. When exposed, validate Content-Range against the requested offsets. Abort an unexpected full response before reading its body. Verify the storage and timing cost with real responses.
5. Take `MJD-AVG` from the image header when available. Fall back to the metadata midpoint with a provenance label. Preserve original and processed product identifiers.
6. Add a targeted WCS-WAVE reader for spectral views. Validate the extension identity, table dimensions and units before interpolation. Use the product-specific wavelength mapping. The centre wavelength depends on position on the detector. Use `CWAVE` and `CBAND` calibration for quantitative products.

Load the selected detector first. Start with the oldest and newest usable visits so a comparison appears early. Cap binary fetches at six in flight. Provide progress and cancellation. Use bounded retries for transient responses, and respect Retry-After when present. Track bytes before decoding and retain successfully completed cached inputs across cancellation.

## Scientific processing rules

| Mode | Input selection and output |
|---|---|
| Visit stack | Sort one detector's exposures by time and group by a gap greater than 40 days for sparse survey visits. Use explicit calendar or MJD bins for dense deep-field views. Align on the fixed sky grid, subtract the documented local background for display, median-stack finite pixels, and show exposure count and date range. |
| Exposure sequence | One observation per frame. Sort by time and show the observation's wavelength and bandpass when available. Use it to inspect movement within a visit. |
| Narrow channel | Select exposures by per-position wavelength overlap. Show missing coverage and the actual wavelength interval. |
| Visual sum or difference | Combine aligned frames with compatible grid, band and processing versions. Use pixels present in the required inputs. For difference show `comparison − reference` with a signed colour scale centred at zero. Label it “Visual difference”. |
| Quantitative comparison | Match wavelength selection, background, PSF, astrometry and calibration. Use valid coverage and propagate uncertainty with the resampling and matching recipe recorded. Validate with control and injected-source fixtures. |
| Quick-look spectrum | Perform native-pixel aperture photometry at the selected source location. Use wavelength and bandpass at that location, a recorded local background annulus, flags when available and a pixel-area conversion. Show time, visit, coverage and uncertainty quality for every point. |

Offer the detector summary for detecting motion, and use matched wavelengths for brightness comparisons. Six detector bands cover the 102 nominal spectral channels across available exposures. A visit's set of measured wavelengths can vary. Show that coverage and avoid interpolating absent data into observed values.

Start with the existing TAN-SIP projection, bilinear resampling and median reference. Maintain orientation and the 3.075″ default output scale. Preserve the current frozen fixture recipe, which subtracts a per-exposure median after resampling and skips an exposure when less than half its output pixels are finite. Version any mask or coverage change for live processing. Treat display stretch as one control shared across a sequence. Save NaN masks through resampling and stacking. Retain source metadata and enough contributor information to reproduce each frame.

For quick-look aperture photometry, start with the reference 2.5-native-pixel aperture and an 8–14-pixel background annulus. Verify that the crop includes the annulus and that the aperture is adequately covered. Convert surface brightness to flux density using the stated solid angle. Treat a saturated or incomplete aperture as unavailable for ordinary photometry. Offer saturated-wing measurements only after validation and label them approximate. Show uncertainty only when derived from defensible inputs. Leave gaps where a measurement is unavailable.

Treat mixing processing versions as a visible provenance condition. Group or require explicit compatible selection before a numerical comparison. Use positional propagation for moving sources when extracting spectra. Claims about change require controls, quality checks and traceable input measurements.

## Caching and performance

Use existing IndexedDB transaction and usage-metadata logic. Cache input arrays and completed computed products. Keep returned values usable if persistent storage is unavailable.

| Cache | Identity and policy |
|---|---|
| Observation metadata | Normalized query plus collection configuration. Start with 15 minutes in browser storage and one hour in the proxy or shared cache. Empty results get a five-minute expiry. Preserve an explicit refresh action and show checked time. |
| FITS headers and crops | Provider, product key and validated input revision, plus native pixel rectangle for crops. Retain the native geometry. Use an exposed validator or a verified content hash where feasible. Track revalidation for mutable paths. |
| Stacks and differences | Ordered product identities and revisions, projection, grid, wavelength choice, time bins, operation and algorithm revision. Include mask, background and PSF rules that affect the result. |
| Spectra | Input versions, source location and epoch or trajectory, wavelength calibration, photometry recipe and algorithm revision. |
| Previews and bundles | Immutable versioned assets. Preview keys include display parameters. Source frames remain reusable when the stretch changes. |

Resolve the product recipe from pinned manifests or current metadata. Look for in-memory and persisted results before fetching pixels or starting the kernel. Cache native crops so repeat visits can skip downloads even when a result has been evicted. Later, standardize shared crop tiles where it improves reuse between nearby fields. A stable product key includes ordered identity and version. A changed calibration or operation creates a new derived identity.

Use the existing 64 MiB browser cache budget as the starting value. Measure usage and evict least-recently-used entries. Commit complete records atomically. Keep large arrays in IndexedDB, with small metadata used for eviction. Coalesce duplicate work for the same pending key. Handle quota errors, cache eviction and interrupted jobs without losing the current usable viewer. A clear-cache control belongs in diagnostics.

For the first release, work on one detector and one visit at a time. Estimate the row, header and working-memory costs before queuing. Display the projected transfer for larger fields. Start with a maximum of 60 exposures or 32 MiB estimated image transfer, whichever is reached first, for automatic loading. Select from the oldest and newest available bins first, sample deterministically by time if needed, and label any partial stack. Show the available count and allow the visitor to request more. These starting limits can be revised after browser measurement.

The archive measurements in Revision 2 estimate approximately 26 MB for one 5′ band and 97 MB for one 20′ band with 60 exposures. These figures use untrimmed S3 rows. Log actual bytes and requests in diagnostics. Compare warm and cold paths on a real browser. Add an optional trimmed-cutout gateway when the measurements show download and request latency dominate.

## Interface

The interface is a full-screen sky map in the style of Google Maps. The whole viewport is a pannable, zoomable canvas, with controls floating over it. The first walkthrough is **open WISE 0855 → inspect visits A and B → Blink → check Difference**, and the map must keep that path one tap away. Keep the data canvas in the existing TypeScript and Canvas renderer. Use a near-black sky, charcoal floating cards, grayscale infrared images and one cool accent for focus and selection. Reserve a labelled diverging palette for signed differences. Outside the loaded field, draw only a labelled RA/Dec grid and the field's outline. Do not show survey tiles that could be mistaken for SPHEREx pixels.

### Map, default view and navigation

- The map uses a gnomonic projection about the view centre, with north up and east left. The zoom level `z` is log2(CSS px per aligned-grid pixel), so whole-number levels keep pixel edges crisp. The range is −3 to 6. The field image, grid, scale bar, catalogue markers and pixel readout all come from the same projection.
- The default view is the WISE 0855 field centre (RA 133.759765°, Dec −7.242186°) at z = 3. That is 8 CSS px per 3.075″ pixel, which makes the 2.1′ field a 328 px square. A newly loaded field opens centred in the uncovered map area, at z = 3 or at the largest whole level that fits a larger field. The uncovered area is the viewport minus the top bar, the dock, an open panel, and the control column on phones.
- Dragging pans, and the grabbed sky point stays under the pointer. Wheel, trackpad pinch and two-finger pinch zoom at the pointer. Double-click or double-tap zooms in, and Shift + double-click zooms out. Zoom ± and Recenter stay visible on every device as single-pointer alternatives.
- Wayfinding: the field outline is always drawn, and below about 24 px it becomes a named pin. When the field is out of view, an edge chip points back to it and shows the distance. Moving the map never replaces data. **Search this area** appears once the view centre is more than one field width from the loaded field, and it submits that centre through the existing search.
- A click or tap opens a position card. It shows sexagesimal and decimal coordinates and, inside the field, the pixel value in MJy/sr, with **Center here**, **Details**, **Search here** and **Copy**. The card is also the single-pointer alternative to dragging.
- Keyboard, with the map focused: arrows pan (Shift pans further), `+` and `−` zoom, `0` recenters, Space plays or pauses, `,` and `.` step frames, `B` toggles Blink, `D` toggles Difference, `I` opens details, `/` focuses search, `?` lists shortcuts. Esc closes the top layer, then pauses. In the thumbnail strip, ← and → step through visits.

### Desktop and phone layout

| Region | 900 CSS px and wider | Phones |
|---|---|---|
| Search | A top-left pill with one box for a target name or RA, Dec. Below it: a live preview of the parsed input, suggestions, and an options row (band, field size, dates). Example chips sit to its right. | Full-width pill, with the chips scrolling beneath it. |
| Top right | Keyboard shortcuts and Share. | Share. |
| Place panel | A left panel opened by the brand button, **Details** or `I`. It shows the name, coordinates, actual field size and band; This frame and View; Wavelength; Spectrum; Quality and provenance; Diagnostics. The panel is non-modal, so the map stays usable, and opening it keeps the field visible. | A 76 dvh bottom sheet. |
| Bottom centre | The timeline dock: Play, Previous and Next; visit thumbnails with date, count, shallow mark and A/B badges; A and B selectors; **Blink**; **Difference**. Collapsing hides the thumbnails and selectors but keeps the actions. | A full-width bottom dock. |
| Bottom left | Layers: stretch, grid, predicted position, Gaia DR3, CatWISE2020. | In the right-edge button column. |
| Bottom right | Recenter and zoom ±, then a strip with orientation, scale bar, cursor readout and attribution. | Right-edge column; the strip sits above the dock. |
| Floating | The field label with the active date and A/B; the Difference legend at top right; the status toast with Cancel above the dock; a one-time hint pointing at Blink. | The toast moves below the search. |

On coarse pointers, touch targets are at least 44 × 44 CSS px. The page itself never scrolls; only the thumbnail strip, the chips and the panel do. Informational overlays (toast, legend, field label) let touches through to the map. Exact sizing and spacing can be adjusted while retaining this arrangement.

### Timeline, Blink and Difference

- Open paused. Show real WISE 0855 data at its bundled size of roughly 2.1′. Make the three visits legible as May 2025 (3 exposures, shallow), Oct–Dec 2025 (21) and Apr–May 2026 (21). Start with the October–December visit visible and assigned to A, and the April–May visit assigned to B. Each thumbnail uses the sequence stretch; its accessible name includes the date, count and any A or B assignment. Clicking a thumbnail pauses playback and previews that visit. Explicit A and B selectors assign comparison inputs.
- For another sequence, select the latest two loaded visits with at least five contributing exposures when there are two. Otherwise select the latest two available visits. Order the default pair from earlier to later. An explicitly assigned shallow input remains usable and visibly marked. Reopening a share link takes precedence over defaults. After a band, time or wavelength change, retain an assignment only if that same frame is still available in the current field and detector; otherwise resolve defaults from the new sequence.
- **Play visits** loops through the full sequence at 850 ms per frame. **Blink** immediately shows A, then alternates A and B every 500 ms until paused. Use a single playback timer. Starting either playback mode stops the other. Leaving the page, opening the place panel, changing inputs, changing display settings, entering Difference or pressing Esc pauses playback. Panning and zooming do not pause, so a visitor can zoom into a source while it blinks. Loading a shared view or a new field keeps playback paused. Keep native keyboard behavior in inputs and selectors.
- Keep plate scale, field centre, zoom and stretch identical across both Blink frames. Show the active A or B and its date in the viewport without continuous screen-reader announcements. Hide epoch-dependent prediction and catalogue markers during active Blink so they do not introduce apparent movement, and restore those layers when paused. All motion starts from an explicit action. Avoid animated transitions between image frames.
- **Difference** uses `B − A` on the common finite pixels of compatible frames from the same loaded sequence. Show both dates and a symmetric signed scale with labelled negative, zero and positive values. Returning to Blink waits for a new start action. Keep Sum available as `A + B` in the View control in the place panel. If fewer than two distinct usable inputs exist, show a still or single-frame sequence and explain why compare actions are disabled. Apply the scientific processing and version-compatibility rules above.
- Use **Balanced** by default with the current shared stretch limits and current asinh curve (`asinh(16x) / asinh(16)` for normalized `x`). **Faint** uses the same limits and replaces 16 with 64. **Linear** uses linear mapping across those limits. Apply the active stretch to both inputs and all thumbnails. Draw Blink, frame stepping and display changes from loaded frames without new archive requests or alignment work. Regenerate thumbnails when the sequence or stretch changes. Commit URL changes on user actions.

### Search, place panel and release scope

- Search accepts the existing presets and manual coordinates. Keep the actual loaded field size visible even when the form requests a different size. A successful request opens a paused sequence. During loading use an actionable status such as “Loading 12 of 60 observations”. Keep the previous pixels and their own labels visible during a failed or cancelled replacement and show the new request's error separately.
- The place panel groups wavelength coverage, exposure counts, quality flags and source files with the relevant frame or comparison. It also hosts catalogue toggles, spectrum, metadata export and advanced display options. Keep cache controls, engine selection and benchmarks in Diagnostics. Start the predicted-position marker off in the WISE demo and allow visitors to enable it under Layers.
- Use the same comparison state for the compact embed. Show image, date, timeline, Blink, Difference and a provenance link. Hide the search form and Diagnostics from the compact layout. Keep the existing app, search and data contracts as the integration path.
- The map's **Search this area** replaces the separate Find my field context. An optional survey backdrop (for example Aladin Lite or HiPS tiles) remains a Task 12 option. It must be off by default and labelled as not SPHEREx data.
- Task 7A proves the interface with bundled WISE 0855. Task 7B connects the complete workspace to live requests, preset restoration and embeds. The public release still requires all five real example bundles and the checks in Task 15. Calibrated measurements and a cutout gateway follow the separate extension criteria in Tasks 16 and 17.

## Implementation tasks

Tasks 1–8 build the first public version. Tasks 9–15 complete and verify the challenge features. Tasks 16 and 17 cover scientific and performance extensions. Each pass should leave the existing viewer buildable. File names below are suggested locations for new code.

### Task 1. Verify the baseline and package the WISE 0855 example

**Depends on:** the existing workspace. **Files:** `scripts/build.mjs`, `src/index.html`, `src/viewer.ts`, `reference/`.

- Build using the existing Rust kernel and TypeScript compilation path. Keep the two engines and the benchmark entry point. Verify the default viewer selects Rust and that `?engine=typescript` still works.
- Record the WISE 0855 fixture's actual field, detector, date ranges and contributing exposures. Use the reference exports and source product records to recover exact provenance. Mark absent metadata as unavailable until recovered. Keep the existing fixture and benchmark inputs reproducible.
- Establish a versioned example manifest format using the data contracts above. Include units, grid size, sky centre and the version of the stacking recipe. Retain the existing self-contained comparison page as a testable entry point.

**Pass when:** `npm run build` and `node scripts/check-cache.mjs` pass. Both engines produce the same missing-data mask and real fixture stacks within `1e-6 MJy/sr` of each other and the pinned Python reference, with counts 3, 21 and 21. This absolute tolerance applies to the frozen WISE fixture. Record the full reference comparison from `npm run bench` when establishing or changing the numerical baseline.

### Task 2. Implement input parsing and one view-state model

**Depends on:** Task 1. **Files:** `src/view-state.ts`, `src/targets.ts`, `scripts/build.mjs`, small focused checks.

- Implement pure functions for decimal and sexagesimal coordinate parsing, date window validation, query parsing and URL serialization. Use decimal ICRS coordinates internally and schema-checked defaults at the boundary.
- Define the five preset IDs from `reference/targets.py`. Keep original and propagated positions, the reference epoch and prediction metadata together. Start with the persisted 2026.0 centres for these example bundles.
- Make default and error handling deterministic. A bare URL opens the WISE 0855 example. Both coordinates are required for a live query. An explicit preset or live coordinate selection takes precedence over the implicit default.

**Pass when:** the challenge's WISE 0855 sexagesimal position parses close to RA 133.7951292°, Dec −7.2451472°. Cover RA 0°/360°, negative zero degrees with nonzero minutes, pole bounds, nonfinite input, missing fields, invalid band/field and reversed dates. Round-trip a view including the frame, stretch and time window. Shareable links preserve the existing prototype controls.

### Task 3. Build the IRSA search adapter and local server

**Depends on:** Task 2. **Files:** `config/archive.json`, `scripts/observations.mjs`, `scripts/serve.mjs`, `package.json`.

- Put the collection list, band ranges, survey date bound and public archive hosts in the configuration. Build one search handler with injectable fetch and time settings for offline checks.
- Capture and inspect a small IRSA response. Normalize it to `ObservationReply`, including the effective windows and collection statuses. Use recorded fixtures to test duplicate rows, retry names, provider error and caps. Correlate duplicate observation IDs and detectors to avoid counting reprocessed copies twice.
- Expose the handler locally at `/api/observations`. Serve the viewer and needed assets from `dist/`. Add `npm run dev` and print the loopback URL, using port 4173 by default. Use the same handler for a later hosting adapter. Constrain upstream concurrency and response size. Coalesce identical in-flight metadata requests and bound the short-lived response cache.

**Pass when:** a valid search returns sorted, deduplicated product records with detector, collection and MJD values. Invalid input returns 400 without a provider call. All-provider failure returns 502. A partial failure remains visible and a capped search reports truncation. Verify one small live search when the service is reachable. If access fails, keep the offline check and report which request failed and why.

### Task 4. Read an IMAGE crop from S3

**Depends on:** Tasks 1–2. **Files:** `src/fits.ts`, `src/archive.ts`, `src/science.ts`, worker build assembly.

- Decode the supported FITS header cards and WCS. Handle variable offsets, bounded header extension, the PC/CDELT transform and tested SIP order. Convert FITS coordinates to the zero-based crop convention consumed by the kernel. Reject unsupported headers with a product-specific error.
- Build the crop rectangle from the requested sky footprint and interpolation margin. Reuse the WCS projection for coverage checks. Generate one ranged IMAGE request and extract the selected columns from each returned row. Verify dimensions before allocating buffers.
- Keep transport, decoding and numerical alignment functions callable separately. Preserve the existing kernel and numerical reference. Read a real header and one valid cropped region in an integration check.

**Pass when:** known headers with IMAGE offsets 25,920 and 28,800 are interpreted correctly. A non-square clipped range with known big-endian values and missing pixels decodes to the expected shape and pixels. Cover malformed and oversized headers, invalid lengths, out-of-detector regions, unexpected HTTP 200 and short 206 responses. A real crop agrees with the reference reader for the same exposure and native rectangle.

### Task 5. Process a live sequence in the worker

**Depends on:** Tasks 3–4. **Files:** `src/worker.ts`, `src/science.ts`, `src/wasm.ts`, `src/viewer.ts`.

- Extend the worker request for live observations and preserve the fixture and benchmark requests. Build a fixed north-up output grid from the selected sky centre and field diameter. Apply a circular coverage mask for the circular view.
- Sort and select exposures within one chosen detector. Group sparse visits by the 40-day gap and group deep exposures into documented UTC bins. Use calendar-month bins for the first deep-field view. Show total versus selected and successful exposures. Keep selection deterministic when a limit is applied.
- Finish the oldest and newest useful bins before intermediate bins. Emit each completed frame with its time and stable identity. Keep the timeline sorted by time as frames arrive and preserve the active frame's identity. Emit progress per exposure. Process one visit at a time and release its working arrays. Track request identity, errors and cancellation. Rust/WASM runs the alignment and stacking.
- Treat zero visits as empty coverage and one visit as a still image. Keep a previous usable view under its own labels on failure or cancellation. Make a stale request's completion harmless when the band or field changes.

**Pass when:** a recorded search and real crops produce a Rust-rendered aligned sequence with the reference orientation, dates and counts. A replacement request ignores older results, cancel stops pending work, and failures or empty coverage have a visible status. Stamp the input product list and processing version on the result.

### Task 6. Make persistent cache reuse the normal path

**Depends on:** Task 5. **Files:** `src/worker.ts`, a focused cache module if needed, `scripts/check-cache.mjs`.

- Extend the current IndexedDB cache to store validated headers, native crops and versioned processing results. Use the existing usage records and eviction transactions. Keep the numerical benchmark's cache separate by its scenario and engine keys.
- Resolve the observation manifest, then check for completed results before downloading pixels or initializing WASM. Cache inputs even when the user cancels after a successful fetch. Store a stack only after its input set and completion state are known. Reuse results across display-only changes.
- Make input and computed-frame caching the public default. Keep the diagnostic choices for inputs alone and cache off. A later data revision or processing-recipe change gets a new key. For a mutable upstream path, keep source verification time and update it on revalidation. Expose the cache size and a clear action.

**Pass when:** repeat execution of the same recipe skips image fetches and compute, a stretch change reuses the numerical data, a changed input or algorithm misses the result cache, and two identical in-flight jobs share work. Check quota/cancel handling and eviction in the cache tests. Verify actual IndexedDB reads across a page reload in Task 15.

### Task 7A. Build the sky-map WISE 0855 prototype

**Depends on:** the bundled Task 1 fixture and existing alignment and arithmetic helpers. **Files:** `src/index.html`, `src/style.css`, `src/viewer.ts`, `src/map.ts` (projection and camera) and `scripts/check-map.mjs`.

1. Build the full-screen map, floating controls and phone layout described in the Interface section. Keep the search and existing tools accessible. Show the actual WISE field size, orientation, scale and visit metadata on the map and in the place panel.
2. Generate thumbnails from the aligned visit frames. Add A/B selectors and connect Play visits, Blink and Difference to the same loaded sequence. Render the legacy Difference and Sum modes with the existing arithmetic. Handle the single-visit state.
3. Add map navigation (drag, zoom at the pointer, keyboard, Recenter, off-screen chip, Search this area), shared stretch, and the non-modal place panel and phone sheet. Make the panel and comparison controls operable with keyboard and touch. Preserve engine and cache settings in Diagnostics.
4. Run `npm run build` and `npm test`. On an HTTP origin, check at 1440 × 900 and 390 × 844 CSS px with the bundled data. Record the walkthrough and any unavailable browser verification in the Task 15 results.

**Pass when:** opening WISE 0855 shows the field centre at z = 3 (a 328 CSS px field) and Oct–Dec 2025 paused, with A and B set to its two full visits. The timeline shows all three dates and counts and marks the first visit shallow. Blink shows only A and B at a common scale and stretch without additional pixel fetches or worker alignment. Difference shows both dates and `B − A`; swapping the pair reverses the sign. Play loops all three visits, and pausing or inspecting leaves one steady frame. Verify keyboard operation, readable phone controls and no page-wide horizontal scroll. A fixture-only run can satisfy Task 7A.

**Status (2026-11-14):** The map interface is implemented. `npm test` passes, including `scripts/check-map.mjs`, which checks projection round trips up to ±89°, zoom and drag anchoring, the 328 px default field, grid spacing, `at=` parsing and the search parser. A headless Chromium walkthrough over CDP at 1440×900 and 390×844 passed 35 checks:

- the paused default with A and B set, and the shallow mark;
- wheel zoom keeping the sky under the cursor, drag, the off-screen chip and Search this area;
- Space, B and D; Blink alternating A and B; Difference reversing sign when A and B are swapped;
- the panel's Escape focus return;
- no page scroll and 44 px touch targets;
- tap and pinch on the phone layout.

Still pending: a hand test in physical desktop and phone browsers, the live IRSA/S3 search, and the Play loop timing.

### Task 7B. Connect the workspace to live, shared and embedded views

**Depends on:** Task 7A and the interfaces in Tasks 2, 5 and 6. **Files:** the same viewer files, parsed view state and existing archive route integration.

- Connect the five presets, manual coordinates, live band and field selectors, timeline and Share. Use the existing band and field choices. Offer 0.5×, 1× and 2× playback speeds in the inspector with 1× as the default. Apply the same multiplier to Play and Blink intervals. Show preflight transfer estimates when available, coverage after load, and a clear reason for an unavailable band or comparison.
- Save field settings, A/B, frame, view, stretch and zoom through the URL contract. Restore older reference and difference links, handle pairs lost to filtering, and keep restored playback paused. Add the compact embed with the same comparison controls.
- Support preset name matching and manual coordinates. Add optional online name resolution through a configured CDS endpoint after capture and validation of a real response. Keep results labelled with catalogue reference epochs. A failed resolver keeps the coordinate form usable.

**Pass when:** a valid coordinate search reaches the worker, a failed replacement preserves the last loaded image and labels, and a shared view restores the same inputs and display settings in a fresh tab. A filtered sequence resolves its frame indices after filtering and disables compare controls when only one visit remains. The embed uses the same view state and works from another origin during the release check.

### Task 8. Build the five real example bundles

**Depends on:** Tasks 4–7. **Files:** a small script in `scripts/`, `reference/` inputs, versioned public example assets.

Reuse recorded coverage and reference readers. Fetch a targeted band and bounded date selection for each target. Prefer trusted local crops where present. Include the input product IDs, timestamps, field extent, actual selected band, warnings and Python comparison in each manifest. Generate a small initial render, with numerical frames available for comparison. Default WISE 0855 to the existing fixture when needed.

| Preset ID | ICRS centre at 2026.0 | Initial band | Review the result |
|---|---|---|---|
| `wise0855` | 133.759765°, −7.242186° | 6 | The two full visits show the faint source moving west. The three-exposure visit is marked shallow. |
| `barnard` | 269.446269°, +4.768204° | 6 | The comparison spans a northward shift near 10″ in the recorded interval. Show a quality warning for saturated shorter bands when available. |
| `epsindiB` | 331.096644°, −56.800660° | 2 | The available visits show the motion of the unresolved brown dwarf pair. Show the recorded coverage gap when applicable. |
| `rwaur` | 76.956587°, +30.401291° | 1 | Provide visits for brightness exploration. Validate claims using matched wavelengths and a stable comparison source. |
| `rdra` | 248.167233°, +66.754979° | 5 | Use deep collections and bounded bins. The core quality warning is visible. |

These centres come from `reference/targets.py`. The motion and brightness descriptions refer to Revision 2's recorded data. Recheck against the generated bundle and label insufficient coverage if the selected observations differ. Keep epoch-aware centring separate from the fixed playback grid.

**Pass when:** all five real example manifests validate, each example plays with the recorded dates and provenance while the live archive is unavailable, and approved Python fixtures agree within documented tolerances. Build the first-public-version candidate after a live search and the browser checks appropriate to it pass. Any unavailable pixel bundle remains an explicit release blocker for the five-example requirement.

### Task 9. Add exposure playback, stacking and visual arithmetic

**Depends on:** Tasks 5–8. **Files:** `src/science.ts`, `src/kernel.rs`, `src/wasm.ts`, `src/viewer.ts`.

- Add one frame per exposure mode and a visit selection for stacking. Allow visitors to sum selected aligned images or subtract a chosen reference frame from a comparison frame. Reuse caches with operation-specific keys.
- Compute on aligned, background-treated Float32 arrays in MJy/sr with compatible sky grids and input bands. Use finite common coverage for the sum or difference, preserve missing pixels, and display a signed difference centred at zero. Record input order and selections.
- Label the initial arithmetic products as visual comparisons. A broad band includes different wavelengths and PSFs across visits. Scientific measurement requires the matching in Task 16.

**Pass when:** fixture pairs produce the expected sum, signed difference and missing mask. Swapping the difference operands reverses the sign. Subtracting a frame from itself yields zero on finite common pixels. A change of display settings skips numeric recomputation. Exposure playback keeps the original observation order.

### Task 10. Expose wavelength coverage and narrow channels

**Depends on:** Tasks 4–5 and 9. **Files:** `src/fits.ts` or a small spectral module, worker and view-state files.

- Decode the WCS-WAVE lookup for each supported product. A trailing range shortcut is allowed after the extension name and layout are validated. Keep calibration provenance and estimate the wavelength and bandwidth at each selected sky position. Use actual table coordinates and declared units.
- Show the six detector wavelength ranges and the wavelengths measured in each view. Add a narrow-channel selector over the available nominal channels or a documented interval. Derive nominal channel boundaries from a verified calibration table. An unavailable channel has an explicit empty state.
- Use per-position bandpass overlap for narrow views. For image differences where wavelength varies across the field, carry the valid overlap mask through the numerical result. Retain representative per-exposure values for UI summaries.

**Pass when:** a known WCS-WAVE interpolation agrees with the reference lookup, missing or unsupported tables produce a meaningful status, and selecting a narrow channel gives the expected exposure set and dated coverage. Available channels are distinguished from the 102 nominal channels.

### Task 11. Add quick-look spectra and matched brightness views

**Depends on:** Tasks 8 and 10. **Files:** numerical kernel or focused photometry module, Tools and export code.

- On a selected source, align the aperture centre to its location in each native exposure. Compute the background and aperture flux using the documented recipe. Keep per-point observation time, detector, wavelength, bandwidth, flux in Jy, quality and optional uncertainty.
- Plot measured points grouped by visit, preserve coverage gaps, and provide CSV with the same units and quality fields. Cache completed spectra by source and input recipe. For brightness comparison, show matched wavelength points or bins and report the contributor count.
- Handle saturated centres and incomplete annuli with unavailable measurements. Place the approximate label beside the spectrum and export metadata. Keep quantitative fitting for Task 16.

**Pass when:** a real reference aperture agrees using identical background and pixel-area settings, a moving-source test uses its per-exposure position, and missing or saturated data produce a gap rather than a zero. Verify the RW Aurigae example against documented controls before stating a measured change.

### Task 12. Add catalogue overlays and wider sky context

**Depends on:** Tasks 7–8. **Files:** a catalogue adapter, viewer overlay code and Tools.

- Add opt-in Gaia DR3 and WISE/CatWISE markers. Query just the field, cap result count and cache by catalogue, sky region and release. Use provider records and their epoch conventions. Propagate proper motion to the displayed time when available and identify propagated positions in details.
- Place markers on the view's fixed WCS. Show the source ID, catalogue, reference epoch and any available quality information. Give each layer a visibility toggle.
- Load optional Aladin Lite context from **Find my field**. Pass its current centre and the chosen supported field size to the existing search when the visitor selects **Load this field**. Keep WISE survey imagery identified by instrument and observing epoch. Treat catalogue failures as an overlay status independent of the current image.

**Pass when:** a recorded catalogue star falls on the expected pixels, a known moving source's marker shifts with date, toggles work at phone widths, and provider failure leaves image navigation usable. Verify one live catalogue query when reachable and retain the response fixture.

### Task 13. Add FITS quality flags and coverage metadata

**Depends on:** Tasks 4, 8 and 9. **Files:** FITS flag decoder, quality metadata and viewer tools.

- Read FLAGS for a selected exposure or crop as an on-demand layer. Test the actual DR1/QR3 compression layout with a reference FITS reader. Reuse a verified decoder or a bounded trim/decode endpoint when the browser decoder lacks that format.
- Keep a raw mask and map documented bits to meaningful labels. Show unknown bits and unavailable data separately. A source-presence bit carries information about the exposure. Reject pixels only under documented quality rules.
- Preserve reasons for missingness, saturation, shallow coverage and other relevant contamination. Report the input and output contribution counts.

**Pass when:** known bit values map to the expected flags, an unrecognized layout gives an unavailable status, and the Barnard's Star and R Draconis quality examples agree with a known reference. Flag inspection requests only its needed bytes and does not redo the image alignment.

### Task 14. Complete evidence export and release updates

**Depends on:** Tasks 6–13. **Files:** view-state, manifest/export and archive configuration code.

- Export a candidate's marked coordinates, date range, detector/wavelength, exact source files and versions, grid, processing recipe, quality and display context. Support a portable JSON manifest and a rendered preview. Include source links and clearly identify qualitative products.
- Keep shared URLs compact and versioned bundle links stable. An `asof` date repeats a date filter. A pinned manifest records the exact selection. Test restoration of a pinned example and the response to missing original data.
- Refresh metadata on demand and on expiry. A release configuration change can add a new collection without editing the numerical kernel. Keep observation time, metadata check time and release version visible where relevant. Use versioned assets for CDN caching of curated bundles.

**Pass when:** a second person can open exported evidence and identify the exact input products and settings, an added test release is discoverable after refresh, and an old pinned manifest stays traceable or reports unavailable inputs. A cached failure or empty response never conceals a verified successful refresh.

### Task 15. Verify and package the challenge build

**Depends on:** Tasks 1–14 for the full challenge build. **Files:** existing build, tests and the release instructions.

1. Run `npm run build`, `node scripts/check-cache.mjs` and the focused checks added for the implemented tasks. Rerun `npm run bench` after kernel or processing changes. Keep the numerical and browser timing evidence separately.
2. Test a desktop browser and a phone-width viewport on an HTTP origin. Run the WISE walkthrough in Task 7A and check live search, A/B URL restoration, keyboard controls, embed, cancellation and cache-disabled fallback. Observe a repeat visit from a fresh tab sharing the same origin. Measure whole-result time, first render time, transferred bytes and cache hits.
3. Test new-location discovery, a dense R Draconis window, provider failure, truncated results and missing original assets. Record what ran against live IRSA, S3 and catalogues and what ran with fixtures.
4. Document build and launch commands, the configured API location and source data credits. Build a static frontend plus the small search handler. Use a chosen host for public deployment when requested. Verify its API and cross-origin byte-range access before calling that deployment publicly ready.

**Pass when:** each item in the challenge coverage table below has a reproducible walkthrough, all five real presets work, and an independent browser session can run a new coordinate search and share the result. Record browser/device and network details with measurements. Add the official SPHEREx/IRSA data acknowledgement from the DR1 overview.

### Task 16. Validate calibrated scientific products

**Depends on:** Tasks 10–13 and the reference measurements. **Stage:** scientific extension.

- Retrieve the science-grade wavelength calibration, supported PSF information, variance and valid flags for controlled inputs. Validate positional, wavelength and intensity calibration before comparing a measurement.
- Match wavelength coverage and PSF with a recorded method. Propagate variance through the relevant operations and account for correlation introduced by resampling. Use native measurements or measured control scatter where appropriate and disclose limitations.
- Verify an unchanged field, an injected moving source, an injected flux change and saturated exposures. Compare the quantitative path with independent Astropy/IRSA-based reference results. Keep the qualitative views available for exploration.

**Pass when:** the numerical tolerances and reference dataset are documented before testing and met on the chosen controls. Quantitative difference, flux and uncertainty claims become available only for validated inputs and supported regimes.

### Task 17. Reduce cold transfer when real measurements justify it

**Depends on:** Task 15 browser and archive timing. **Stage:** optional performance extension.

- Add a bounded trimmed-crop gateway behind the same archive interface. Resolve only configured product keys and crop rectangles, request the needed S3 ranges, retain the validated calibration metadata and send the cropped pixels. Evaluate standard reusable tiles if neighbouring searches share enough source crops.
- Compare direct S3 and trimmed delivery on the same visits and field. Include request count, bytes, time to first image, time to completed sequence and operational cost. Cache immutable versioned products when reuse is observed.
- Keep this gateway useful for validated heavy jobs or unsupported browser decoding. Those operations are optional capabilities within the same search and manifest model.

**Pass when:** cached and direct calculations use the same inputs and agree within the recorded numerical tolerance, cancellation and resource limits work, and the measured cold load benefit justifies the chosen hosting setup.

## Challenge coverage and release evidence

| Challenge consideration | Task | Demonstration |
|---|---|---|
| New data releases | 3, 6, 14 | Add a collection in configuration, refresh a query, and trace the older pinned example. |
| Six detector views, spectral channels and spectra | 8, 10, 11 | Choose a band and available narrow channel, then plot and export a source spectrum by visit. |
| Sum and subtract observations | 9 | Select compatible frames, show the signed difference and the sum, and inspect their contributing exposures. |
| Adjustable field of view | 2, 4, 7 | Request 5′, 10′ and 20′ fields, show the transfer estimate, and verify the centre and coverage. |
| Gaia and WISE context | 12 | Toggle catalogue markers and inspect their epoch and provenance. |
| Shareable coordinates and embedding | 2, 7, 14, 15 | Restore a shared view in a new session and load the compact viewer inside another page. |
| Metadata and contamination flags | 7, 13 | Inspect a shallow or saturated observation and open its flag details. |
| Existing astronomy tools | 1, 8, 12, 16 | Compare against the Astropy-derived reference and open optional Aladin context. |

Keep a release check result for each row with the fixture or live source, the steps taken, and the observed result. Record three performance cases for the same request. The first uses an empty cache, the second reuses input crops, and the third reuses completed frames. Capture the image transfer separately from metadata and viewer assets. Treat the three-second preset and ten-second initial live comparison as performance targets to verify on a stated connection. The full live stack can take longer. Explain the measured bottleneck when a target is missed.

## Sources for implementation

- Archive collection names, access patterns and cloud locations. [IRSA SPHEREx data access](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/) · [IRSA cloud data access](https://irsa.ipac.caltech.edu/cloud_access/#spherex)
- SIA2 query syntax and supported response types. [IRSA SIA2 guide](https://irsa.ipac.caltech.edu/ibe/sia.html) · [IVOA SIA2 specification](https://www.ivoa.net/documents/SIA/20151223/)
- IMAGE, FLAGS, VARIANCE, PSF and spectral calibration semantics. [SPHEREx data products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/) · [FITS standard](https://fits.gsfc.nasa.gov/fits_standard.html)
- Single-range request behavior and response semantics. [Amazon S3 GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)
- Photometry reference and data acknowledgement. [IRSA SPHEREx spectrophotometry](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html) · [IRSA DR1 overview](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_dr1.html)
- Browser, toolchain and astronomy library references. [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers) · [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB) · [Rust wasm32 target](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html) · [Aladin Lite](https://cds-astro.github.io/aladin-lite/)
