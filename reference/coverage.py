"""Coverage report: which SPHEREx Level-2 exposures contain each challenge target?

Queries IRSA SIA2 for every searchable collection at the target's present-day position and
writes the raw CSV plus a summary. Run:  python coverage.py [--work DIR]
"""
import argparse, collections, csv, io, json, os, time, urllib.parse, urllib.request

import spx
from targets import TARGETS, position


def iso(mjd):
    return time.strftime("%Y-%m-%d", time.gmtime((mjd - 40587.0) * 86400.0))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--work", default="_work", help="working directory for downloads (default: _work)")
    args = ap.parse_args()
    out = os.path.join(args.work, "coverage")
    os.makedirs(out, exist_ok=True)
    summary = {}
    for name, t in TARGETS.items():
        ra, dec = position(name)
        summary[name] = {}
        total = 0
        print(f"\n{t['label']}  at ({ra}, {dec})")
        for coll in spx.COLLECTIONS:
            q = urllib.parse.urlencode({"COLLECTION": coll, "POS": f"circle {ra} {dec} 0.0001", "RESPONSEFORMAT": "CSV"})
            t0 = time.time()
            with urllib.request.urlopen(f"{spx.SIA}?{q}", timeout=300) as r:
                body = r.read().decode("utf-8", "replace")
            with open(os.path.join(out, f"{name}__{coll}.csv"), "w") as f:
                f.write(body)
            rows = list(csv.DictReader(io.StringIO(body)))
            info = {"n": len(rows), "query_s": round(time.time() - t0, 1)}
            if rows:
                mjd = sorted(float(r["t_min"]) for r in rows)
                visits = spx.split_visits(mjd, 20.0, key=lambda m: m)
                info["dets"] = dict(sorted(collections.Counter(r["energy_bandpassname"][-2:] for r in rows).items()))
                info["visits"] = [f"{iso(v[0])}..{iso(v[-1])} ({len(v)})" for v in visits]
            summary[name][coll] = info
            total += len(rows)
            print(f"  {coll:<17} {len(rows):5d} frames  {info['query_s']:4.1f}s  {info.get('dets', '')}")
            for v in info.get("visits", []):
                print(f"      {v}")
        print(f"  total {total}")
    with open(os.path.join(out, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1)


if __name__ == "__main__":
    main()
