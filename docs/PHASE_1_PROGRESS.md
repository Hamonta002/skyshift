# Phase 1 Progress Report — Bug Fixes & Project Stability

**Branch:** `fix/phase-1-stability` (local only; unpushed)  
**Scope:** Existing Phase 1 bug fixes and stability only (no Phase 2 features).  
**Last Updated:** 2026-11-14

## Summary

- **Phase 1 Bug Fixes Addressed:** 9 / 9
- **Verification Coverage:** Code and offline/mocked test suite built and verified under TypeScript-only build on Windows (`rustc`/`clang` unavailable on host; Rust/WASM engine-switch sub-check skipped; live IRSA/S3 archive queries not run offline).
- **Overall Phase 1 Completion:** ~95% implemented and locally verified (remaining 5%: environment-dependent verification of Rust/WASM kernel compilation + live browser/network pass against IRSA/S3 to regenerate `reference/fixtures/examples/rdra.json`).

---

## Bug-by-Bug Status

| # | Area | Status | Summary of Fix | Files Modified |
|---|---|---|---|---|
| 1 | Windows compatibility & cross-platform build/test | Complete (TS-only verified; WASM skipped on host without `rustc`/`clang`) | Replaced POSIX-only `python3` invocations with cross-platform `resolvePython()`; fixed Windows `pathname` leading-slash bug in `scripts/check-track.mjs` via `fileURLToPath`; added TypeScript-only fallback in `scripts/build.mjs`, `src/viewer.ts`, and `scripts/check-cache.mjs` when Rust/Clang compilers are absent; added `scripts/test.mjs` runner. | `package.json`, `scripts/build.mjs`, `scripts/test.mjs`, `scripts/quality.mjs`, `scripts/check-track.mjs`, `scripts/check-cache.mjs`, `scripts/check-features.mjs`, `src/viewer.ts` |
| 2 | Deep-field search & earlier 90-day navigation | Complete in code + unit/mock tests (checked-in `rdra.json` fixture requires live IRSA/S3 to regenerate) | Updated `searchObservations()` in `scripts/observations.mjs` to step backwards in 90-day slices when recent `_deep` slices return zero detector matches so archival deep fields (e.g. R Draconis) are not omitted; added `#earlier-window` navigation button (`Earlier 90 days`) in `src/index.html` and `src/viewer.ts`. | `scripts/observations.mjs`, `src/index.html`, `src/viewer.ts`, `scripts/check-archive.mjs` |
| 3 | Search submission when target name unchanged | Complete | Added `SkyShift.searchOptionsDiffer()` and tracked `loadedOptions` in `src/viewer.ts` so submitting `#search` with unchanged target text still executes a live archive search whenever Band, FOV, or dates changed (and uses selected `bandSelect.value` rather than overriding with default target band). | `src/map.ts`, `src/viewer.ts`, `scripts/check-map.mjs` |
| 4 | Proper motion metadata & viewers | Complete | Extended `SkyShift.Target` with J2000 coordinates and `pmra`/`pmdec`/`epoch` from `reference/targets.py` for Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae, and R Draconis; centralized `propagateProperMotion()`, `targetPosition()`, and `findTargetAt()` in `src/coordinates.ts`; removed hardcoded WISE 0855-only checks in `src/viewer.ts` (`drawMarkers`) and `src/spectrum.ts` (`quickSpectrum`). | `src/coordinates.ts`, `src/catalogue.ts`, `src/spectrum.ts`, `src/viewer.ts`, `scripts/check-features.mjs` |
| 5 | Colour composite consistency | Complete | Extracted `SkyShift.searchTimeBounds()` and updated `loadColour()` in `src/viewer.ts` to reuse active `currentSelection` `from`/`to`/`asof` bounds, active FOV (`currentSelection?.fov ?? Number(fovSelect.value)`), and active `loadedFrameMode` (`"visits"` or `"exposures"`). | `src/map.ts`, `src/viewer.ts`, `scripts/check-map.mjs` |
| 6 | Live fixture visit limits at 20′ FOV | Complete | Replaced the hard error when `visits.length > maximum` in `SkyShift.makeLiveFixture()` with deterministic visit sampling within the 32 MB budget while preserving the oldest and newest visits. | `src/archive.ts`, `scripts/check-archive.mjs` |
| 7 | `WCS-WAVE` tail request caching | Complete | Added parsed `WCS-WAVE` grid caching (`waveCache`) and in-flight deduplication (`waveInflight`) keyed by release/detector (fallback `productKey`) in `src/archive.ts`, cleared by `clearBrowserCaches()`. | `src/archive.ts`, `scripts/check-archive.mjs` |
| 8 | URL wavelength restoration & state preservation | Complete | Parsed `waveMin`/`waveMax` before initial `load()` for both bundled and shared-coordinate startup paths in `src/viewer.ts`, eliminating the duplicate worker `load()` and preserving `frame`, `a`, and `b` even when `asof` is omitted. | `src/map.ts`, `src/viewer.ts`, `scripts/check-map.mjs` |
| 9 | Resource & HTTP handling | Complete | Revoked prior `#spectrum-download` Blob URLs before reuse, on field reset, and on `pagehide`; implemented `parseRetryAfterMs()` + shared `fetchRangeResponse()` honoring `Retry-After` on HTTP 429/503; added `User-Agent` header in Node `scripts/observations.mjs` requests. | `src/viewer.ts`, `src/archive.ts`, `scripts/observations.mjs`, `scripts/check-archive.mjs` |

## Open Items & Blockers for Full Release Sign-off

1. **Rust/Clang Toolchain (`rustc` / `clang` missing on current Windows host):** `dist/kernel.wasm` was not compiled here; cross-engine parity (`rust` vs `typescript`) and WASM binary output must be run on a host with `rustc` (`wasm32-unknown-unknown` target) or `rustc` + `clang`.
2. **Offline Example Bundle Regeneration:** `reference/fixtures/examples/rdra.json` currently reflects the pre-fix offline snapshot (`3` dates, `36` shallow exposures from `dr1`/`qr3`). Running `npm run build:examples -- rdra` on a machine with IRSA + S3 access will update the bundled JSON with deep-field coverage.
3. **Interactive Browser Smoke Test:** UI interactions (`#earlier-window` click, canvas markers, URL reload with `?waveMin=&waveMax=&frame=&a=&b=`, Blob URL revocation in DOM) were verified via TypeScript compilation and unit/logic tests; end-to-end headless browser UI execution was not automated in this phase.

