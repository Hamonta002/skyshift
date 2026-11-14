"""Per-exposure centroid and aperture photometry on the boxes cached by fetch_target.py.

Prints, per detector, how many exposures have a blanked (saturated) core, then per visit the
measured position relative to the fixed 2026.0 reference and relative to the proper-motion
prediction, and the flux in three wavelength bins per detector per visit.

Quick-look only: fixed 2.5-pixel aperture, no aperture correction, no flag masking.
   python measure_frames.py barnard          python measure_frames.py rdra --wing
"""
import argparse, math, os

import numpy as np
from astropy.io import fits

import spx
from targets import TARGETS, position, REF_EPOCH


def mad(a):
    a = np.asarray(a, float)
    return 1.4826 * np.median(np.abs(a - np.median(a)))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("name", choices=TARGETS)
    ap.add_argument("--snr", type=float, default=10.0, help="minimum per-exposure S/N for astrometry")
    ap.add_argument("--wing", action="store_true", help="also report annulus (3-6 px) flux for saturated stars")
    ap.add_argument("--work", default="_work")
    args = ap.parse_args()
    t = TARGETS[args.name]
    ra0, dec0 = position(args.name)
    cosd = math.cos(math.radians(dec0))
    rows = []
    for r in spx.load_cached(os.path.join(args.work, f"cache_{args.name}")):
        img = r["img"].astype(float)
        h = img.shape[0] // 2
        w = spx.celestial_wcs(fits.Header.fromstring(r["hdr"]))
        yr = spx.year(r["mjd_avg"])
        ra_p = ra0 + (yr - REF_EPOCH) * t["pmra"] / 3.6e6 / cosd            # proper-motion prediction for this exposure
        dec_p = dec0 + (yr - REF_EPOCH) * t["pmdec"] / 3.6e6
        xp, yp = (float(v) for v in w.all_world2pix(ra_p, dec_p, 0))
        cx, cy = xp - (r["xi"] - h), yp - (r["yi"] - h)
        yy, xx = np.mgrid[0:img.shape[0], 0:img.shape[1]]
        rad = np.hypot(xx - cx, yy - cy)
        sky = img[(rad > 8) & (rad < 14) & np.isfinite(img)]
        if sky.size < 30:
            continue
        bg, sig = float(np.median(sky)), float(mad(sky))
        sub = img - bg
        mx, my = cx, cy
        for _ in range(8):                                                   # flux-weighted centroid, r <= 2.5 px
            m = (np.hypot(xx - mx, yy - my) <= 2.5) & np.isfinite(sub)
            wgt = np.clip(sub[m], 0, None)
            if wgt.sum() <= 0:
                break
            mx, my = float((xx[m] * wgt).sum() / wgt.sum()), float((yy[m] * wgt).sum() / wgt.sum())
        aper = (np.hypot(xx - mx, yy - my) <= 2.5) & np.isfinite(sub)
        ra_m, dec_m = (float(v) for v in w.all_pix2world(mx + (r["xi"] - h), my + (r["yi"] - h), 0))
        wing_mask = (rad > 3) & (rad <= 6)
        wing_ok = wing_mask & np.isfinite(img)
        rows.append(dict(
            yr=yr, det=r["det"], wave=r["wave"], band=r["band"],
            nan_core=int(np.sum(~np.isfinite(img[rad <= 2.0]))),
            flux=float(sub[aper].sum() * 1e6 * spx.OMEGA_SR), err=float(sig * math.sqrt(aper.sum()) * 1e6 * spx.OMEGA_SR),
            fix_x=(ra_m - ra0) * cosd * 3600, fix_y=(dec_m - dec0) * 3600,      # measured minus fixed reference
            res_x=(ra_m - ra_p) * cosd * 3600, res_y=(dec_m - dec_p) * 3600,    # measured minus proper-motion prediction
            wing=float(np.mean(sub[wing_ok]) * wing_mask.sum() * 1e6 * spx.OMEGA_SR) if wing_ok.sum() > 0.7 * wing_mask.sum() else float("nan"),
        ))
    visits = spx.split_visits(rows, 40.0 / 365.25, key=lambda d: d["yr"])
    print(f"{t['label']}: {len(rows)} exposures in {len(visits)} visits; blanked core (NaN within 2 px) in {sum(d['nan_core'] > 0 for d in rows)}")
    for det in sorted({d["det"] for d in rows}):
        dd = [d for d in rows if d["det"] == det]
        clean = [d for d in dd if d["nan_core"] == 0 and d["err"] > 0]
        line = f"  D{det}: {len(dd):3d} exposures, {min(d['wave'] for d in dd):.2f}-{max(d['wave'] for d in dd):.2f} um, blanked core in {len(dd) - len(clean):3d}"
        if clean:
            line += f", median flux {np.median([d['flux'] for d in clean]) * 1e3:9.2f} mJy, median S/N {np.median([d['flux'] / d['err'] for d in clean]):7.1f}"
        print(line)
    print("  Astrometry per visit (clean exposures; arcsec; E and N positive):")
    for v in visits:
        good = [d for d in v if d["nan_core"] == 0 and d["err"] > 0 and d["flux"] / d["err"] > args.snr]
        if len(good) < 3:
            print(f"    {np.mean([d['yr'] for d in v]):.3f}: {len(v)} exposures, {len(good)} usable - skipped")
            continue
        fx, fy = [d["fix_x"] for d in good], [d["fix_y"] for d in good]
        print(f"    {np.mean([d['yr'] for d in good]):.3f}: n={len(good):3d}  position vs fixed reference E {np.median(fx):+6.2f} N {np.median(fy):+6.2f}"
              f"   vs proper-motion prediction E {np.median([d['res_x'] for d in good]):+5.2f} N {np.median([d['res_y'] for d in good]):+5.2f}"
              f"   per-exposure scatter {mad(fx):.2f}/{mad(fy):.2f}")
    print("  Flux per visit in three wavelength bins per detector (median Jy [n]; clean exposures):")
    for det in sorted({d["det"] for d in rows}):
        dd = [d for d in rows if d["det"] == det and d["nan_core"] == 0]
        if len(dd) < 9:
            continue
        edges = np.quantile([d["wave"] for d in dd], [0, 1 / 3, 2 / 3, 1])
        cells = []
        for i in range(3):
            per_visit = []
            for v in visits:
                f = [d["flux"] for d in v if d["det"] == det and d["nan_core"] == 0 and edges[i] <= d["wave"] <= edges[i + 1]]
                per_visit.append(f"{np.median(f):.4f}[{len(f)}]" if f else "-")
            cells.append(f"{edges[i]:.2f}-{edges[i + 1]:.2f}um " + " > ".join(per_visit))
        print(f"    D{det}: " + "  |  ".join(cells))
    if args.wing:
        print("  Wing flux, annulus 3-6 px (Jy), for saturated stars: year:wavelength:flux")
        for det in sorted({d["det"] for d in rows}):
            print(f"    D{det}: " + "  ".join(f"{d['yr']:.2f}:{d['wave']:.2f}:{d['wing']:.1f}" for d in rows if d["det"] == det))


if __name__ == "__main__":
    main()
