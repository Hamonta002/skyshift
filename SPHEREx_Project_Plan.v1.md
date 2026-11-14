# SkyShift — SPHEREx Project Plan

Updated 14 November 2026. Working name only.

Project root: `/home/crow/planet`. Keep project source, configuration and implementation work in this directory.

Agreed architecture: **browser-first processing, aggressive caching, and optional server computation for larger jobs.** Interface direction: **minimalist, with the sky viewer as the main surface.** All eight challenge considerations remain in the full project scope.

Build a public website where someone enters sky coordinates, plays real observations in date order, and marks a possible moving or changing object. The first milestone is two scientifically comparable images blinking correctly.

Planning assumption: a small student team. The original 10–15 focused development days remains a provisional MVP budget; re-estimate after the browser data-access and numerical-port feasibility checks. Full spectrum extraction and advanced mosaics are later milestones. Archive documentation has been checked, but the five target fields and browser performance have not been validated.

## 1. Establish the data foundation first

The current archive recommends DR1 and QR3, which supersede QR2. DR1 covers Surveys 1 and 2; QR3 covers Surveys 3 and 4 as observations are released. Keep releases configurable and record their processing versions. [1]

Use time-stamped Level 2 spectral images for the movie. Treat the DR1 all-sky spectral cube as a separate context product: stepping through its wavelength planes does not represent time. SPHEREx measures different wavelengths at different detector positions, so an individual exposure is not a simultaneous 102-channel image cube. [2]

IRSA provides SIA2 discovery by sky region, wavelength and time, plus spatial cutouts. Query metadata first and download only needed patches. The browser uses a TypeScript archive adapter; Python/Astroquery provides a reference workflow for validation. Direct browser access must be tested against actual metadata, cutout and calibration responses from the deployed origin. Current CORS permissions have not been verified; use a narrow proxy if needed. [3][12]

First deliverable: a coverage report for the five required targets. Record source identity, coordinate reference epoch, date range, usable frames per wavelength interval, quality issues, and likely comparison pairs. Do not assume each target has a usable detection in each band.

## 2. Define the first public version

| Priority | Capability | Completion condition |
|---|---|---|
| Required | Coordinate search | Accept explicit decimal-degree or sexagesimal input, validate it, and search a supported field size. |
| Required | Example targets | Provide Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae and R Draconis as one-click examples. |
| Required | Time viewer | Play, pause, step backward/forward, adjust speed, and inspect observation dates. |
| Required | Fair comparison | Keep a fixed sky grid, comparable wavelengths and one shared brightness stretch. |
| Required | Wavelength and field controls | Select an available wavelength interval and a field size; clearly show unavailable combinations. |
| Required | Provenance and quality | Show source archive, observation dates, wavelength coverage and relevant quality warnings. |
| Required | Shareable view | A URL restores coordinates, field size, wavelength, epoch selection and display settings; an embed page provides the compact viewer. |
| Required | Local processing and reuse | Suitable uncached requests run in a browser worker; repeated and nearby requests reuse compatible cached inputs and outputs. |
| Required | Public usability | Work without login; support keyboard controls, mobile screens, visible focus and paused playback initially. |
| Next | Evidence card | Mark a candidate and export its coordinates, comparison frames, dates and reproducible settings. |
| Next | Difference and stack views | Enable only after registration, bandpass and uncertainty checks pass. |
| Later | Catalog overlays and measurements | Add Gaia DR3, WISE context, light curves and spectra. |

Use a 5-arcminute starting field and offer 10 and 20 arcminutes. These are proposed limits to benchmark, not archive limits. Larger requests should show estimated work before processing.

### Minimalist interface

The sky is the main surface. Use a neutral charcoal shell, readable off-white text, one restrained accent for interactive controls, one sans-serif typeface, and generous spacing. Keep the visual hierarchy clear with size and spacing. Use colour sparingly; pair quality warnings with text.

| Area | Visible by default |
|---|---|
| Top bar | Small project name, compact labelled coordinate search, Examples and Share |
| Main canvas | Large sky image, selection marker when relevant, current observation date and wavelength |
| Bottom strip | Previous, play/pause, next, timeline and a compact speed selector |
| View controls | Small Band and Field of view selectors, plus a labelled Tools button |
| Status | A brief progress message or a meaningful data-quality warning when needed |

