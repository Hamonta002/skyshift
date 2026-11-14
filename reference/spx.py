"""Minimal SPHEREx Level-2 reader that uses only HTTP Range requests on the public S3 mirror.

It does what a browser can do: the bucket answers with `Access-Control-Allow-Origin: *`,
accepts the `Range` header, and stores IMAGE/VARIANCE/ZODI uncompressed. Nothing here needs
the 4 MB-per-request IRSA cutout service.

Per exposure it costs two requests: the header (28.8 kB) and one contiguous block of rows.
"""
import csv, os, re, threading, time, warnings

import numpy as np
import requests
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

warnings.simplefilter("ignore", FITSFixedWarning)

S3 = "https://nasa-irsa-spherex.s3.amazonaws.com/"
IBE = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
SIA = "https://irsa.ipac.caltech.edu/SIA"
COLLECTIONS = ["spherex_dr1", "spherex_dr1_deep", "spherex_qr3", "spherex_qr3_deep"]
NX = NY = 2040
OMEGA_SR = 37.86 * (np.pi / 648000.0) ** 2      # median pixel solid angle (header OMEGA_MEDIAN, arcsec^2) in sr

STATS = {"requests": 0, "bytes": 0}
_lock = threading.Lock()
_tls = threading.local()


def year(mjd):
    return 2000.0 + (mjd - 51544.5) / 365.25


def _session():
    if not hasattr(_tls, "s"):
        _tls.s = requests.Session()
    return _tls.s


def get_range(key, start=None, end=None, suffix=None):
    """Bytes start..end (inclusive) of an S3 object, or its last `suffix` bytes."""
    headers = {"Range": f"bytes=-{suffix}" if suffix else f"bytes={start}-{end}"}
    for attempt in range(4):
        try:
            r = _session().get(S3 + key, headers=headers, timeout=120)
            if r.status_code != 206:       # NB: S3 ignores multi-range requests and returns the whole 65 MB file
                raise RuntimeError(f"HTTP {r.status_code}")
            with _lock:
                STATS["requests"] += 1
                STATS["bytes"] += len(r.content)
            return r.content
        except Exception:
            if attempt == 3:
                raise
            time.sleep(1.5 * (attempt + 1))


def load_frames(csv_paths):
    """SIA2 CSV results -> time-sorted list of frames (deduplicated by file).

    Only columns that precede `cloud_access` are used: that column holds unquoted JSON with commas,
    so the CSV is not strictly parseable beyond it.
    """
    frames = {}
    for path in csv_paths:
        with open(path) as f:
            for row in csv.DictReader(f):
                url = row["access_url"]
                if not url.startswith(IBE):
                    continue
                key = url[len(IBE):]
                frames[key] = dict(
                    key=key, obs_id=row["obs_id"], collection=row["obs_collection"],
                    det=int(row["energy_bandpassname"].rsplit("D", 1)[1]),
                    mjd=0.5 * (float(row["t_min"]) + float(row["t_max"])),
                )
    return sorted(frames.values(), key=lambda d: d["mjd"])


