# SkyShift — Phase 2 Progress Report

**Branch:** `feat/phase-2-completion` (branched locally from `fix/phase-1-stability` at `84168bb`)  
**Overall Phase 2 Completion:** **100% (6 / 6 tasks complete)**  
**Git Policy:** Branch `feat/phase-2-completion` pushed to `origin` at the user's explicit request; no merges or pull requests performed.

---

## Summary of Phase 2 Tasks

| Task ID | Task Name | Status | Changed Files | Verification Script(s) |
| :--- | :--- | :--- | :--- | :--- |
| **P2-01** | Advanced Spectrum Analysis | **Complete** | `src/spectrum.ts`, `src/viewer.ts`, `src/index.html`, `scripts/check-features.mjs` | `scripts/check-features.mjs` |
| **P2-02** | Light Curve Improvement | **Complete** | `src/track.ts`, `src/catalogue.ts`, `src/viewer.ts`, `scripts/check-track.mjs` | `scripts/check-track.mjs` |
| **P2-03** | Worker Processing & Persistent Cache | **Complete** | `src/archive.ts`, `src/science.ts`, `src/worker.ts`, `src/viewer.ts`, `src/index.html`, `scripts/build.mjs`, `scripts/check-cache.mjs`, `scripts/check-archive.mjs` | `scripts/check-cache.mjs`, `scripts/check-archive.mjs` |
| **P2-04** | Catalogue Overlay Improvement | **Complete** | `scripts/catalogue.mjs`, `src/catalogue.ts`, `src/viewer.ts`, `scripts/check-features.mjs` | `scripts/check-features.mjs` |
| **P2-05** | Quality Flags & Contamination Metadata | **Complete** | `scripts/read-flags.py`, `src/viewer.ts`, `src/index.html`, `scripts/check-flag-reader.py` | `scripts/check-flag-reader.py`, `scripts/check-features.mjs` |
| **P2-06** | Playback and UX Polish | **Complete** | `src/archive.ts`, `src/index.html`, `src/style.css`, `src/viewer.ts`, `scripts/check-archive.mjs` | `scripts/check-archive.mjs` |

---

## Detailed Task Breakdown

### P2-01: Advanced Spectrum Analysis (`Complete`)
- **What was implemented:**
  - Added `SkyShift.resolveSpectrumTarget(fixture, currentTargetId, tracked, selected)` in `src/spectrum.ts` so spectrum extraction measures at the active `tracked` source (using Gaia/SIMBAD or fitted proper motion), the `selected` sky position / catalogue marker, or the active target / field centre.
  - Updated `SkyShift.quickSpectrum()` in `src/spectrum.ts` to match `reference/measure_frames.py`:
    - Propagates source coordinates to each exposure's `MJD` via `targetPosition`.
    - Computes exact median sky background (`8 < r < 14` px, `>= 30` finite pixels) and `1.4826 * MAD` background noise.
    - Runs 8-iteration flux-weighted centroiding (`r <= 2.5` px), adopting the refined centroid when `snr >= 5` and shift `<= 2.0` px.
    - Falls back to `3–6` px PSF wing/ring photometry (`mode: "ring"`, `saturated: true`) when the `r <= 2.5` px core contains `NaN` pixels and `wingValid > 0.7 * wingTotal`.
  - Added `SkyShift.compareSpectrumVisits(points, dates)` in `src/spectrum.ts` to compute matched-wavelength median fluxes across 3 wavelength quantile bins and report `medianDeltaMag` and `maxDeltaMag`.
  - Updated `#spectrum` in `src/viewer.ts` and `src/index.html` to render a HiDPI (`devicePixelRatio`-scaled) visit-coloured spectrum chart with visit legend, error bars, hollow ring markers for saturated points, `#spectrum-comparison` summary text, and expanded CSV export (`flux_err_jy,visit_index,visit_date,mjd,photometry_mode,saturated`).

### P2-02: Light Curve Improvement (`Complete`)
- **What was implemented:**
  - Enhanced `SkyShift.trackSource` in `src/track.ts` with optional `motionHint` and automatic MJD-based proper-motion / two-visit linear velocity extrapolation when stepping across visits where inter-visit motion exceeds the `3.5` px static search radius.
  - Updated `identifyTracked` in `src/viewer.ts` to re-run `trackSource` with catalogue proper motion (`gaia` / `simbad`) when initial unseeded tracking missed visits on a fast-moving star.
  - Widened `SkyShift.fieldPixel` and `SkyShift.cataloguePixel` in `src/catalogue.ts` to accept `FieldGeometry`.
  - Upgraded `drawLightCurve()` in `src/viewer.ts` to use `setupHiDpiCanvas`, plot horizontal positions by actual MJD/UTC observation times (`Δt` baseline in days and UTC date labels), connect consecutive detections, draw vertical error bars, draw upward lower-limit arrows on saturated points, and highlight the currently active `frame` with a `#f3c97a` ring.