Keep the starting screen compact: a short instruction and the five example targets inside the viewer's empty state. Once data loads, collapse examples into the Examples menu. Keep the selected coordinates discoverable and make coordinate units explicit.

Tools opens a single drawer with clearly labelled controls for stacking, subtraction, spectra, catalog overlays, metadata and export as each capability is implemented. Keep less-used settings inside that drawer. Preserve all eight challenge capabilities while showing only the controls needed for the current action.

A selected source opens a small contextual panel. Show relevant quality warnings beside the image even when detailed metadata is collapsed. Use plain status text such as “Loading 3 of 8 images”; keep cache, WASM and pipeline internals in diagnostics.

The page opens directly into the viewer. Avoid a separate marketing screen, decorative cards, unrelated metrics and persistent sidebars. Motion serves playback and selection; playback starts paused.

On mobile, wrap the search controls cleanly and turn the tool drawer into a bottom sheet. Keep controls large enough to tap, provide accessible names for icons and visible keyboard focus, and preserve the sky's usable area. Use keyboard shortcuts as an additional convenience, with labelled buttons still available.

Validate the layout at phone and desktop widths. A first-time visitor should be able to choose an example, play the sequence and share it without opening advanced settings. Overlays and panels must remain dismissible so they do not obscure a candidate.

## 3. Process in the browser and reuse work across visitors

The browser is the default execution environment for supported numerical operations. Scientific correctness depends on the algorithm, calibration, precision and tests, wherever the calculation runs. A server is an optional place to run the same task when local execution is unsuitable.

| Component | Proposed choice | Role |
|---|---|---|
| Website | Next.js, TypeScript, Tailwind; static delivery where practical | Search, controls, sharing and responsive layout. |
| Sky viewer | Aladin Lite plus the time-comparison interface | Navigation, rendering and catalog overlays. |
| Local numerical core | Rust compiled to WebAssembly in a dedicated Web Worker | Validated reprojection, matching, stacking and extraction routines, added incrementally. |
| Reference pipeline | Python, Astropy, Astroquery, NumPy, reproject | Produce trusted fixtures and verify browser results. |
| Archive adapter | TypeScript using documented archive endpoints | Discover observations and retrieve selected inputs; use a proxy only when needed. |
| Browser persistence | Cache Storage and IndexedDB; OPFS only if benchmarks justify it | Keep downloaded tiles, derived arrays, manifests and resumable work. |
| Shared data | Object storage and CDN | Distribute public inputs and trusted prepared results across visitors. |
| Optional service | Small API/gateway and queued compute worker | Access mediation, request deduplication, durable large jobs and shared refresh tasks. |

Aladin Lite already has a Rust/WebAssembly core and WebGL2 renderer. Reuse it rather than rebuilding its sky-navigation machinery. Its rendering capabilities do not by themselves validate SPHEREx photometry. The Python reproject package remains a useful numerical reference. [4][5][13]

Execution routing:

1. Look for a compatible result in memory, browser storage and the shared cache.
2. If no result exists, retrieve only the required observations, tiles and calibration inputs.
3. Estimate the working set, including science arrays, variance, masks, wavelength maps and intermediate buffers. Use measured processing performance and conservative device budgets to choose a bounded local job.
4. Run supported operations in a Web Worker, exposing progress and cancellation. Work tile by tile; include adequate overlap for convolution and reprojection near tile boundaries.
5. Save reusable outputs and progress. If a job exceeds the local budget, offer smaller selections or optional remote processing. Preserve requested science settings unless the user chooses a change.

Workers keep processing off the interface thread. Transferable buffers can reduce copying, although transfers between JavaScript, WASM and graphics memory must be benchmarked separately. Begin with a single worker; shared-memory multithreading is optional because it needs cross-origin isolation and can complicate embedding. [14][15]

Design independent Rust numerical modules so supported routines can later be compiled for both browser and native execution. Verify dependency portability before promising that every existing astronomy library will compile to WASM. The optional backend may initially reuse the Python reference pipeline.