def read_image_header(key):
    """(IMAGE header, byte offset of the IMAGE data). Parses the header instead of assuming a fixed size."""
    buf = get_range(key, 0, 28799)

    def find_end(start):
        k = start
        while k + 80 <= len(buf):
            if buf[k:k + 80] == b"END" + b" " * 77:
                return k
            k += 80
        return None

    e0 = find_end(0)
    h1 = (e0 // 2880 + 1) * 2880
    e1 = find_end(h1)
    while e1 is None:
        buf += get_range(key, len(buf), len(buf) + 14399)
        e1 = find_end(h1)
    data_off = (e1 // 2880 + 1) * 2880
    return fits.Header.fromstring(buf[h1:data_off].decode("ascii", "replace")), data_off


_WAVE_ALT = re.compile(r"^(WCSAXES|WCSNAME|CNAME\d|CRPIX\d|CDELT\d|CUNIT\d|CTYPE\d|CRVAL\d|PV\d_\d+|PS\d_\d+)W$")


def celestial_wcs(header):
    """TAN-SIP sky WCS; drops the 'W' alternate (wavelength lookup) that needs the table extension."""
    h = header.copy()
    for k in list(h.keys()):
        if _WAVE_ALT.match(k):
            del h[k]
    return WCS(h)


def read_box(key, data_off, xi, yi, half):
    """Native-pixel box of side 2*half+1 centred on integer pixel (xi, yi), 0-based. NaN outside the detector."""
    out = np.full((2 * half + 1, 2 * half + 1), np.nan, np.float32)
    ya, xa = yi - half, xi - half
    ys, ye = max(ya, 0), min(yi + half, NY - 1)
    xs, xe = max(xa, 0), min(xi + half, NX - 1)
    if ys > ye or xs > xe:
        return out
    first = data_off + (ys * NX + xs) * 4
    last = data_off + (ye * NX + xe) * 4 + 3
    raw = np.frombuffer(get_range(key, first, last), dtype=">f4")
    nrow = ye - ys + 1
    rows = np.full(nrow * NX, np.nan, np.float32)
    rows[xs:xs + raw.size] = raw
    out[ys - ya:ys - ya + nrow, xs - xa:xs - xa + (xe - xs + 1)] = rows.reshape(nrow, NX)[:, xs:xe + 1]
    return out


_wave_tables = {}


def wave_table(key, det):
    """Per-detector wavelength lookup, read from the last 5760 bytes of any file of that detector.

    Returns X, Y control points (1-based FITS pixels) and VALUES[iy, ix, (wavelength, bandwidth)] in microns.
    """
    if det not in _wave_tables:
        buf = get_range(key, suffix=5760)
        hdr = fits.Header.fromstring(buf[:2880].decode("ascii"))
        assert hdr["EXTNAME"] == "WCS-WAVE", hdr["EXTNAME"]
        nx, ny = int(hdr["TFORM1"].rstrip("J")), int(hdr["TFORM2"].rstrip("J"))
        d = buf[2880:2880 + hdr["NAXIS1"]]
        x = np.frombuffer(d[:4 * nx], ">i4").astype(float)
        y = np.frombuffer(d[4 * nx:4 * (nx + ny)], ">i4").astype(float)
        v = np.frombuffer(d[4 * (nx + ny):4 * (nx + ny) + 8 * nx * ny], ">f4").reshape(ny, nx, 2).astype(float)
        _wave_tables[det] = (x, y, v)
    return _wave_tables[det]


def wavelength_at(table, x0, y0):
    """Bilinear interpolation of (wavelength, bandwidth) in microns at 0-based pixel (x0, y0)."""
    x, y, v = table
    fx, fy = x0 + 1.0, y0 + 1.0
    ix = int(np.clip(np.searchsorted(x, fx) - 1, 0, len(x) - 2))
    iy = int(np.clip(np.searchsorted(y, fy) - 1, 0, len(y) - 2))
    tx = (fx - x[ix]) / (x[ix + 1] - x[ix])
    ty = (fy - y[iy]) / (y[iy + 1] - y[iy])
    w = v[iy, ix] * (1 - tx) * (1 - ty) + v[iy, ix + 1] * tx * (1 - ty) + v[iy + 1, ix] * (1 - tx) * ty + v[iy + 1, ix + 1] * tx * ty
    return float(w[0]), float(w[1])


def fetch_frame(frame, ra, dec, half, cache_dir):
    """Native box around (ra, dec) for one exposure, cached on disk. `img` is None if the position is off the detector."""
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, frame["key"].split("/")[-1].replace(".fits", "") + f"_{ra:.5f}_{dec:.5f}_{half}.npz")
    if os.path.exists(path):
        return np.load(path, allow_pickle=True)["rec"].item()
    hdr, data_off = read_image_header(frame["key"])
    x, y = (float(v) for v in celestial_wcs(hdr).all_world2pix(ra, dec, 0))
    rec = dict(frame, x=x, y=y, mjd_avg=float(hdr["MJD-AVG"]), psf_fwhm=float(hdr.get("PSF_FWHM", np.nan)), hdr=hdr.tostring(), img=None)
    if -half <= x < NX + half and -half <= y < NY + half:
        rec["xi"], rec["yi"] = int(round(x)), int(round(y))
        rec["img"] = read_box(frame["key"], data_off, rec["xi"], rec["yi"], half)
        rec["wave"], rec["band"] = wavelength_at(wave_table(frame["key"], frame["det"]), x, y)
    np.savez_compressed(path, rec=np.array(rec, dtype=object))
    return rec


def load_cached(cache_dir, dets=None):
    """All cached exposures that landed on the detector, time-sorted."""
    recs = []
    for name in sorted(os.listdir(cache_dir)):
        if name.endswith(".npz"):
            r = np.load(os.path.join(cache_dir, name), allow_pickle=True)["rec"].item()
            if r["img"] is not None and (dets is None or r["det"] in dets):
                recs.append(r)
    return sorted(recs, key=lambda r: r["mjd_avg"])


def split_visits(items, gap_days=40.0, key=lambda d: d["mjd_avg"]):
    """Group time-sorted exposures into visits separated by more than `gap_days`."""
    visits, cur = [], [items[0]]
    for it in items[1:]:
        if key(it) - key(cur[-1]) > gap_days:
            visits.append(cur)
            cur = [it]
        else:
            cur.append(it)
    visits.append(cur)
    return visits
