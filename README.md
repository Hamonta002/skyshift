# SkyShift

SkyShift is a browser-first SPHEREx explorer under development. The bundled
WISE 0855 demonstration uses 45 real DR1 exposures in three visits. Rust compiled
to WebAssembly aligns and stacks the images in a worker; a TypeScript engine is
available for comparison.

## Run locally

Requirements: Node.js, Rust, and either the `wasm32-unknown-unknown` Rust target
or Clang with WebAssembly support. Install the dependencies, build, and start
the local web server:

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

The viewer is a full-screen sky map. It opens on WISE 0855 at 8 screen pixels per image pixel. Drag to pan, and scroll or pinch to zoom. Click any point for its coordinates and pixel value. The `?` button opens a short guide with the keyboard shortcuts. On phones the timeline starts compact; its arrow shows the thumbnails and the A/B choices. Moving the map never replaces the loaded data; use **Search this area** to load a new field. The search box takes
the name of any star, galaxy or nebula (for example Betelgeuse or M42), or RA and Dec. Names are looked up on the
server through CDS Sesame and moved to the current date with their proper motion; SIMBAD supplies the object type
shown in the panel, and shared links keep the name. Coordinates may be decimal degrees or complete sexagesimal RA and declination,
with the field size and dates under search options; changing them and pressing Enter searches the current field again.
The infrared band is chosen in **Layers**: changing it reloads the field, and new searches use it. While a live search
runs, the map moves to the requested place and outlines it with the download progress. The example chips open a bundled example
directly, with a one-line hint on what to look for; an example that is not bundled in the build is fetched through
the live search. All five examples are bundled for offline use. The live path queries IRSA for observations,
downloads a bounded sample, and computes visit stacks locally. It includes
individual exposures, visual sum/difference, centre-wavelength filtering, a preliminary
spectrum, shareable coordinates, and JSON metadata export. Opening **Narrow wavelength** in the panel loads the
nominal channels of the current band from IRSA, and choosing one applies it; adjacent midpoints are only approximate
boundaries. Optional Gaia DR3 and
CatWISE2020 catalogue overlays use read-only server queries. A flag decoder accepts
a numeric value supplied by the user. The optional flag inspector can also read a
3 × 3 FLAGS cutout for the first exposure in the current frame. It requires Astropy
on the server: `python -m pip install astropy`. It uses bounded byte ranges and
does not represent the quality of the entire stack. Add `embed=1` to the URL for compact display.

Observation searches are cached in server memory. Inputs and results are cached
in the browser where IndexedDB is available; the browser can continue without a
working persistent cache. Search collections and band ranges are configured in
`config/archive.json`. New releases are also found automatically: every 12 hours the
server lists the top-level folders of the public SPHEREx bucket, and a release newer
than the configured ones of its kind (for example `qr4/` after `qr3`, or `dr2/`) that
has the usual `level2/` image folder is searched as well. Its failures never block a
search. The panel shows the newest image, when the archive was checked and which
releases answered; a saved example quietly asks the archive whether newer images
exist and offers to load them.

## Discover and identify

- **Find movers** (or `F`) looks for the signature of a moving source in B − A
  (**What changed**): a fading spot next to a brightening one. It runs on its
  own whenever A and B are set, and the button shows what it found; press it
  to step through the candidates. Sources that only changed brightness are
  listed separately. By default A and B are the two full visits furthest apart
  in time, so slow movers shift the most.
- **Track & identify** (click a source, or `T`) measures the source's position
  and brightness in every visit, fits its motion in arcsec per year, and draws
  its path. It then checks SIMBAD (with the Harvard mirror as a fallback), Gaia
  DR3 and IMCCE SkyBoT, after moving catalogue positions to the date of the
  image using their proper motions. The verdict, such as "Brown Dwarf",
  "Mira Variable", "Known solar-system object" or "Unidentified moving source:
  candidate", lists what it was based on. Verdicts are rules of thumb, so
  confirm them with Blink. Saturated cores are located from their masked
  pixels, and their brightness is a lower limit.
- **Reports**: *Share* copies a link that reopens the view with the object
  tracked (`mark=ra,dec`). *Download report* saves the positions, motion,
  brightness and catalogue matches as JSON.
- **Colour** (a switch in Layers; choose the bands in the panel) fetches two
  more detector bands and shows three bands stacked over all visits, with the
  longest wavelength in red. Each extra band is about 20–25 MB.

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

`npm test` includes simulated cache checks and synthetic FITS/VOTable and
coordinate checks. `npm run bench` compares Rust/WASM and TypeScript on the
pinned real fixture and on synthetic workloads. Fixture inputs and source
metadata are in `reference/fixtures/`. See `SPHEREx_Implementation_Plan.md`
for the full acceptance criteria.

**This is not yet a release-ready implementation.** Verified on 2026-11-14 in
headless Chromium: the live IRSA search, S3 range reads and alignment for all five
targets; Find movers, Track & identify (live SIMBAD, Gaia DR3 and SkyBoT) and the
colour composite. Still unverified: physical phone and desktop browsers,
persistent-cache reload, and a public deployment (the container image builds
locally). The wavelength filter selects exposure bandpasses at the field centre; it is
not a time-resolved 102-channel calibrated cube. The Gaia catalogue route answers live;
the overlay drawing and CatWISE are tested only offline. The FLAGS reader has not yet been validated against a real compressed product.
Engine, cache and benchmark controls are hidden unless the URL includes `debug=1`.
Calibrated uncertainty and scientifically matched photometry are not implemented. The spectrum is approximate, uses uncorrected aperture flux and
has not been validated as a scientific measurement. Broad-band sums and
differences are visual diagnostics: wavelength, PSF, quality flags and
uncertainty are not matched or propagated. Do not use them for scientific claims.

SPHEREx data are provided by NASA/IPAC Infrared Science Archive. Cite the DR1
spectral images using DOI [10.26131/IRSA678](https://doi.org/10.26131/IRSA678);
the nominal channel centres are published with the DR1 all-sky cube
([10.26131/IRSA679](https://doi.org/10.26131/IRSA679)). The bundled
products are identified in `reference/fixtures/wise0855_d6.manifest.json`.