| Operation | Default execution | Alternative |
|---|---|---|
| Observation search and refresh on opening the app | Browser adapter | Shared metadata cache or small proxy |
| Release monitoring while nobody is browsing | Optional scheduled service | Refresh on the next visit |
| Small-region alignment and image-sharpness matching | Browser worker after validation | Compatible prepared result or remote job |
| Stacks, differences and detector summaries | Browser worker within measured limits | Remote processing for larger inputs |
| Mosaics | Incremental browser tiles | Durable remote job for very large fields |
| Spectra | Local extraction from selected data when supported | Optional queued extraction for extensive fitting |

Processing continues locally only while the browser permits it. Checkpoint work and handle tab closure, suspension or eviction. Optional remote jobs have persisted state and run outside the API request process. [6]

Cache identical scientific work independently of display choices: changing contrast, palette or playback speed should reuse the same numeric arrays. Section 8 defines the aggressive caching policy.

## 4. Implement a scientifically defensible image pipeline

1. **Normalize the request.** Convert coordinates to ICRS degrees. Record whether coordinates describe a fixed sky position or a named source at a known reference epoch. Validate RA wraparound, declination, field size and date limits.

2. **Discover images.** Query the configured DR1 and QR3 collections over the full requested footprint, not just the center. Read actual observation times and spectral coverage. Handle pagination or overflow and deduplicate repeated products by observation identity and processing version.

3. **Retrieve cutouts.** Request only needed spatial subsets. Preserve science pixels, masks, variance, coordinate metadata and wavelength information. Cache downloaded data so nearby or repeated requests do not keep fetching it. IRSA cutouts retain the relevant FITS structure and metadata. [7]

4. **Apply quality rules.** Decode the release's documented flags. Do not reject every nonzero flag: some bits describe context rather than unusable pixels. Propagate missing coverage as missing data, not black pixels. Record saturation and contamination.

5. **Match wavelength coverage.** Use per-pixel wavelength information, not merely the detector number or the wavelength at the image center. Begin with one shared wavelength interval and compare only the common valid footprint. If the overlap is inadequate, explain why a fair comparison cannot be made.

6. **Align the sky.** Reproject onto one celestial WCS grid with a fixed scale and orientation. Preserve the background reference frame so a moving target remains free to move. Check stationary field sources for residual registration error.

7. **Choose time bins carefully.** Initially show individual compatible observations. Later, combine exposures only within short, explicit epoch windows. Store each frame's start, end and representative time. Fast-moving-object mode must avoid long stacks that smear motion; do not reject a real transient merely because it appears in one epoch.

8. **Treat brightness consistently.** Apply the same documented background procedure and one shared display stretch across the sequence. Avoid automatic frame-by-frame rescaling when examining variability. Keep calibrated arrays separate from browser-rendered pixels.

9. **Produce reusable assets.** Cache calibrated numeric tiles, variance, coverage and quality masks, coordinate information, wavelength information and a versioned manifest. Derive lightweight display previews separately. Subtraction and photometry operate on numeric data, not stretched previews. Preload a bounded number of adjacent frames. Enlarging an image on screen does not gain telescope resolution.

10. **Preserve reproducibility.** Record source product identifiers, release, timestamps, processing recipe, wavelength selection and excluded-frame reasons. Preserve access to original FITS or their archive links.

Working with SPHEREx wavelength metadata needs particular care. Its WCS-WAVE lookup is intended for visualization; quantitative science should use the higher-fidelity spectral calibration products documented by IRSA. [2]

## 5. Add richer comparisons in a controlled order

**Two-image blink first.** This directly meets the core challenge and exposes registration errors early.

**Difference image next.** Match the wavelength response, background, flux calibration and point-spread function before subtraction. Propagate uncertainty through resampling and convolution. Simple pixel subtraction is a visual diagnostic, not automatically a significant detection.

**Six detector summaries afterwards.** Within each epoch, first combine repeat measurements of the same spectral channels using suitable uncertainty weights. Then apply fixed spectral weights across the shared channels to form a detector summary. Show the effective wavelength coverage. Blindly averaging whatever channels happen to exist in each epoch can manufacture variability.

