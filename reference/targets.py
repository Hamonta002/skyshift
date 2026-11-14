"""The five challenge targets: catalogue astrometry and positions at a chosen epoch.

Coordinates are SIMBAD ICRS positions at epoch J2000.0 with proper motion (mas/yr) and
parallax (mas), retrieved through the CDS Sesame resolver on 2026-11-14.
Proper motion matters: three of the five targets are arcminutes away from these coordinates today.
"""
import math

TARGETS = {
    "barnard":  dict(label="Barnard's Star",         ra=269.45207696, dec=4.69336497,   pmra=-801.551, pmdec=10362.394, plx=546.976),
    "epsindiB": dict(label="Epsilon Indi B (Ba+Bb)", ra=331.04414659, dec=-56.78284420, pmra=3981.977, pmdec=-2466.832, plx=270.658),
    "wise0855": dict(label="WISE 0855-0714",         ra=133.81890825, dec=-7.24704800,  pmra=-8123.7,  pmdec=673.2,     plx=439.0),
    "rwaur":    dict(label="RW Aurigae",             ra=76.95652603,  dec=30.40143817,  pmra=7.23,     pmdec=-20.33,    plx=15.42),
    "rdra":     dict(label="R Draconis",             ra=248.16761083, dec=66.75497942,  pmra=-20.643,  pmdec=6.149,     plx=1.2509),
}
# Position quoted in the challenge text for WISE 0855 (08h55m10.831s -07d14m42.53s). It is the
# ~2010.4 WISE-era position, not where the object is now.
WISE0855_CHALLENGE = (133.7951292, -7.2451472)
REF_EPOCH = 2026.0


def position(name, year=REF_EPOCH):
    """Linear proper-motion propagation from J2000.0 (good to well under 1 arcsec here; no parallax)."""
    t = TARGETS[name]
    dt = year - 2000.0
    ra = t["ra"] + dt * t["pmra"] / 3.6e6 / math.cos(math.radians(t["dec"]))
    dec = t["dec"] + dt * t["pmdec"] / 3.6e6
    return round(ra, 6), round(dec, 6)


def offset_arcsec(name, year=REF_EPOCH):
    """How far the target is from its J2000 catalogue position at `year`."""
    t = TARGETS[name]
    dt = year - 2000.0
    return math.hypot(dt * t["pmra"], dt * t["pmdec"]) / 1000.0


if __name__ == "__main__":
    for n, t in TARGETS.items():
        ra, dec = position(n)
        off = offset_arcsec(n)
        print(f"{t['label']:<24} J2000 ({t['ra']:.6f}, {t['dec']:+.6f})  ->  {REF_EPOCH} ({ra:.6f}, {dec:+.6f})   "
              f"moved {off:7.1f}\" = {off / 60:5.2f}' = {off / 6.15:5.1f} px")
    ra, dec = position("wise0855")
    cr, cd = WISE0855_CHALLENGE
    t = TARGETS["wise0855"]
    dx = (cr - t["ra"]) * math.cos(math.radians(cd)) * 3600
    print(f"WISE 0855 challenge coordinates are {abs(dx):.1f}\" west of the J2000 position -> epoch ~{2000 + dx * 1000 / t['pmra']:.1f}; "
          f"the object is now {abs((ra - cr) * math.cos(math.radians(cd)) * 3600):.0f}\" west of the challenge coordinates")
