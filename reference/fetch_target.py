"""Download a small native-pixel box around a target from every exposure that covers it.

Reads directly from the S3 mirror with Range requests (header + one block of rows per exposure).
Run coverage.py first.   python fetch_target.py wise0855 --dets 6
"""
import argparse, glob, json, os, time
from concurrent.futures import ThreadPoolExecutor

import spx
from targets import TARGETS, position


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("name", choices=TARGETS)
    ap.add_argument("--dets", default="1,2,3,4,5,6", help="detectors to fetch, e.g. 5,6")
    ap.add_argument("--half", type=int, default=15, help="box half-size in native pixels (15 -> 31 px = 3.2 arcmin)")
    ap.add_argument("--max-per-det", type=int, default=0, help="evenly sample at most this many exposures per detector (0 = all)")
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--work", default="_work")
    args = ap.parse_args()
    dets = {int(d) for d in args.dets.split(",")}
    ra, dec = position(args.name)
    frames = [f for f in spx.load_frames(glob.glob(os.path.join(args.work, "coverage", f"{args.name}__*.csv"))) if f["det"] in dets]
    if args.max_per_det:
        sel = []
        for d in sorted(dets):
            fd = [f for f in frames if f["det"] == d]
            sel += fd[::max(1, len(fd) // args.max_per_det)][:args.max_per_det]
        frames = sorted(sel, key=lambda f: f["mjd"])
    cache = os.path.join(args.work, f"cache_{args.name}")
    print(f"{TARGETS[args.name]['label']}: {len(frames)} exposures, {2 * args.half + 1}-pixel box at ({ra}, {dec})")
    t0 = time.time()
    counts = {"on_detector": 0, "off_detector": 0, "errors": 0}

    def job(fr):
        try:
            return spx.fetch_frame(fr, ra, dec, args.half, cache)
        except Exception as e:      # keep going; report at the end
            return e

    with ThreadPoolExecutor(args.threads) as ex:
        for rec in ex.map(job, frames):
            if isinstance(rec, Exception):
                counts["errors"] += 1
                print("  error:", rec)
            else:
                counts["on_detector" if rec["img"] is not None else "off_detector"] += 1
    print(json.dumps(dict(counts, seconds=round(time.time() - t0, 1), new_requests=spx.STATS["requests"],
                          new_megabytes=round(spx.STATS["bytes"] / 1e6, 1))))


if __name__ == "__main__":
    main()
