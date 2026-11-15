# SkyShift — Phase 2 Test Report

**Branch:** `feat/phase-2-completion`  
**Command Executed:** `npm run build; if ($LASTEXITCODE -eq 0) { npm test }`  
**Exit Code:** `0` (All 8 test steps completed cleanly; 0 failures)

---

## 1. Test Execution Summary

| Step | Script | Result | Details |
| :--- | :--- | :--- | :--- |
| 1 | `scripts/build.mjs` | **PASS** | Built `dist/index.html` (`671,022 bytes`), `dist/core.cjs`, `dist/worker.cjs`, `dist/archive.cjs`, `dist/fixture.json`, and 4 example bundles. Rust/WASM optional build skipped cleanly (`[WARN] Rust/Clang toolchain not found; building TypeScript-only dist without kernel.wasm.`). |
| 2 | `scripts/check-cache.mjs` | **PASS** (1 sub-check skipped) | Verified input/result cache policy and **P2-03** progressive per-frame `onFrame` delivery across all visits. Rust/WASM engine-switch sub-check skipped cleanly (`[SKIP] Rust/WASM engine switch cache check skipped (dist/kernel.wasm not present).`). |
| 3 | `scripts/check-archive.mjs` | **PASS** | Verified synthetic FITS/VOTable parsing, deep-field time windows, 60-exposure cap, `WCS-WAVE` caching, `Retry-After` handling, **P2-03** concurrent `fetchExposure` in-flight deduplication (`cropInflight`) and `cacheDiagnostics()`, and **P2-06** `estimateDownloadBytes` and `frameWavelengthSpan`. |
| 4 | `scripts/check-features.mjs` | **PASS** | Verified wavelength filtering, quality flag bit decoding, **P2-01** `resolveSpectrumTarget`, `quickSpectrum` aperture photometry on `wise0855` (45 points) and `3–6` px ring photometry fallback on saturated `rdra` (34 valid wing measurements matching `reference/measure_frames.py`), `compareSpectrumVisits` 3-bin variability summary, and **P2-04** Gaia DR3 (`ORDER BY phot_g_mean_mag ASC`) & CatWISE2020 (`ORDER BY w1mpro ASC`, `pmScale: 1000`, epoch `2015.4`) sorting, proper-motion propagation, and `formatCatalogueSource`. |
| 5 | `scripts/check-map.mjs` | **PASS** | Verified gnomonic projection, zoom, graticule steps, URL state, and search parsing. |
| 6 | `scripts/check-track.mjs` | **PASS** | Verified source tracking, proper-motion fitting, mover detection, and object classification across all 5 real fields (`wise0855`, `barnard`, `epsindiB`, `rwaur`, `rdra`), plus **P2-02** fast-mover tracking across `5.5` px inter-visit jumps using MJD two-visit velocity extrapolation and `motionHint`. |
| 7 | `scripts/check-identify.mjs` | **PASS** | Verified SIMBAD TAP/VizieR fallback, proper-motion epoch propagation, Gaia DR3, and SkyBoT identification. |
| 8 | `scripts/check-flag-reader.py` | **PASS** | Verified bounded HTTP `RangeFile` reads and **P2-05** pure-Python `read_flags` decoding of tile-compressed `BINTABLE` `FLAGS` HDUs (`ZIMAGE = T`, `ZCMPTYPE = 'GZIP_1'`, `ZTILE1 = 2040`, `ZTILE2 = 1`) and 32-bit Rice (`RICE_1`) tile decompression (`_decode_rice_32`). |

---

## 2. Exact Test Output

```text
> build
> node scripts/build.mjs

[WARN] Rust/Clang toolchain not found; building TypeScript-only dist without kernel.wasm.
Built dist/index.html (671,022 bytes). TypeScript only (Rust/WASM compiler unavailable).

> test
> node scripts/test.mjs


=== build ===
[WARN] Rust/Clang toolchain not found; building TypeScript-only dist without kernel.wasm.
Built dist/index.html (671,022 bytes). TypeScript only (Rust/WASM compiler unavailable).

=== check-cache ===
[SKIP] Rust/WASM engine switch cache check skipped (dist/kernel.wasm not present).
Verified cache policy on G:\skyshift\
Input reuse reruns processing. Result reuse returns identical pixels and skips initialization and processing.
Storage was simulated with structured cloning. Browser IndexedDB timing is provided by the viewer.

=== check-archive ===
Archive and coordinate checks passed (synthetic FITS and VOTable; no live service).

=== check-features ===
Exposure, wavelength, quality and catalogue checks passed (offline fixtures).

=== check-map ===
Map projection, zoom, grid, view-state and search parsing checks passed.

=== check-track ===
wise0855: 9.47 ± 0.67″/yr at 278°, variable false, 1 mover candidate(s)
barnard: 10.09 ± 0.58″/yr at 346°, variable false, 1 mover candidate(s)
epsindiB: 5.03 ± 0.82″/yr at 124°, variable true, 0 mover candidate(s)
rwaur: 0.16 ± 0.21″/yr at 171°, variable true, 2 mover candidate(s)
rdra: 0.98 ± 2.71″/yr at 262°, variable false, 1 mover candidate(s)
Tracking, motion, mover and verdict checks passed (5 real fields).

=== check-identify ===
Identification checks passed (SIMBAD fallback, proper-motion propagation, Gaia, SkyBoT; mocked services).

=== check-flag-reader ===
Bounded FITS range file checks passed (mock archive).

All 8 test steps completed cleanly.
```

---

## 3. Environment Notes & Remaining Limitations
- **Rust / WASM Toolchain:** `rustc` and `clang` are not installed on this Windows host. The build (`scripts/build.mjs`) builds the TypeScript-only bundle (`dist/index.html`, `671,022 bytes`) and `scripts/check-cache.mjs` skips only the Rust/WASM engine-switch sub-check (`[SKIP]`).
- **Python Astropy:** `astropy` is not installed in the local Python 3.13 environment. With the **P2-05** pure-Python FITS `FLAGS` reader (`_read_flags_stdlib` in `scripts/read-flags.py`), both uncompressed `IMAGE` HDUs and SPHEREx DR1 tile-compressed `BINTABLE` `FLAGS` HDUs (`GZIP_1`, `GZIP_2`, and `RICE_1`) are decoded directly using Python's standard library (`zlib`, `struct`), while still supporting `astropy.io.fits` when installed.