**Light curves and spectra later.** Implement local extraction incrementally and validate fluxes, uncertainties, aperture or PSF corrections, pixel solid-angle conversion and blending checks. Retain observation dates for every spectral point: measurements at different wavelengths may also be from different times. Track moving sources appropriately before extracting flux. Small supported jobs run locally; extensive fitting can use an optional remote queue. Cache results by source model, input versions and extraction parameters.

IRSA already provides a forced-spectrophotometry tool. Evaluate reuse through a documented interface, or link users to the official tool if no supported integration exists. Its documentation notes that extraction may take minutes to hours, so promise asynchronous results rather than instantaneous full spectra. [8]

**Gaia and WISE context afterwards.** Use Gaia DR3 as requested. Propagate catalog positions to the relevant observation epoch where proper motions are available; account for apparent parallax when accurate nearby-source overlays require it. Label reference epochs and uncertainties. Keep WISE images visibly identified by mission and date, since cross-mission brightness is not directly interchangeable.

## 6. Test the five required targets

These are planned tests, not reported observations.

| Target | Purpose | Acceptance evidence |
|---|---|---|
| Barnard's Star | Motion and registration | Verify identity at observation epochs; show available displacement against stable field references, or document inadequate coverage. |
| Epsilon Indi B | Brown-dwarf field and blending | Resolve the correct object identity, separate it from Epsilon Indi A in the catalog selection, and assess the Ba/Bb system as an unresolved target. |
| WISE 0855 | Faint-source handling and coordinate epochs | Inspect suitable infrared coverage and show a measured detection or an honest non-detection. Do not amplify noise into a claimed source. |
| RW Aurigae | Brightness comparison | Compare matched wavelengths at available epochs; examine blending, saturation and stable comparison sources. |
| R Draconis | Brightness comparison | Verify dates, comparable passbands and display scaling; add a light curve only after photometry is validated. |

The challenge's WISE 0855 position converts to RA **133.7951292°**, declination **−7.2451472°**. Its reference epoch was not supplied. Preserve it as the challenge input, then obtain a verified astrometric reference before treating it as the object's position at an observation date.

SPHEREx pixels are about 6.2 arcseconds across. Published work describes Epsilon Indi Ba/Bb as a subarcsecond pair; therefore the appropriate product assumption is an unresolved system, not two separately imaged components. This is an inference from the instrument scale and published separation. [9][10]

Additional meaningful checks:

- A stable control field should not acquire systematic motion or artificial brightness variation.
- A test-only injected moving source should retain its expected displacement through processing. Clearly label all simulations and keep them separate from real-data examples.
- Verify coordinates near RA 0/360, negative declinations, footprint edges and missing-data regions.
- A restored share URL should reproduce the same recorded sequence; refreshing to newer data should be an explicit option.
- An upstream outage should leave cached examples usable and show a clear status for new searches.
- Ask five unfamiliar users to open an example, play it, mark something and share the view without assistance.
- Compare the browser numerical core with the Python reference on identical inputs. Establish tolerances for registration, flux and uncertainty from scientific requirements; record precision and algorithm versions.
- Benchmark on a modest phone and laptop, including peak memory, bytes transferred, first usable frame, computation time and responsiveness.
- Verify that a repeated request needs neither another download nor another calculation while valid data remain cached. Verify that a nearby request reuses overlapping tiles.
- Test cache invalidation after an input correction or algorithm change, expired discovery metadata, interrupted writes, quota exhaustion and browser eviction.
- Confirm that contrast changes reuse numeric data, same-key simultaneous requests share work, and partial results cannot be mistaken for completed products.

Proposed performance goals: a cached example becomes usable within three seconds on the agreed test connection; playback is smooth after preload; uncached work always exposes status. Measure these rather than presenting them as achieved results.

## 7. Deliver in milestones

