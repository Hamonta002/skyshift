# SkyShift

SkyShift is a browser-first SPHEREx explorer under development. The bundled
WISE 0855 demonstration uses 45 real DR1 exposures in three visits. Rust compiled
to WebAssembly aligns and stacks the images in a worker; a TypeScript engine is
available for comparison.

## Run locally

Requirements: Node.js, and optionally Rust with the `wasm32-unknown-unknown` target
(or Clang with WebAssembly support) for the WebAssembly kernel; if the Rust/Clang
toolchain is unavailable, `npm run build` falls back to building the TypeScript-only
bundle without `kernel.wasm`. Install the dependencies, build, and start the local web server:

```sh
npm install
npm run build
npm run dev
```

Open <http://127.0.0.1:4173/>. The server provides `/api/observations`; a
static-only host can show the bundled example but cannot perform live searches.
The browser also needs direct cross-origin range access to the public SPHEREx
S3 bucket for image pixels. Deploying this application publicly requires a host
that runs the search route and verification of cross-origin access.

The viewer is a full-screen sky map. It opens on WISE 0855 at 8 screen pixels per image pixel. Drag or use the arrow keys to pan, and scroll or pinch to zoom. As you pan away from the loaded stack, an on-screen map locator (`Inside field` / offset readout) and a highlighted target viewport reticle track where the view centre is focused relative to the loaded field; moving the map never replaces the loaded data until you trigger **Search this area** (or press `0` / **Back to field** to return). Click any point for its coordinates, pixel value, and quick actions, and press `?` for keyboard shortcuts. The search box takes an example name, or RA and Dec. It accepts decimal degrees or complete sexagesimal RA and declination, with the detector band, field of view and dates under search options. The example chips open a bundled example directly; an example that is not bundled in the build is fetched through the live search. Only WISE 0855 is bundled offline. The live path queries IRSA for observations, downloads a bounded sample, and computes visit stacks locally. It includes individual exposures, visual sum/difference, centre-wavelength filtering, a preliminary spectrum, comparison star differential analysis, shareable coordinates, and JSON metadata export. Nominal channel centres can be loaded from IRSA on demand; adjacent midpoints are only approximate boundaries. Optional Gaia DR3 and CatWISE2020 catalogue overlays use read-only server queries. A flag decoder accepts a numeric value supplied by the user. The optional flag inspector can also read a 3 × 3 FLAGS cutout for the first exposure in the current frame (or at comparison apertures). It requires Astropy on the server: `python -m pip install astropy`. It uses bounded byte ranges and does not represent the quality of the entire stack. Add `embed=1` to the URL for compact display.

Observation searches are cached in server memory. Inputs and results are cached
in the browser where IndexedDB is available; the browser can continue without a
working persistent cache. Search collections and band ranges are configured in
`config/archive.json`. New releases require checking their product layout and
adding their collection names; this does not change the numerical kernel.

## Discover and identify

- **Find movers** (or `F`) looks for the signature of a moving source in B − A:
  a fading spot next to a brightening one, and populates the **Movers & changes**
  panel with `All`, `Moved`, and `Brightness` filters. Detected candidates are
  matched against proper-motion-propagated catalogue names when available, and
  you can step through them directly on the map.
- **Track & identify** (click a source, or `T`) measures the source's position
  and brightness in every visit, fits its motion in arcsec per year, and draws
  its path. It then checks SIMBAD (with the Harvard mirror as a fallback), Gaia
  DR3 and IMCCE SkyBoT, after moving catalogue positions to the date of the
  image using their proper motions. The verdict, such as "Brown Dwarf",
  "Mira Variable", "Known solar-system object" or "Unidentified moving source:
  candidate", lists what it was based on. Verdicts are rules of thumb, so
  confirm them with Blink. Saturated cores are located from their masked
  pixels, and their brightness is a lower limit.
