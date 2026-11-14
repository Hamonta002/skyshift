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

The viewer accepts decimal degrees or complete sexagesimal RA and declination,
selectable detector band and field of view. The examples fill the search form;
only WISE 0855 is bundled offline. The live path queries IRSA for observations,
downloads a bounded sample, and computes visit stacks locally. It includes
individual exposures, visual sum/difference, centre-wavelength filtering, a preliminary
spectrum, shareable coordinates, and JSON metadata export. Nominal channel centres
can be loaded from IRSA on demand; adjacent midpoints are only approximate boundaries. Optional Gaia DR3 and
CatWISE2020 catalogue overlays use read-only server queries. A flag decoder accepts
a numeric value supplied by the user. The optional flag inspector can also read a
3 × 3 FLAGS cutout for the first exposure in the current frame. It requires Astropy
on the server: `python -m pip install astropy`. It uses bounded byte ranges and
does not represent the quality of the entire stack. Add `embed=1` to the URL for compact display.

Observation searches are cached in server memory. Inputs and results are cached
in the browser where IndexedDB is available; the browser can continue without a
working persistent cache. Search collections and band ranges are configured in
`config/archive.json`. New releases require checking their product layout and
adding their collection names; this does not change the numerical kernel.

## Build the other offline examples

On a machine with working access to IRSA and the SPHEREx S3 bucket, run:

```sh
npm run build:examples
npm run build
```

You can provide a target ID (for example, `npm run build:examples -- barnard`)
to fetch only one. If live search fails, the command can use the recorded coverage
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

**This is not yet a release-ready implementation.** The live IRSA/S3 integration,
real browser interaction, persistent-cache reload, and the four other target
image sequences have not been verified here. There are no bundled image sequences
for those four targets yet. The wavelength filter selects exposure bandpasses at the field centre; it is
not a time-resolved 102-channel calibrated cube. Catalogue routes and overlays have offline
fixture tests but have not been verified against the live services. The new FLAGS reader has not yet been validated against a real compressed product.
Calibrated uncertainty and scientifically matched photometry are not implemented. The spectrum is approximate, uses uncorrected aperture flux and
has not been validated as a scientific measurement. Broad-band sums and
differences are visual diagnostics: wavelength, PSF, quality flags and
uncertainty are not matched or propagated. Do not use them for scientific claims.

SPHEREx data are provided by NASA/IPAC Infrared Science Archive. Cite the DR1
spectral images using DOI [10.26131/IRSA678](https://doi.org/10.26131/IRSA678);
the nominal channel centres are published with the DR1 all-sky cube
([10.26131/IRSA679](https://doi.org/10.26131/IRSA679)). The bundled
products are identified in `reference/fixtures/wise0855_d6.manifest.json`.
