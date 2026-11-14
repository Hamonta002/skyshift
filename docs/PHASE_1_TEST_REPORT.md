# Phase 1 Test & Verification Report

**Branch:** `fix/phase-1-stability`  
**Environment:** Windows (Node.js `v22.17.0`, npm `10.9.2`, Python `3.13.3` via `python`, TypeScript `6.0.3`; `rustc` and `clang` not installed).  
**Command Executed:** `npm test` (runs `node scripts/test.mjs`)

## Test Suite Results (Post-Final Edit)

| Step | Script | Outcome | Scope & Notes |
|---|---|---|---|
| 1 | `scripts/build.mjs` | Passed (TS-only warning) | Compiled all 10 `src/*.ts` modules with strict diagnostics; emitted `dist/index.html` (`586,466 bytes`), `dist/core.cjs`, `dist/worker.cjs`, `dist/archive.cjs`, `dist/fixture.json`, `dist/build.json`. Emitted `[WARN] Rust/Clang toolchain not found; building TypeScript-only dist without kernel.wasm.` |
| 2 | `scripts/check-cache.mjs` | Passed (WASM sub-check skipped) | Verified cache miss -> inputs reuse -> results reuse and identical pixel comparison for TypeScript engine. Explicitly logged `[SKIP] Rust/WASM engine switch cache check skipped (dist/kernel.wasm not present).` |
| 3 | `scripts/check-archive.mjs` | Passed | Verified coordinate parsing, VOTable parsing, synthetic FITS range decoding, R Draconis `_deep` 90-day backward-stepping window search + narrow-window request count + `User-Agent` header check, 20′ FOV >14-visit even sampling preserving oldest & newest visits, `WCS-WAVE` lookup caching (`1` fetch across exposures on same detector/release, `2` across detectors), and `Retry-After` handling on HTTP 429/503 (`parseRetryAfterMs` + `fetchExposure` retries). (All network calls mocked.) |
| 4 | `scripts/check-features.mjs` | Passed | Verified `filterWavelength`, quality flag decoding, `combineFrames`, exposure mode (`45` frames), Gaia ADQL query construction, `resolvePython()`, nominal channel parsing, and added proper-motion checks (`TARGETS`, `targetPosition`, `findTargetAt`, `quickSpectrum` aperture photometry tracking Barnard's Star across epochs). |
| 5 | `scripts/check-map.mjs` | Passed | Verified tangent-plane projection, zooms, graticules, formatting, `at=` parsing, query parsing, `searchOptionsDiffer()`, `searchTimeBounds()`, and `parseWaveRange()`. |
| 6 | `scripts/check-track.mjs` | Passed | Verified Windows file URL loading (`fileURLToPath`) and ran tracking/motion/mover checks across all 5 real fields (`wise0855`, `barnard`, `epsindiB`, `rwaur`, `rdra`). |
| 7 | `scripts/check-identify.mjs` | Passed | Verified SIMBAD fallback, proper-motion propagation, Gaia DR3, and SkyBoT integration (mocked HTTP responses). |
| 8 | `scripts/check-flag-reader.py` | Passed | Verified bounded FITS byte-range flag reading via Python (`python` resolved on Windows). (Mock archive.) |

## Checks Not Executed in Full

- **Rust/WASM kernel compilation & parity (`kernel.rs` -> `kernel.wasm`):** Skipped due to missing `rustc` / `clang` toolchain on Windows host.
- **Live IRSA / S3 archive & browser UI integration:** Not run (no live network/browser harness executed against external archive endpoints).