- **Comparison star** (field panel -> **Comparison star**, or **Set target** /
  **Set reference** on the sky-position card) compares a target star against a
  reference star chosen from the sky map or Gaia DR3 / CatWISE2020 overlays.
  It uses proper-motion-aware aperture photometry (falling back to 3–6 px ring
  estimates on saturated cores), excludes unmatched wavelengths, computes
  target/reference flux ratios and differential variation (Δmag) across visits
  and matched wavelength bins, flags unsuitable or contaminated references
  (including optional server-side SPHEREx FLAGS checks), plots a three-panel
  comparison chart, and exports results as CSV.
- **Reports**: *Copy report link* reopens the view with the object tracked
  (`mark=ra,dec`). *Download report* saves the positions, motion, brightness
  and catalogue matches as JSON.
- **Colour composite** (place panel) fetches two more detector bands and shows
  three bands stacked over all visits, with the longest wavelength in red. Each
  extra band is about 20–25 MB.

Brightness changes between visits can be partly spectral, because SPHEREx
samples different wavelengths within a band on each visit. Identification and
colour composites need the server routes; the bundled examples, playback,
Find movers and tracking work offline.

## Deploy

The `Dockerfile` builds the viewer, including the Rust/WebAssembly kernel, and
serves it with all routes on port 8080:

```sh
podman build -t skyshift .   # or docker build
podman run -p 8080:8080 skyshift
```

Any container host can run it (for example Render, Fly.io, Railway or Cloud
Run). `HOST` and `PORT` select the listening address; the default is
`127.0.0.1:4173` for local use. The browser reads image pixels directly from
the public SPHEREx S3 bucket, which allows cross-origin range requests.

## Build the other offline examples

On a machine with working access to IRSA and the SPHEREx S3 bucket, run:

```sh
npm run build:examples
npm run build
```

All four are bundled in this repository (built 2026-11-14). You can provide a
target ID (for example, `npm run build:examples -- barnard`) to rebuild only one. If live search fails, the command can use the recorded coverage
tables in `reference/_work/coverage`; it still needs S3 to download image pixels. The command saves real, sampled products and provenance under
`reference/fixtures/examples/`; it reports any failed target instead of fabricating
observations. Selection of these optional example bundles is supported by the app.
Dense fields may have truncated metadata; check collection status in the bundle.

## Verification

```sh
npm test
npm run bench
```

`npm test` runs the full suite (`build`, `check-cache`, `check-archive`,
`check-features`, `check-map`, `check-track`, `check-identify`,
`check-comparison`, and `check-flag-reader`), including simulated cache checks,
synthetic FITS/VOTable and coordinate checks, and differential photometry checks
validated against `reference/measure_frames.py` (without `dist/kernel.wasm`,
the WASM engine-switch cache step is skipped). `npm run bench` compares
Rust/WASM and TypeScript on the pinned real fixture and on synthetic workloads.
Fixture inputs and source metadata are in `reference/fixtures/`.

**This is not yet a release-ready implementation.** Verified on 2026-11-14 in
headless Chromium: the live IRSA search, S3 range reads and alignment for all five
targets; Find movers, Track & identify (live SIMBAD, Gaia DR3 and SkyBoT) and the
colour composite. Still unverified: physical phone and desktop browsers,
persistent-cache reload, and a public deployment (the container image builds
locally). The wavelength filter selects exposure bandpasses at the field centre; it is
not a time-resolved 102-channel calibrated cube. The Gaia catalogue route answers live;
the overlay drawing and CatWISE are tested only offline. The FLAGS reader has not yet been validated against a real compressed product.
Calibrated uncertainty and scientifically matched photometry are not implemented. The spectrum is approximate, uses uncorrected aperture flux and
has not been validated as a scientific measurement. Broad-band sums and
differences are visual diagnostics: wavelength, PSF, quality flags and
uncertainty are not matched or propagated. Do not use them for scientific claims.

SPHEREx data are provided by NASA/IPAC Infrared Science Archive. Cite the DR1
spectral images using DOI [10.26131/IRSA678](https://doi.org/10.26131/IRSA678);
the nominal channel centres are published with the DR1 all-sky cube
([10.26131/IRSA679](https://doi.org/10.26131/IRSA679)). The bundled
products are identified in `reference/fixtures/wise0855_d6.manifest.json`.
