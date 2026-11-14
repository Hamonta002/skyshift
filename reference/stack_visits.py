"""Resample each exposure onto one fixed north-up grid, stack per visit, and measure the target.

This is the core product the web tool needs: one frame per visit per detector band.
The grid is fixed on the sky at the target's 2026.0 position, so a moving object shifts between frames.
   python stack_visits.py wise0855 --dets 6
Writes a PNG contact sheet (top: one single exposure per visit; bottom: the visit stacks).
"""
import argparse, math, os

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

import spx
from targets import TARGETS, position, REF_EPOCH


def mad(a):
    a = np.asarray(a, float)
    return 1.4826 * np.median(np.abs(a - np.median(a)))


def aperture(im, cx, cy, rap, xx, yy):
    """Aperture sum, and its noise from the scatter of the same aperture placed on blank sky."""
    rad = np.hypot(xx - cx, yy - cy)
    sky = im[(rad > 4 * rap) & (rad < 8 * rap) & np.isfinite(im)]
    bg = np.median(sky)
    inside = (rad <= rap) & np.isfinite(im)
    rng, n, blanks = np.random.default_rng(1), im.shape[0], []
    for _ in range(400):
        rx, ry = rng.uniform(rap + 1, n - rap - 2, 2)
        if math.hypot(rx - cx, ry - cy) < 3 * rap:
            continue
        m = (np.hypot(xx - rx, yy - ry) <= rap) & np.isfinite(im)
        if m.sum() >= 0.9 * inside.sum():
            blanks.append((im[m] - bg).sum())
    return float((im[inside] - bg).sum()), float(mad(blanks)), float(bg)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("name", choices=TARGETS)
    ap.add_argument("--dets", default="6")
    ap.add_argument("--scale", type=float, default=3.075, help="output pixel in arcsec (native is 6.15)")
    ap.add_argument("--half", type=int, default=20, help="output half-size in output pixels")
    ap.add_argument("--gap", type=float, default=40.0, help="days without data that separate two visits")
    ap.add_argument("--work", default="_work")
    args = ap.parse_args()
    dets = {int(d) for d in args.dets.split(",")}
    t = TARGETS[args.name]
    ra0, dec0 = position(args.name)
    oh, scale, n = args.half, args.scale, 2 * args.half + 1

    grid = WCS(naxis=2)                                         # north up, east left, fixed on the sky
    grid.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    grid.wcs.crval = [ra0, dec0]
    grid.wcs.crpix = [oh + 1, oh + 1]
    grid.wcs.cdelt = [-scale / 3600, scale / 3600]
    yy, xx = np.mgrid[0:n, 0:n]
    sky_ra, sky_dec = grid.all_pix2world(xx.ravel(), yy.ravel(), 0)

    frames = []
    for r in spx.load_cached(os.path.join(args.work, f"cache_{args.name}"), dets):
        img = r["img"].astype(float)
        h = img.shape[0] // 2
        px, py = spx.celestial_wcs(fits.Header.fromstring(r["hdr"])).all_world2pix(sky_ra, sky_dec, 0)
        bx, by = px - (r["xi"] - h), py - (r["yi"] - h)
        x0, y0 = np.floor(bx).astype(int), np.floor(by).astype(int)
        tx, ty = bx - x0, by - y0
        ok = (x0 >= 0) & (y0 >= 0) & (x0 < img.shape[1] - 1) & (y0 < img.shape[0] - 1)
        out = np.full(n * n, np.nan)
        a, b, u, v = x0[ok], y0[ok], tx[ok], ty[ok]             # bilinear resampling
        out[ok] = img[b, a] * (1 - u) * (1 - v) + img[b, a + 1] * u * (1 - v) + img[b + 1, a] * (1 - u) * v + img[b + 1, a + 1] * u * v
        fin = out[np.isfinite(out)]
        if fin.size < 0.5 * n * n:
            continue
        bg = np.median(fin)                                     # local sky: zodiacal light is flat on this scale
        frames.append(dict(mjd_avg=r["mjd_avg"], yr=spx.year(r["mjd_avg"]), det=r["det"], wave=r["wave"], img=out.reshape(n, n) - bg, sig=mad(fin)))

    visits = spx.split_visits(frames, args.gap)
    rap = 1.5 * 6.15 / scale                                    # 9.2 arcsec aperture radius
    stacks = []
    print(f"{t['label']}, detector(s) {sorted(dets)}: {len(frames)} exposures in {len(visits)} visits; aperture radius {rap * scale:.1f}\"")
    for v in visits:
        med = np.nanmedian(np.array([f["img"] for f in v]), 0)
        yr = float(np.mean([f["yr"] for f in v]))
        cx = oh - (yr - REF_EPOCH) * t["pmra"] / 1000.0 / scale     # proper-motion prediction on the grid (east = -x)
        cy = oh + (yr - REF_EPOCH) * t["pmdec"] / 1000.0 / scale
        flux, noise, bg = aperture(med, cx, cy, rap, xx, yy)
        near = (np.hypot(xx - cx, yy - cy) <= 1.6 * rap) & np.isfinite(med)
        wgt = np.clip(med[near] - bg, 0, None)
        mx, my = ((xx[near] * wgt).sum() / wgt.sum(), (yy[near] * wgt).sum() / wgt.sum()) if wgt.sum() > 0 else (np.nan, np.nan)
        single = []
        for f in v:
            f1, n1, _ = aperture(f["img"], cx, cy, rap, xx, yy)
            single.append(f1 / n1 if n1 > 0 else np.nan)
        print(f"  {yr:.3f}: {len(v):3d} exposures | single-exposure S/N median {np.nanmedian(single):5.2f} | stack S/N {flux / noise:5.1f}, "
              f"flux {flux * 1e9 * spx.OMEGA_SR * (scale / 6.15) ** 2:.3f} mJy | position vs fixed reference: "
              f"E {-(mx - oh) * scale:+5.2f}\" N {(my - oh) * scale:+5.2f}\"  (proper-motion prediction E {(yr - REF_EPOCH) * t['pmra'] / 1000:+5.2f}\" N {(yr - REF_EPOCH) * t['pmdec'] / 1000:+5.2f}\")")
        stacks.append((yr, med, cx, cy, v))

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axs = plt.subplots(2, len(stacks), figsize=(3.4 * len(stacks), 7.2), squeeze=False)
    sg = mad(np.concatenate([s[1][np.isfinite(s[1])].ravel() for s in stacks]))
    for i, (yr, med, cx, cy, v) in enumerate(stacks):
        one = v[len(v) // 2]
        axs[0][i].imshow(one["img"], origin="lower", cmap="gray", vmin=-2 * one["sig"], vmax=8 * one["sig"])
        axs[0][i].set_title(f"single exposure {one['yr']:.3f}\nD{one['det']}, {one['wave']:.2f} um", fontsize=9)
        axs[1][i].imshow(med, origin="lower", cmap="gray", vmin=-2 * sg, vmax=8 * sg)       # one shared stretch for all stacks
        axs[1][i].set_title(f"visit stack {yr:.3f} ({len(v)} exposures)", fontsize=9)
        for ax in (axs[0][i], axs[1][i]):
            ax.plot([cx - 6, cx - 3], [cy, cy], color="#ff5a36", lw=1.2)
            ax.plot([cx, cx], [cy + 3, cy + 6], color="#ff5a36", lw=1.2)
            ax.plot([oh], [oh], marker="+", color="#3aa0ff", ms=9, mew=1)
            ax.set_xticks([])
            ax.set_yticks([])
    fig.suptitle(f"{t['label']} - SPHEREx detector(s) {sorted(dets)} - red ticks: proper-motion prediction; blue +: fixed sky position; N up, E left; {scale}\"/px", fontsize=9)
    fig.tight_layout()
    png = os.path.join(args.work, f"{args.name}_D{'-'.join(str(d) for d in sorted(dets))}_visit_stacks.png")
    fig.savefig(png, dpi=110)
    print("saved", png)


if __name__ == "__main__":
    main()
