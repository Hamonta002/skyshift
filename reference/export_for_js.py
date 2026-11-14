"""Export real exposures, Astropy test vectors and the Python visit stacks to JSON for bench.mjs.

Uses the band-6 exposures of WISE 0855 cached by fetch_target.py:
   python fetch_target.py wise0855 --dets 6 && python export_for_js.py && node bench.mjs
"""
import argparse, json, math, os

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

import spx
from targets import position


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--work", default="_work")
    args = ap.parse_args()
    ra0, dec0 = position("wise0855")
    oh, scale = 20, 3.075
    n = 2 * oh + 1
    grid = WCS(naxis=2)
    grid.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    grid.wcs.crval = [ra0, dec0]
    grid.wcs.crpix = [oh + 1, oh + 1]
    grid.wcs.cdelt = [-scale / 3600, scale / 3600]
    yy, xx = np.mgrid[0:n, 0:n]
    sky_ra, sky_dec = grid.all_pix2world(xx.ravel(), yy.ravel(), 0)
    rng = np.random.default_rng(7)
    exposures, frames = [], []
    for r in spx.load_cached(os.path.join(args.work, "cache_wise0855"), {6}):
        h = fits.Header.fromstring(r["hdr"])
        w = spx.celestial_wcs(h)
        img = r["img"].astype(float)
        half = img.shape[0] // 2

        def coef(prefix):
            order = h[f"{prefix}_ORDER"]
            return {f"{p}_{q}": float(h.get(f"{prefix}_{p}_{q}", 0.0)) for p in range(order + 1) for q in range(order + 1 - p)}

        # test vectors: random sky points near the target -> Astropy pixel positions (0-based) and back
        tr = ra0 + rng.uniform(-60, 60, 40) / 3600 / math.cos(math.radians(dec0))
        td = dec0 + rng.uniform(-60, 60, 40) / 3600
        px, py = w.all_world2pix(tr, td, 0)
        br, bd = w.all_pix2world(px, py, 0)
        exposures.append(dict(
            x0=r["xi"] - half, y0=r["yi"] - half, size=img.shape[0],
            crval=[float(h["CRVAL1"]), float(h["CRVAL2"])], crpix=[float(h["CRPIX1"]), float(h["CRPIX2"])],
            pc=[float(h["PC1_1"]), float(h["PC1_2"]), float(h["PC2_1"]), float(h["PC2_2"])], cdelt=[float(h["CDELT1"]), float(h["CDELT2"])],
            a=coef("A"), b=coef("B"), ap=coef("AP"), bp=coef("BP"),
            img=[None if not np.isfinite(v) else float(v) for v in img.ravel()],
            test=dict(ra=tr.tolist(), dec=td.tolist(), x=px.tolist(), y=py.tolist(), ra_back=br.tolist(), dec_back=bd.tolist())))
        # the resampling and background step of stack_visits.py
        qx, qy = w.all_world2pix(sky_ra, sky_dec, 0)
        bx, by = qx - (r["xi"] - half), qy - (r["yi"] - half)
        x0, y0 = np.floor(bx).astype(int), np.floor(by).astype(int)
        tx, ty = bx - x0, by - y0
        ok = (x0 >= 0) & (y0 >= 0) & (x0 < img.shape[1] - 1) & (y0 < img.shape[0] - 1)
        res = np.full(n * n, np.nan)
        a, b, u, v = x0[ok], y0[ok], tx[ok], ty[ok]
        res[ok] = img[b, a] * (1 - u) * (1 - v) + img[b, a + 1] * u * (1 - v) + img[b + 1, a] * (1 - u) * v + img[b + 1, a + 1] * u * v
        fin = res[np.isfinite(res)]
        if fin.size >= 0.5 * n * n:
            frames.append(dict(mjd_avg=r["mjd_avg"], img=res.reshape(n, n) - np.median(fin)))
    visits = spx.split_visits(frames, 40.0)
    stacks = [np.nanmedian(np.array([f["img"] for f in v]), 0) for v in visits]
    out = os.path.join(args.work, "wise0855_d6.json")
    with open(out, "w") as f:
        json.dump(dict(ra0=ra0, dec0=dec0, oh=oh, scale=scale, exposures=exposures, visit_sizes=[len(v) for v in visits],
                       stacks=[[None if not np.isfinite(v) else float(v) for v in s.ravel()] for s in stacks]), f)
    print(f"wrote {out}: {len(exposures)} exposures, visits of {[len(v) for v in visits]}")


if __name__ == "__main__":
    main()