| Milestone | Deliverable | Exit condition |
|---|---|---|
| 1. Data access | Target coverage report and browser retrieval proof | Obtain a real comparison pair; verify endpoint permissions or demonstrate a minimal proxy. |
| 2. Numerical feasibility | Python reference plus one Rust/WASM processing path | Browser outputs agree with reference within documented tolerances; measure time and memory on representative devices. |
| 3. Core viewer | Coordinates, field and wavelength selection, playback and presets | An uncached supported region can be retrieved and processed locally with visible progress. |
| 4. Aggressive reuse | Browser cache, shared tile distribution, versioned manifests and URLs | Repeated requests reuse work; overlapping fields reuse inputs; metadata refresh reveals new data. |
| 5. Reliability and optional fallback | Quota handling, resumable jobs and optional remote execution | Oversized jobs have a clear path; cached examples work through archive outages; embeds work with the baseline worker. |
| 6. Public MVP validation | Five target outcomes and usability checks | Science, mobile, keyboard, sharing, cache and failure checks pass. |
| 7. Full scope | Validated differences, detector summaries, evidence cards, overlays, mosaics and spectra | All eight challenge considerations are covered with documented data limits. |

The original 10–15-day estimate was a preliminary MVP budget. Re-estimate after milestone 2: porting a scientific routine may take longer than connecting an existing Python implementation. Preserve the browser-first architecture while adding capabilities in manageable increments.

If there are three teammates, divide responsibility into numerical processing, browser experience, and data access/caching. Review the first complete comparison together.

For a 48-hour event, prioritize one verified pair of images, cached real-data presets, playback, timestamps and sharing. A preset-only demonstration remains a milestone rather than completion of arbitrary-coordinate processing.

## 8. Cache aggressively and keep discovery fresh

Caching is a core requirement. Reuse expensive work at every boundary: downloaded inputs, decoded arrays, aligned tiles, comparison products, extracted measurements and rendered previews. Browser and shared caches complement one another.

Prefer standardized sky tiles and reproducible cutout boundaries so nearby searches overlap in reusable data. Preserve the user's exact coordinates and requested grid in the manifest; never silently round scientific positions to improve cache hits. Generate shared products on demand and warm the five example targets before considering broader precomputation.

The following are starting policies to benchmark, not guaranteed provider behavior:

| Cache layer or item | Policy | Refresh and eviction |
|---|---|---|
| Active arrays and graphics textures | Keep the current view and a small adjacent-frame working set | Reuse buffers; release least-recently-used entries at a measured RAM/GPU budget |
| Browser downloaded inputs | Persist reusable responses in Cache Storage with indexed provenance | Content-address verified bytes; enforce application-managed freshness and disk budgets |
| Browser derived products | Persist costly numeric results and extraction tables | Reuse only for identical inputs and recipe; discard incomplete writes |
| Shared public inputs and trusted results | CDN and object storage at stable versioned URLs | Prefer content-addressed assets; apply storage budgets while retaining named example bundles |
| Observation-search metadata | Initially 15 minutes, then revalidate in the background while showing the checked-at time | Explicit refresh bypasses the freshness window; conditional requests where supported |
| Release/configuration manifest | Revalidate on opening the app and when stale; initially at most one hour | A new release updates discoverability without deleting immutable historic products |
| Empty search results | At most five minutes initially | Recheck soon so newly ingested observations are not hidden |
| Hashed JS, WASM and verified immutable assets | Long HTTP lifetime, e.g. one year with immutable at application-controlled URLs | A change creates a new URL; mutable latest pointers use revalidation |

HTTP caching can avoid repeated transfer and origin work. Use conditional validation where supported. The Cache API has its own lifecycle: it does not automatically apply HTTP freshness directives, so the service worker/application must implement expiry, revalidation and deletion explicitly. [16][17]

Correct identity and invalidation:

- Hash a canonical recipe containing input product identifiers and checksums or reliable versions, calibration versions, wavelength selection, epoch bins, output WCS/grid/scale, quality rules, background and PSF settings, interpolation, numeric precision and algorithm version.
- For spectra, also include source position/epoch, motion model, aperture or source model, deblending assumptions and extraction settings.
- Keep rendered previews in a separate cache keyed by the numeric product plus display settings. Palette changes should not invalidate downloaded inputs or aligned arrays.
- Do not assume an upstream URL can never change. Revalidate mutable source metadata and retain verified content hashes; a correction creates new derived identities.
- Invalidate the affected branch of products, not the entire cache. Keep previously shared manifests pinned to their original recipe and offer an explicit refresh to current data.
- An expired discovery result may be shown provisionally with its timestamp while refreshing. An old result must not be labelled as the latest verified coverage.
- Cache completed successful responses atomically. Treat network errors separately from valid empty results and use short retry backoff.
- Deduplicate concurrent same-key fetches and calculations inside the browser and at any shared gateway. Coordinate cross-tab work where practical; avoid simultaneous rebuilds of a popular expired entry.
- Keep a visitor's locally computed outputs local unless a future upload path validates them before promotion into a trusted shared cache.