### P2-03: Worker Processing and Persistent Cache (`Complete`)
- **What was implemented:**
  - Added persistent IndexedDB crop caching (`skyshift-crops`, 48 MB LRU budget, 14-day TTL) and concurrent in-flight crop request deduplication (`cropInflight` Map) in `src/archive.ts`.
  - Added `SkyShift.cacheDiagnostics()` in `src/archive.ts` and `SkyShift.comparisonCacheDiagnostics()` in `src/worker.ts`, and wired `updateCacheDiagnostics()` in `src/viewer.ts` to display live cache usage (`#cache-status`) in Diagnostics.
  - Updated `SkyShift.processSequence` (`src/science.ts`), `SkyShift.runRequest` (`src/worker.ts`), and `SkyShift.installWorker` (`src/worker.ts`) to emit progressive `{ type: "frame" }` messages as each visit/exposure is aligned and stacked, and to support worker-side live archive fixture assembly (`liveFetch` / `fetchLiveInWorker`) with safe cancellation on `AbortSignal`.
  - Updated `scripts/build.mjs` so the worker bundle (`assets.worker` and `dist/worker.cjs`) includes `coordinates` and `archive`.

### P2-04: Catalogue Overlay Improvement (`Complete`)
- **What was implemented:**
  - Updated `scripts/catalogue.mjs` to sort Gaia DR3 queries by `ORDER BY phot_g_mean_mag ASC` (fetching `source_id,ra,dec,pmra,pmdec,phot_g_mean_mag,bp_rp,parallax`) and CatWISE2020 queries by `ORDER BY w1mpro ASC` (fetching `source_name,ra,dec,pmra,pmdec,w1mpro,w2mpro`), preventing bright stars and brown dwarfs from being arbitrarily truncated by `TOP 250`.
  - Converted CatWISE2020 `pmra`/`pmdec` from `arcsec/yr` to `mas/yr` (`pmScale: 1000`) at epoch `2015.4`, enabling proper-motion propagation for both Gaia DR3 (`2016.0`) and CatWISE2020 (`2015.4`).
  - Added `SkyShift.formatCatalogueSource` in `src/catalogue.ts` and `findCatalogueSourceAtScreen` in `src/viewer.ts` so clicking any visible Gaia or CatWISE marker on the map (or in `#catalogue-list`) displays its source ID, magnitude (`G` or `W1`), colour (`BP−RP` or `W1−W2`), proper motion, and parallax in the `#whats-here` card.

### P2-05: Quality Flags and Contamination Metadata (`Complete`)
- **What was implemented:**
  - Implemented a pure-Python standard-library FITS `FLAGS` cutout reader (`_read_flags_stdlib`) in `scripts/read-flags.py` supporting both uncompressed `IMAGE` HDUs (`BITPIX = 32`) and SPHEREx DR1 tile-compressed `BINTABLE` HDUs (`ZIMAGE = T`, `ZBITPIX = 32`, `GZIP_1`, `GZIP_2`, and 32-bit CFITSIO `RICE_1`), used automatically whenever `astropy` is not installed.
  - Returned detailed centre-pixel and `3 × 3` neighbourhood flag statistics (`center`, `combined`, `flaggedPixels`, `totalPixels`, `pixels`, `bytesRead`, `requests`).
  - Updated `#quality-fetch` in `src/viewer.ts` to inspect flags at `selected` -> `tracked` -> `field centre`, verify detector bounds (`0..2039`), and report stack exposure coverage alongside centre and `3 × 3` neighbourhood flag masks.

### P2-06: Playback and UX Polish (`Complete`)
- **What was implemented:**
  - Added playback speed selector `#speed` (`0.5×`, `1×`, `2×`) in `src/index.html`, `src/style.css`, and `src/viewer.ts`, dynamically scaling visit playback (`1700 / 850 / 425 ms`) and A/B blink (`1000 / 500 / 250 ms`).
  - Added `SkyShift.estimateDownloadBytes(observations, fov)` in `src/archive.ts` and wired `#preflight-estimate` in `#search-options` plus live download byte estimates in `search()`.
  - Added `SkyShift.frameWavelengthSpan(fixture, frame, frameMode, band)` in `src/archive.ts` and displayed wavelength spans (`min–max μm`) in the timeline observation readout and frame inspector (`#inspect-frame`).
  - Added collapsible right-side **Movers & Changes panel** (`#movers-panel`) with filter tabs (`All`, `Movers`, `Brightness`), candidate list with astronomical target names, shift/magnitude delta, and 1-click tracking.
  - Added canvas **Focus Square (Target Reticle)** with 5′/10′/20′ corner brackets, center crosshair, FOV badge, coordinate readout, and dashed tether to field center.
  - Added **Map Locator HUD** (`#map-locator`) displaying distance/bearing offset from field center (e.g. `4.2′ SW of WISE 0855`) and `Back to field` shortcut.
  - Added prominent **Target Name Badges** (`[ 1 · WISE 0855 ]`, `[ WISE 0855 ]`) directly on canvas above tracked and detected moving stars, resolving names from challenge targets, SIMBAD, Gaia DR3, and SkyBoT.