Resource controls:

- Query available storage, impose application budgets and evict least-recently-used expendable data. Browser quotas vary and best-effort storage can be evicted, so cache availability is not a durability promise. Save essential provenance with exports and retain deliberate shared evidence separately from disposable cache entries. [18]
- Keep large arrays out of localStorage. Handle quota errors, partial downloads and interrupted writes; offer a visible cache size and clear-cache control.
- Prefetch only likely next frames or visible neighboring tiles, bounded by a byte budget. Provide a data-saving option; eager loading of every band and epoch is not required for aggressive reuse.
- Measure cache hit rate, reuse across nearby searches, avoided origin bytes, recomputation counts, first-frame latency, eviction rate and cost per uncached request.
- Limit download concurrency and request rate even when browsers contact IRSA directly. Shared caching reduces repeated archive work but does not remove provider limits.
- Respect source access conditions. Only public, permitted scientific assets belong in the shared cache; future personal annotations require separate handling.

Release updates and hosting:

- Keep collection names and product versions in a small provider adapter/configuration. Refresh when opening the app; use an optional scheduled metadata task if continuous release tracking is needed.
- Track observation time, ingestion time and last verification separately. SIA availability can lag weekly ingestion. [3]
- Serve the frontend and public cached assets independently of the optional compute service. A browser-only deployment needs verified archive access; a thin gateway is sufficient when access mediation alone is required.
- Add durable remote processing for workloads that exceed measured browser limits or must survive tab closure. A gateway or shared cache does not require running all science on the server.

## 9. Present the demo around one complete task

Open a verified example, explain its dates, blink between epochs, point out a real observed change if one is supported, and share the exact view. Then show a second target demonstrating brightness comparison or a clearly explained non-detection. Finish by entering new coordinates and displaying genuine retrieval progress.

The distinguishing feature should be **a change that another person can inspect and reproduce**. Every candidate should carry its coordinates, dates, wavelength selection, source data and quality context. Call it a candidate until follow-up confirms its nature.

Include the mission's requested acknowledgement and data-release identifiers in the final app's credits. [11]

**Start here:** retrieve a suitable real two-epoch comparison and establish a Python reference. Then load the same inputs through the browser adapter and process them in a worker. Measure numerical agreement, memory and time; repeat the request to verify that cached data and outputs eliminate unnecessary work. Try Barnard's Star first, and document any coverage limitation before using another required target.

## Sources

Documentation checked 14 November 2026. References support archive and software facts; architecture choices, thresholds, estimates and acceptance criteria are proposed project decisions.

1. [IRSA: SPHEREx data releases](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-releases/)
2. [IRSA: SPHEREx data products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)
3. [IRSA: SPHEREx data access](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/)
4. [CDS: Aladin Lite API](https://cds-astro.github.io/aladin-lite/)
5. [Astropy: reproject](https://github.com/astropy/reproject)
6. [FastAPI: background tasks and heavy-computation caveat](https://fastapi.tiangolo.com/tutorial/background-tasks/)
7. [IRSA: SPHEREx cutout service](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/cutout_tool.html)
8. [IRSA: SPHEREx spectrophotometry tool](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html)
9. [Caltech: SPHEREx instrument](https://spherex.caltech.edu/page/instrument)
10. [Research paper: large-scale cloud changes in Epsilon Indi Ba/Bb](https://doi.org/10.1093/mnras/staa1344)
11. [IRSA: DR1 overview and acknowledgement](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_dr1.html)

12. [MDN: cross-origin resource sharing](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)
13. [CDS: Aladin Lite Rust/WebAssembly and WebGL implementation](https://github.com/cds-astro/aladin-lite)
14. [MDN: Web Workers and transferable buffers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)
15. [MDN: shared memory and cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
16. [MDN: HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching)
17. [MDN: Cache API lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Cache)
18. [MDN: browser storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
